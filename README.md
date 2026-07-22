# ts-docs-mcp

**An MCP server that gives AI coding agents accurate, version-aware API documentation for any npm package — straight from the source.**

> ⚡ `npx ts-docs-mcp` — works with Cursor, Claude Code, VS Code Copilot, and any MCP-compatible client.

---

## The Problem

When you ask an AI coding agent (Claude Code, Cursor, Copilot) to write code using an npm package, the model relies on its *training data* — which is often months or years out of date.

The result:

```typescript
// ❌ Model hallucinates — Express 4 syntax, but you have Express 5 installed
import bodyParser from 'body-parser';
app.use(bodyParser.json());

// ❌ Wrong API — Zod v3 pattern, but Zod v4 changed the API
const schema = z.object({ name: z.string() });
schema.parse(data); // Zod v4 requires schema.parse({...}) with options
```

Models *know about* libraries, but they don't know **which version you have installed** or **what the current API looks like**.

---

## The Solution

`ts-docs-mcp` provides documentation sourced from **the actual package source code** — not training data.

```
npm registry → GitHub raw (JSDoc) → npm tarball (.d.ts)
```

1. **Fetches the exact version** from the npm registry
2. **Reads the TypeScript source** from GitHub, including JSDoc comments
3. **Falls back to `.d.ts` files** from the npm tarball if GitHub source is a barrel
4. **Returns clean Markdown** — every exported symbol, method signature, and deprecation notice

The model gets:

```markdown
# drizzle-orm API v0.45.2
> Drizzle ORM package for SQL databases

## Functions (38) — showing 15

- **join** — Join a list of SQL chunks with a separator.
- **and** — Combine a list of conditions with the `and` operator.
- **or** — Combine a list of conditions with the `or` operator.
- **eq** — Test that two values are equal.
...
```

**No stale training data. No hallucinated APIs. No node_modules needed.**

---

## How It Works

```
┌──────────────────┐       ┌────────────────────────────────────────┐
│  AI Coding Agent │ ◄──── │          ts-docs-mcp                   │
│  (Cursor, Claude │ MCP   │   (MCP Server via stdio)               │
│   Code, etc.)    │       │                                        │
└──────────────────┘       │  get_package_docs("zod")               │
         │                  │    ↓                                  │
         │   "Here is the  │  1. npm registry → package metadata    │
         │   full Zod API  │  2. GitHub raw → JSDoc from source     │
         │   documentation"│  3. npm tarball → .d.ts (fallback)     │
         ▼                  │  4. Merge + dedup → Markdown           │
  Writes correct code       │  5. Cache by version                  │
                            └────────────────────────────────────────┘
```

### Tools

| Tool | Description |
|------|-------------|
| `get_package_docs` | Get API docs for any npm package. Optional `query` to find a specific symbol. |

### Fallback chain

```
GitHub .ts source (JSDoc)
  → if 0 symbols: GitHub .d.ts
    → if 0 symbols: npm tarball .d.ts (with re-export following)
      → merge all results, dedup by name
```

### Cache

Documentation is cached in `.llm-cache/` as JSON, keyed by `package@version`. Cache lives 24h.

---

## Usage

### Quick start

Add to your MCP configuration:

```json
{
  "mcpServers": {
    "ts-docs-mcp": {
      "command": "npx",
      "args": ["-y", "ts-docs-mcp"]
    }
  }
}
```

**Cursor**: Settings → MCP → Add Server → paste the config above.
**Claude Code**: `claude mcp add ts-docs-mcp -- npx -y ts-docs-mcp`
**VS Code / Copilot**: `.vscode/mcp.json` → add the entry.

### Requirements

- Node.js 20+
- Internet access (fetches from npm registry, GitHub, npm tarballs)
- Package must be on npm with a public GitHub repository

---

## Examples

**Get the full API overview:**

```
You → "Show me the drizzle-orm API"

Agent → calls get_package_docs("drizzle-orm")
     → gets all exported symbols grouped by kind
```

**Find a specific symbol:**

```
You → "How do I use Zod's transform method?"

Agent → calls get_package_docs("zod", query="transform")
     → gets ZodEffects.transform with signature + JSDoc
```

---

## Tested Packages

| Package | Source | Fallback | Merged |
|---------|--------|----------|--------|
| zod | 5 symbols (11 files) | 14 (tarball) | **14** |
| drizzle-orm | 9 (15 files) | 50 (tarball) | **51** |
| fastify | 1 | 51 (tarball) | **51** |
| shadcn | — | 4 (tarball) | **4** |
| express | 0 (JS-only) | — | **0** |

---

## Why not just use the README / training data?

| Source | Coverage | Version-aware | Freshness |
|--------|----------|---------------|-----------|
| **Training data** | Variable | ❌ | 6-24 months stale |
| **README** | ~20% of API | ❌ | Often stale |
| **ts-docs-mcp** | **All exports** | ✅ **Exact version** | ✅ **Real-time** |

TypeScript `.d.ts` files + GitHub source are the **canonical source of truth** — they always reflect the exact installed version.

---

## Development

```bash
git clone https://git.827482.xyz/xvantz/ts-docs-mcp.git
cd ts-docs-mcp
npm install
npm run build
npm test          # 28 unit tests
npm run test:integration  # network tests
```

### Project structure

```
src/
├── types.ts     — PackageInfo, PublicSymbol interfaces
├── cache.ts     — file-based cache
├── throttle.ts  — token-bucket rate limiter
├── registry.ts  — npm registry, GitHub source, tarball fallback
├── parser.ts    — JSDoc parser
├── format.ts    — Markdown output
└── index.ts     — MCP server (thin handler)
```

---

## License

MIT

*Built because AI coding agents deserve better than hallucinated APIs.*
