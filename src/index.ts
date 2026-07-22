#!/usr/bin/env node

/**
 * ts-docs-mcp — MCP server that provides LLMs with accurate,
 * version-aware TypeScript API documentation.
 *
 * Sources documentation directly from source code:
 *   npm registry → GitHub raw → JSDoc + signatures
 *
 * No node_modules dependency. Works in any environment.
 *
 * Tools:
 *   get_package_docs(package, query?) — API docs for any npm package
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

const CACHE_DIR = ".llm-cache";
const NPM_REGISTRY = "https://registry.npmjs.org";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/* ------------------------------------------------------------------ */
/*  HTTP helpers                                                       */
/* ------------------------------------------------------------------ */

async function fetchJSON(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { "Accept": "application/json", "User-Agent": "ts-docs-mcp/0.1" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": "ts-docs-mcp/0.1" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

/* ------------------------------------------------------------------ */
/*  npm registry → GitHub source                                       */
/* ------------------------------------------------------------------ */

interface PackageInfo {
  name: string;
  version: string;
  description: string;
  owner: string;
  repo: string;
  sourceHint: string | null;
}

async function getPackageInfo(pkg: string): Promise<PackageInfo> {
  const data = await fetchJSON(`${NPM_REGISTRY}/${encodeURIComponent(pkg)}`);
  const version = data["dist-tags"]?.latest;
  if (!version) throw new Error("No latest version found");

  const v = data.versions?.[version];
  const description = v?.description ?? data.description ?? "";

  // Parse GitHub repo
  const repo = v?.repository ?? data.repository;
  const repoStr = typeof repo === "string" ? repo : repo?.url ?? "";
  let match = repoStr.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
  if (!match) match = repoStr.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!match) throw new Error("Not a GitHub repository");

  const owner = match[1];
  const repoName = match[2];

  // Find source entry point
  let sourceHint: string | null = null;
  const exp = v?.exports?.["."];
  if (exp) {
    for (const key of Object.keys(exp)) {
      if (key.endsWith("/source") || key === "source") {
        sourceHint = exp[key];
        break;
      }
    }
  }
  if (!sourceHint && v?.source) sourceHint = v.source;

  return { name: v?.name ?? pkg, version, description, owner, repo: repoName, sourceHint };
}

/** Try multiple source URL patterns and return the first that resolves. */
async function fetchSourceFile(
  owner: string, repo: string, ref: string, hint: string | null,
  pkgName: string
): Promise<{ content: string; path: string } | null> {
  const pkgDir = pkgName.replace(/^@/, "").replace(/\//, "-");

  const paths: string[] = [];
  if (hint) {
    const cleanHint = hint.replace(/^\.\//, "");
    paths.push(cleanHint); // as-is
    paths.push(`packages/${repo}/${cleanHint}`); // monorepo: packages/repo/
    paths.push(`packages/${pkgDir}/${cleanHint}`); // monorepo: packages/name/
    paths.push(`lib/${cleanHint}`); // lib/ prefix
  }
  paths.push(
    "src/index.ts", "lib/index.ts",
    "lib/index.js", "lib/express.js", "lib/main.js",
    "src/index.js", "src/main.js",
    "index.ts", "index.js", "express.js",
    `packages/${repo}/src/index.ts`,
    `packages/${pkgDir}/src/index.ts`,
    `packages/${repo}/lib/index.ts`,
    `packages/${repo}/lib/index.js`,
    `${repo}/src/index.ts`,
    `${pkgDir}/src/index.ts`,
    `${repo}/src/index.js`,
    `${pkgDir}/src/index.js`,
    "packages/core/src/index.ts",
  );

  // Try tag refs first, then fallback to default branch
  const refs = ref.startsWith("v") ? [ref, ref.slice(1)] : [`v${ref}`, ref];
  const branches = ["main", "master"];
  for (const r of [...refs, ...branches]) {
    for (const p of paths) {
      const url = `https://raw.githubusercontent.com/${owner}/${repo}/${r}/${p}`;
      try {
        const content = await fetchText(url);
        // GitHub raw returns 200 with "404: Not Found" body for missing files
        if (content.length > 50 && !content.startsWith("404")) {
          return { content, path: p };
        }
      } catch {}
    }
  }
  return null;
}

/** Follow re-exports in a TS source file to find the actual declarations. */
async function resolveSource(
  owner: string, repo: string, ref: string, startPath: string, visited = new Set<string>()
): Promise<string[]> {
  const files: string[] = [startPath];

  // Resolve re-exports up to 2 levels deep
  const resolveLevel = async (path: string, depth: number): Promise<void> => {
    if (depth > 2 || files.length >= 15) return;
    const content = await fetchSourceContent(owner, repo, ref, path);
    if (!content) return;

    const reExportRegex = /export\s+(?:\*|{[^}]+})\s+from\s+["']([^"']+)["']/g;
    let match;
    let count = 0;
    while ((match = reExportRegex.exec(content)) !== null) {
      count++;
      if (files.length >= 15) break;
      const importPath = match[1];
      const normalized = importPath.replace(/\.js$/, ".ts").replace(/\.ts$/, "");
      const baseDir = dirname(path);
      const resolved = join(baseDir, `${normalized}.ts`).replace(/^\.\//, "");

      if (visited.has(resolved)) continue;
      visited.add(resolved);

      try {
        const content = await fetchSourceContent(owner, repo, ref, resolved);
        if (content) {
          files.push(resolved);
          await resolveLevel(resolved, depth + 1);
        }
      } catch {
      }
    }
    if (count === 0) return;
  };

  await resolveLevel(startPath, 1);

  return files;
}

async function fetchSourceContent(
  owner: string, repo: string, ref: string, path: string
): Promise<string | null> {
  const refs = ref.startsWith("v") ? [ref, ref.slice(1)] : [`v${ref}`, ref];
  for (const r of refs) {
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/${r}/${path}`;
    try {
      const text = await fetchText(url);
      return text;
    } catch {}
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  JSDoc parser                                                       */
/* ------------------------------------------------------------------ */

interface PublicSymbol {
  name: string;
  kind: "class" | "interface" | "function" | "type" | "variable" | "enum";
  jsdoc: string;
  signature: string;
  deprecation?: string;
  methods?: { name: string; jsdoc: string; signature: string; deprecation?: string }[];
}

/** Parse JSDoc + declarations from TypeScript source code. */
function parsePublicAPI(source: string): PublicSymbol[] {
  const symbols: PublicSymbol[] = [];
  const lines = source.split("\n");

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();

    // Detect JSDoc comment
    if (line.startsWith("/**")) {
      const jsdocStart = i;
      let jsdocLines: string[] = [];
      while (i < lines.length && !lines[i].trim().startsWith("*/")) {
        jsdocLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        jsdocLines.push(lines[i]); // include */
        i++;
      }

      // Collect the declaration (until { or ; or next comment)
      let declLines: string[] = [];
      while (i < lines.length) {
        const dl = lines[i].trim();
        if (dl === "" || dl.startsWith("//")) { i++; continue; }
        declLines.push(lines[i]);
        if (dl === "{" || dl.endsWith("{") || dl.endsWith(";") ||
            dl.startsWith("/**") || dl.startsWith("*/")) {
          break;
        }
        i++;
      }

      const decl = declLines.join("\n").trim();
      const jsdoc = parseJSDoc(jsdocLines);
      const deprecation = extractDeprecation(jsdocLines);

      // Match: export class|interface|function|enum|type|const Name
      // Also match plain: function Name (CommonJS)
      const classMatch = decl.match(/(?:export\s+)?(?:default\s+)?class\s+(\w+)/);
      const ifaceMatch = decl.match(/(?:export\s+)?(?:default\s+)?interface\s+(\w+)/);
      const funcMatch = decl.match(/(?:export\s+)?(?:default\s+)?function\s+(\w+)/);
      const typeMatch = decl.match(/(?:export\s+)?type\s+(\w+)/);
      const constMatch = decl.match(/(?:export\s+)?(?:const|let|var)\s+(\w+)/);
      const enumMatch = decl.match(/(?:export\s+)?(?:default\s+)?enum\s+(\w+)/);
      // Plain function for CommonJS: function name(...)
      const plainFuncMatch = decl.match(/^(?:async\s+)?function\s+(\w+)/);

      if (classMatch) {
        symbols.push({
          name: classMatch[1], kind: "class", jsdoc, signature: decl,
          deprecation,
          methods: parseMethods(source, classMatch[1]),
        });
      } else if (ifaceMatch) {
        symbols.push({
          name: ifaceMatch[1], kind: "interface", jsdoc, signature: decl,
          deprecation,
          methods: parseMethods(source, ifaceMatch[1]),
        });
      } else if (funcMatch || plainFuncMatch) {
        const name = funcMatch?.[1] ?? plainFuncMatch![1];
        symbols.push({
          name, kind: "function", jsdoc, signature: decl,
          deprecation,
        });
      } else if (enumMatch) {
        symbols.push({
          name: enumMatch[1], kind: "enum", jsdoc, signature: decl,
          deprecation,
        });
      } else if (typeMatch) {
        symbols.push({
          name: typeMatch[1], kind: "type", jsdoc, signature: decl,
          deprecation,
        });
      } else if (constMatch) {
        symbols.push({
          name: constMatch[1], kind: "variable", jsdoc, signature: decl,
          deprecation,
        });
      }
    } else {
      i++;
    }
  }

  return symbols;
}

function parseJSDoc(jsdocLines: string[]): string {
  return jsdocLines
    .map(l => l.replace(/^\s*\*\s?/, "").replace(/^\s*\/\*\*?\s?/, "").replace(/\s*\*\/$/, ""))
    .filter(l => l.trim() && !l.trim().startsWith("@"))
    .join(" ")
    .trim();
}

function extractDeprecation(jsdocLines: string[]): string | undefined {
  for (const l of jsdocLines) {
    const trimmed = l.trim();
    if (trimmed.includes("@deprecated")) {
      return trimmed.replace(/^\s*\*\s*@deprecated\s*/, "").trim();
    }
  }
  return undefined;
}

/** Find methods on a class/interface by scanning its body. */
function parseMethods(source: string, className: string): { name: string; jsdoc: string; signature: string; deprecation?: string }[] {
  const methods: { name: string; jsdoc: string; signature: string; deprecation?: string }[] = [];
  const lines = source.split("\n");

  // Find the class/interface body
  let inBody = false;
  let braceDepth = 0;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();
    if (line.includes(`class ${className}`) || line.includes(`interface ${className}`) ||
        line.includes(`${className}: core.$constructor`)) {
      inBody = true;
      braceDepth = 0;
      i++;
      continue;
    }

    if (inBody) {
      if (line.includes("{") || line.endsWith("{")) braceDepth++;
      if (line.includes("}") || line.startsWith("}")) {
        braceDepth--;
        if (braceDepth < 0) break;
        i++;
        continue;
      }

      if (braceDepth > 0 && (line.startsWith("/**") || line.startsWith("//"))) {
        // Method with JSDoc
        let jsdocLines: string[] = [];
        let j = i;
        if (line.startsWith("/**")) {
          while (j < lines.length && !lines[j].trim().startsWith("*/")) {
            jsdocLines.push(lines[j]);
            j++;
          }
          if (j < lines.length) { jsdocLines.push(lines[j]); j++; }
        } else {
          jsdocLines = [line];
          j++;
        }

        // Read method name
        let declLines: string[] = [];
        while (j < Math.min(j + 10, lines.length)) {
          const dl = lines[j].trim();
          declLines.push(lines[j]);
          if (dl === "{" || dl.endsWith("{")) break;
          j++;
        }

        const decl = declLines.join("\n").trim();
        const methodMatch = decl.match(/(?:(\w+)\s*[=:]\s*(?:\([^)]*\)\s*=>|[^;]+)|(\w+)\s*\([^)]*\))/);
        const methodName = methodMatch?.[1] ?? methodMatch?.[2];
        if (methodName && !methodName.startsWith("_") && methodName !== "constructor") {
          const jsdoc = parseJSDoc(jsdocLines);
          const deprecation = extractDeprecation(jsdocLines);
          methods.push({ name: methodName, jsdoc, signature: decl, deprecation });
        }

        i = j;
        continue;
      }

      // Method without JSDoc — simple name detection
      const methodMatch = line.match(/^\s*(\w+)\s*(?:\(|[:=])/);
      if (methodMatch && !methodMatch[1].startsWith("_") && methodMatch[1] !== "constructor") {
        const name = methodMatch[1];
        const existing = methods.find(m => m.name === name);
        if (!existing && methods.length < 30) {
          methods.push({ name, jsdoc: "", signature: line, deprecation: undefined });
        }
      }
    }

    i++;
  }

  return methods;
}

/* ------------------------------------------------------------------ */
/*  Markdown formatting                                                */
/* ------------------------------------------------------------------ */

function toSummary(symbols: PublicSymbol[], pkgName: string, version: string, description: string): string {
  const lines: string[] = [];
  lines.push(`# ${pkgName} API v${version}`);
  if (description) lines.push(`> ${description}`);
  lines.push("");

  // Group by kind
  const groups: Record<string, PublicSymbol[]> = {};
  for (const s of symbols) {
    if (!groups[s.kind]) groups[s.kind] = [];
    if (groups[s.kind].length < 15) groups[s.kind].push(s);
  }

  const order = ["class", "interface", "function", "enum", "type", "variable"];
  for (const kind of order) {
    const items = groups[kind];
    if (!items?.length) continue;
    const plural = kind === "class" ? "Classes" : kind === "interface" ? "Interfaces" : kind === "function" ? "Functions" : kind === "type" ? "Type Aliases" : kind === "variable" ? "Variables" : `${kind}s`;
    lines.push(`## ${plural}\n`);

    for (const item of items) {
      // Show deprecation badge
      if (item.deprecation) {
        lines.push(`- ⚠️ **${item.name}** — *Deprecated:* ${item.deprecation.replace(/\s*@deprecated\s*/g, "").slice(0, 120)}`);
        continue;
      }

      // Show JSDoc description
      if (item.jsdoc) {
        lines.push(`- **${item.name}**`);
        lines.push(`  ${item.jsdoc.replace(/\n/g, " ").slice(0, 200)}`);
        continue;
      }

      // Fallback: just the name
      lines.push(`- \`${item.name}\``);
    }
    lines.push("");
  }

  const shown = Object.values(groups).flat().length;
  if (shown < symbols.length) {
    lines.push(`*Showing ${shown} of ${symbols.length} symbols. Use \`query\` to find a specific symbol.*`);
  }

  return lines.join("\n");
}

function formatSymbolDetail(item: PublicSymbol): string {
  const lines: string[] = [];
  lines.push(`## ${item.name} (${item.kind})`);
  if (item.deprecation) lines.push(`> ⚠️ *Deprecated:* ${item.deprecation}`);
  if (item.jsdoc) lines.push(`> ${item.jsdoc}`);
  lines.push("");
  lines.push(`\`\`\`typescript\n${item.signature}\n\`\`\``);
  lines.push("");

  if (item.methods && item.methods.length > 0) {
    const withJSDoc = item.methods.filter(m => m.jsdoc);
    lines.push("### Methods\n");
    for (const m of (withJSDoc.length > 0 ? withJSDoc : item.methods).slice(0, 25)) {
      if (m.jsdoc) {
        if (m.deprecation) lines.push(`> ⚠️ *Deprecated:* ${m.deprecation}`);
        lines.push(`> ${m.jsdoc}`);
      }
      lines.push(`- \`${m.signature.replace(/\n/g, " ").replace(/  +/g, " ").slice(0, 150)}\``);
    }
    if (item.methods.length > 25) {
      lines.push(`\n*… ${item.methods.length - 25} more methods*`);
    }
  }

  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/*  Cache                                                              */
/* ------------------------------------------------------------------ */

function cacheKey(pkg: string, version: string): string {
  return `${pkg}@${version}`.replace(/\//g, "_");
}

function cachePath(key: string): string {
  return join(CACHE_DIR, `${key}.json`);
}

function readCache(pkg: string, version: string): string | null {
  const p = cachePath(cacheKey(pkg, version));
  if (!existsSync(p)) return null;
  const age = Date.now() - readFileSync(p, "utf-8").length; // rough check
  return readFileSync(p, "utf-8");
}

function writeCache(pkg: string, version: string, data: string): void {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cachePath(cacheKey(pkg, version)), data, "utf-8");
}

/* ------------------------------------------------------------------ */
/*  MCP Server                                                         */
/* ------------------------------------------------------------------ */

const server = new Server(
  { name: "ts-docs-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_package_docs",
      description: [
        "Get accurate API documentation for any npm package.",
        "Documentation is sourced from the package's TypeScript source code on GitHub,",
        "including JSDoc comments, method signatures, deprecation notices, and examples.",
        "No local node_modules needed — works anywhere.",
        "Optionally pass a 'query' to find a specific symbol.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          package: {
            type: "string",
            description: "npm package name, e.g. 'zod', 'express', '@prisma/client'",
          },
          query: {
            type: "string",
            description:
              "Optional — find a specific symbol (class, function, interface) within the package. When omitted returns the full public API overview.",
          },
        },
        required: ["package"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "get_package_docs": {
      const pkg = String(args?.package ?? "");
      const query = args?.query ? String(args.query) : undefined;

      if (!pkg) {
        return { content: [{ type: "text", text: "Error: 'package' is required." }], isError: true };
      }

      try {
        // 1. Get package info from npm registry
        const info = await getPackageInfo(pkg);

        // 2. Check cache
        const cached = readCache(info.name, info.version);
        if (cached) {
          const data = JSON.parse(cached);
          if (query) {
            const found = data.symbols?.filter((s: PublicSymbol) =>
              s.name.toLowerCase().includes(query.toLowerCase())
            );
            if (found?.length) {
              return { content: [{ type: "text", text: found.map(formatSymbolDetail).join("\n\n---\n\n") }] };
            }
            return { content: [{ type: "text", text: `Symbol "${query}" not found.` }] };
          }
          return { content: [{ type: "text", text: toSummary(data.symbols, info.name, info.version, info.description) }] };
        }

        // 3. Fetch source from GitHub
        const file = await fetchSourceFile(info.owner, info.repo, info.version, info.sourceHint, info.name);
        if (!file) {
          return {
            content: [{
              type: "text",
              text: `Could not fetch source for "${pkg}" v${info.version} from GitHub. The package may not have a public GitHub repository with source code.`,
            }],
            isError: true,
          };
        }

        // 4. Resolve additional files (follow re-exports)
        const allFiles = await resolveSource(info.owner, info.repo, info.version, file.path, new Set());

        // 5. Parse all source files
        let allSource = file.content;
        for (const f of allFiles.slice(1)) {
          const content = await fetchSourceContent(info.owner, info.repo, info.version, f);
          if (content) allSource += "\n\n" + content;
        }

        const symbols = parsePublicAPI(allSource);

        // 6. Cache
        writeCache(info.name, info.version, JSON.stringify({ symbols, fetchedAt: Date.now() }));

        // 7. Respond
        if (query) {
          const found = symbols.filter(s => s.name.toLowerCase().includes(query.toLowerCase()));
          if (found?.length) {
            return { content: [{ type: "text", text: found.map(formatSymbolDetail).join("\n\n---\n\n") }] };
          }
          return { content: [{ type: "text", text: `Symbol "${query}" not found.` }] };
        }

        return { content: [{ type: "text", text: toSummary(symbols, info.name, info.version, info.description) }] };

      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }

    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
});

/* ------------------------------------------------------------------ */
/*  Bootstrap                                                          */
/* ------------------------------------------------------------------ */

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("ts-docs-mcp server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
