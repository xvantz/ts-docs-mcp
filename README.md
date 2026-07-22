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

Models *know about* libraries, but they don't know **which version you have installed** or **what the current API looks like**. README files are incomplete. Documentation sites get stale. And hallucinations waste your time.

---

## The Solution

`ts-docs-mcp` works differently. Instead of guessing, it:

1. **Resolves the exact package from your `node_modules`** — reads `package.json` to get the installed version and finds its TypeScript definition (`.d.ts`) entrypoint.
2. **Generates full API documentation via TypeDoc** — not just a README, but every exported symbol, every method signature, every type, with JSDoc comments preserved.
3. **Caches by version** — the next time you or the model asks, response is instant. When you update the package, cache invalidates automatically.

The model gets:

```markdown
# express API
> Version: 5.1.2

## Router (Class)
The Router class provides routing capabilities...

### Methods
#### router.get(path: string, ...handlers: RequestHandler[]): Router
Register a GET route handler. All handlers are async by default.

#### router.post(path: string, ...handlers: RequestHandler[]): Router
Register a POST route handler.

## json (Function)
`json(options?: BodyParserOptions): RequestHandler`
Built-in JSON body parser. Do NOT install body-parser separately.
```

**No more hallucinations. No more stale APIs.**

---

## How It Works

```
┌──────────────────┐       ┌──────────────────────────────┐
│  AI Coding Agent │ ◄──── │        ts-docs-mcp            │
│  (Cursor, Claude │ MCP   │  (MCP Server via stdio)       │
│   Code, etc.)    │       │                              │
└──────────────────┘       │  get_package_docs("zod")      │
         │                  │    ↓                         │
         │   "Here is the  │  resolve node_modules/zod     │
         │   full Zod API  │    → read .d.ts               │
         │   documentation"│    → TypeDoc → Markdown       │
         ▼                  │    → cache                   │
  Writes correct code       └──────────────────────────────┘
```

### Tools

| Tool | Description |
|------|-------------|
| `get_package_docs` | Get full API docs for any npm package. Optional `query` to search for a specific symbol. |
| `list_available_packages` | List all packages in `node_modules` that have TypeScript types. |

### Cache

Generated documentation is cached in `.llm-cache/<package>@<version>.md` relative to the working directory. The cache is **version-keyed** — when you `npm update` a package, the next request re-generates docs for the new version. Old cache entries are harmless and eventually prunable.

---

## Installation

### Quick start (Cursor, Claude Code, VS Code Copilot)

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

Cursor: Settings → MCP → Add Server → paste the config above.
Claude Code: `claude mcp add ts-docs-mcp -- npx -y ts-docs-mcp`
VS Code / Copilot: `.vscode/mcp.json` → add the entry.

### Requirements

- Node.js 20+
- npm package must have TypeScript types (`.d.ts` files) — ~95% of top npm packages do.

---

## Examples

**Get the full Express 5 API:**

```
You → "What's the Express API documentation?"

Model → (calls get_package_docs with package="express")
     → "Express 5.x — here's the complete API..."
```

**Find a specific symbol:**

```
You → "Show me how to use Zod's transform method"

Model → (calls get_package_docs with package="zod", query="transform")
     → (gets the exact section for ZodEffects.transform with signature + JSDoc)
```

**Before writing any code with an unfamiliar package:**

```
You → "Generate a Prisma schema and CRUD service"

Agent → (calls get_package_docs for @prisma/client to check current API)
     → (calls get_package_docs for zod to check validation API)
     → (writes code using the correct, version-aware API)
```

---

## Why not just use the README?

| Source | Coverage | Always up-to-date? | Version-aware? |
|--------|----------|-------------------|----------------|
| **README** | ~20% of API | ❌ Often stale | ❌ |
| **Docs website** | ~80% | Typcially yes | ❌ Tends to show latest |
| **TypeDoc from `.d.ts`** | **100% of exports** | ✅ Same as package | ✅ Reads from `node_modules` |
| **Training data** | Variable | ❌ 6-24 months old | ❌ |

TypeScript `.d.ts` files are the **canonical source of truth** for any typed npm package. They are published alongside the code, always reflect the exact installed version, and include JSDoc comments with parameter descriptions and usage notes.

---

## Development

```bash
git clone https://git.827482.xyz/xvantz/ts-docs-mcp.git
cd ts-docs-mcp
npm install
npm run build
npm start
```

To test with the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

---

## Roadmap

- [ ] Pre-index mode: scan all deps on startup for instant response
- [ ] Support for packages without `.d.ts` (fallback to npm registry README)
- [ ] Configurable cache location and TTL
- [ ] Telemetry-free analytics (how many cache hits/misses)

---

## License

MIT

---

*Built because AI coding agents deserve better than hallucinated APIs.*
