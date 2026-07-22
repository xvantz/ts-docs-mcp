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

The pipeline:

```
npm registry → GitHub .ts (JSDoc) → npm tarball (.d.ts) → DefinitelyTyped (@types/)
```

1. **Resolves the exact version** from the npm registry
2. **Reads TypeScript source** from GitHub, including JSDoc, `@param`, `@returns`
3. **Follows re-exports** to find actual declarations (BFS, parallel fetches)
4. **Falls back to `.d.ts`** from the npm tarball if GitHub source is insufficient
5. **Falls back to DefinitelyTyped** for JS-only packages (express, etc.)
6. **Returns clean Markdown** — full signatures, parameters, deprecation notices, examples

### Before vs After

| Package | Before (v0.1.0) | After (v0.4.1) |
|---------|:-:|:-:|
| **zod** | 31 symbols | **577** |
| **axios** | 0 | **83** |
| **uuid** | 0 | **23** |
| **chalk** | 19 | **32** |
| **fastify** | 51 | **~100+** |
| **express** | 0 | **13** (via @types/express) |

---

## How It Works

```
┌──────────────────┐       ┌──────────────────────────────────────────────┐
│  AI Coding Agent │ ◄──── │          ts-docs-mcp                         │
│  (Cursor, Claude │ MCP   │   (MCP Server via stdio)                     │
│   Code, etc.)    │       │                                              │
└──────────────────┘       │  get_package_docs("zod")                     │
         │                  │    ↓                                        │
         │   "Here is the  │  1. npm registry → package metadata          │
         │   full API      │  2. GitHub raw → JSDoc from .ts source       │
         │   documentation"│  3. BFS re-export resolution (parallel)      │
         ▼                  │  4. npm tarball → .d.ts parsing (no JSDoc?) │
  Writes correct code       │  5. @types/{name} fallback (JS-only)        │
                            │  6. Merge + dedup → Markdown                │
                            │  7. XDG cache (24h TTL)                     │
                            └──────────────────────────────────────────────┘
```

### Tools

| Tool | Description |
|------|-------------|
| `get_package_docs` | Get API docs for any npm package. Optional `query` to find a specific symbol. |

### Fallback chain

```
GitHub .ts (JSDoc + declarations)
  → BFS re-export resolution (depth=2, concurrency=5)
    → merge: GitHub .d.ts (from tarball, with re-export following)
      → if 0 symbols: DefinitelyTyped (@types/{name})
        → merge all results, dedup by name (GitHub takes priority)
```

### What the model gets

```markdown
## findByEmail (function)
> Find a user by their email address.
> @param email — The email to search for
> @returns The user object or null

```typescript
export function findByEmail(email: string, includeDeleted?: boolean): User | null;
```

**Parameters:**

- `email — The email to search for`
- `includeDeleted — Whether to include deleted users`

**Returns:** `The user object or null`
```

Full signatures, no truncation. `@param`, `@returns`, `@deprecated`, `@example` are preserved.

### Cache

Documentation is cached in `~/.cache/ts-docs-mcp/` (XDG-compatible), keyed by `package@version`. TTL is 24 hours. Old entries are cleaned up after 7 days.

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
- Package must be on npm with a public GitHub repository (or have @types/ types)

---

## Examples

**Get the full API overview:**

```
You → "Show me the axios API"
Agent → calls get_package_docs("axios")
     → gets 83 symbols: types, interfaces, classes, functions
```

**Find a specific symbol:**

```
You → "How do I use Zod's transform method?"
Agent → calls get_package_docs("zod", query="transform")
     → gets ZodEffects.transform with full signature + JSDoc
```

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
npm test          # 43 unit tests (5 test files)
npm run test:integration  # network tests (skipped in CI)
```

### Project structure

```
src/
├── registry.ts   — npm package metadata + HTTP helpers
├── github.ts     — GitHub raw source fetching (BFS, parallel)
├── tarball.ts    — .d.ts extraction from tarball + DefinitelyTyped
├── parser.ts     — Two-phase JSDoc + declaration parser
├── format.ts     — Markdown output (summary + detail)
├── throttle.ts   — Per-endpoint token-bucket rate limiter
├── cache.ts      — XDG file cache with 24h TTL
├── types.ts      — PublicSymbol, PackageInfo interfaces
└── index.ts      — MCP server (thin handler)
```

---

## License

MIT

*Built because AI coding agents deserve better than hallucinated APIs.*
