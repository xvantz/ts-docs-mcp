#!/usr/bin/env node

/**
 * ts-docs-mcp
 * MCP server that provides LLMs with accurate TypeScript API documentation
 * directly from node_modules — resolving .d.ts files and generating
 * structured Markdown via TypeDoc.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execSync } from "child_process";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join, dirname, basename } from "path";
import { createRequire } from "module";
import { z } from "zod";

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

const CACHE_DIR = ".llm-cache";
const TYPEDOC_TIMEOUT = 60_000; // 60s for large packages

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Resolve the .d.ts entrypoint for a package, or null. */
function resolveTypesPath(pkg: string): string | null {
  try {
    const req = createRequire(import.meta.url);
    const pkgJsonPath = req.resolve(`${pkg}/package.json`);
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));

    // Prefer types → typings → guess from main
    const typesField: string | undefined =
      pkgJson.types ?? pkgJson.typings ?? guessTypesFromMain(pkgJson.main);

    if (!typesField) return null;

    return req.resolve(`${pkg}/${typesField}`);
  } catch {
    return null;
  }
}

function guessTypesFromMain(main?: string): string | undefined {
  if (!main) return undefined;
  return main.replace(/\.(js|mjs|cjs)$/, ".d.ts");
}

/** Read the installed version of a package. */
function getPackageVersion(pkg: string): string | null {
  try {
    const req = createRequire(import.meta.url);
    const pkgJsonPath = req.resolve(`${pkg}/package.json`);
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
    return pkgJson.version ?? null;
  } catch {
    return null;
  }
}

/** Cache key: pkg@version */
function cacheKey(pkg: string, version: string): string {
  return `${pkg}@${version}`.replace(/\//g, "_");
}

function cachePath(key: string): string {
  return join(CACHE_DIR, `${key}.md`);
}

function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
}

/* ------------------------------------------------------------------ */
/*  TypeDoc → Markdown converter                                       */
/* ------------------------------------------------------------------ */

interface TypedocReflection {
  id: number;
  name: string;
  kind: number;
  kindString?: string;
  comment?: { shortText?: string; text?: string };
  type?: unknown;
  signatures?: TypedocReflection[];
  children?: TypedocReflection[];
  parameters?: TypedocReflection[];
  flags?: { isExported?: boolean; isOptional?: boolean };
  sources?: { fileName: string; line: number }[];
}

/**
 * Run typedoc --json on a .d.ts entrypoint, parse the output,
 * and produce a concise Markdown document optimised for LLM consumption.
 */
function generateDocsMarkdown(pkg: string): string {
  const typesPath = resolveTypesPath(pkg);
  if (!typesPath) {
    return `> No TypeScript types found for \`${pkg}\`.\n`;
  }

  // We pipe JSON to stdout instead of writing a temp file.
  // typedoc's --json accepts a file path; we'll write to a temp dir.
  const tmpDir = join(CACHE_DIR, `.tmp-${pkg}-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  const jsonOut = join(tmpDir, "docs.json");

  try {
    execSync(
      `npx typedoc --json "${jsonOut}" --entryPointStrategy expand "${typesPath}"`,
      {
        stdio: "pipe",
        timeout: TYPEDOC_TIMEOUT,
        env: { ...process.env, FORCE_COLOR: "0" },
      }
    );
  } catch (err: any) {
    // typedoc may exit non-zero for warnings; still try to read output
    if (!existsSync(jsonOut)) {
      return `> TypeDoc failed for \`${pkg}\`: ${err.message ?? err}\n`;
    }
  }

  const raw = JSON.parse(readFileSync(jsonOut, "utf-8"));
  const lines: string[] = [];

  lines.push(`# ${raw.name ?? pkg} API`);
  if (raw.packageVersion) {
    lines.push(`> Version: ${raw.packageVersion}\n`);
  }

  if (raw.children) {
    for (const child of raw.children) {
      renderReflection(child, lines, 2);
    }
  }

  // Cleanup
  try {
    execSync(`rm -rf "${tmpDir}"`);
  } catch {
    // ignore cleanup errors
  }

  return lines.join("\n");
}

/** Render a single TypeDoc reflection to Markdown lines. */
function renderReflection(
  ref: TypedocReflection,
  lines: string[],
  headingLevel: number
): void {
  const heading = "#".repeat(headingLevel);
  const kind = ref.kindString ? `*(${ref.kindString})*` : "";

  lines.push(`${heading} ${ref.name} ${kind}`);

  // JSDoc / comment
  const comment = ref.comment;
  if (comment?.shortText) {
    lines.push("");
    lines.push(comment.shortText);
  }
  if (comment?.text) {
    lines.push("");
    lines.push(comment.text);
  }

  // Signature (for functions / methods)
  if (ref.signatures && ref.signatures.length > 0) {
    for (const sig of ref.signatures) {
      const sigComment = sig.comment;
      if (sigComment?.shortText) {
        lines.push("");
        lines.push(`> _${sigComment.shortText}_`);
      }

      const params =
        sig.parameters
          ?.map(
            (p) =>
              `${p.name}${p.flags?.isOptional ? "?" : ""}: ${stringifyType(p.type)}`
          )
          .join(", ") ?? "";

      const returnType = sig.type ? stringifyType(sig.type) : "void";
      lines.push("");
      lines.push(`\`${ref.name}(${params}): ${returnType}\``);
    }
  }

  // Type alias
  if (ref.kind === 4194304 && ref.type) {
    lines.push("");
    lines.push(`\`type ${ref.name} = ${stringifyType(ref.type)}\``);
  }

  // Children (nested members)
  if (ref.children && ref.children.length > 0 && headingLevel < 4) {
    for (const child of ref.children) {
      renderReflection(child, lines, headingLevel + 1);
    }
  }

  lines.push(""); // spacing
}

/** Pretty-print a TypeDoc type object. */
function stringifyType(type: any): string {
  if (!type) return "unknown";

  switch (type.type) {
    case "intrinsic":
      return type.name ?? "unknown";

    case "reference": {
      const args =
        type.typeArguments
          ?.map((a: any) => stringifyType(a))
          .join(", ") ?? "";
      return args
        ? `${type.name}<${args}>`
        : (type.name ?? "unknown");
    }

    case "array":
      return `${stringifyType(type.elementType)}[]`;

    case "union":
      return type.types
        ? type.types.map((t: any) => stringifyType(t)).join(" | ")
        : "unknown";

    case "intersection":
      return type.types
        ? type.types.map((t: any) => stringifyType(t)).join(" & ")
        : "unknown";

    case "literal":
      return type.value !== undefined
        ? JSON.stringify(type.value)
        : "unknown";

    case "reflection":
      return "{ … }";

    case "tuple":
      return `[${type.elements?.map((e: any) => stringifyType(e)).join(", ") ?? ""}]`;

    case "conditional":
      return `${stringifyType(type.checkType)} extends ${stringifyType(type.extendsType)} ? ${stringifyType(type.trueType)} : ${stringifyType(type.falseType)}`;

    case "indexedAccess":
      return `${stringifyType(type.indexType)}[${stringifyType(type.objectType)}]`;

    case "query":
      return `typeof ${stringifyType(type.queryType)}`;

    default:
      return type.name ?? type.type ?? "unknown";
  }
}

/* ------------------------------------------------------------------ */
/*  Cache                                                              */
/* ------------------------------------------------------------------ */

function readFromCache(pkg: string, version: string): string | null {
  const path = cachePath(cacheKey(pkg, version));
  return existsSync(path) ? readFileSync(path, "utf-8") : null;
}

function writeToCache(pkg: string, version: string, content: string): void {
  ensureCacheDir();
  writeFileSync(cachePath(cacheKey(pkg, version)), content, "utf-8");
}

/* ------------------------------------------------------------------ */
/*  Search within cached docs                                          */
/* ------------------------------------------------------------------ */

/** Crude section-based search in a Markdown document. */
function findSymbolInDocs(docs: string, query: string): string {
  const lines = docs.split("\n");
  const resultLines: string[] = [];
  let inSection = false;
  let sectionDepth = 0;

  for (const line of lines) {
    const isHeading = /^#{1,4}\s/.test(line);

    if (isHeading) {
      const depth = line.match(/^#+/)![0].length;
      if (
        line.toLowerCase().includes(query.toLowerCase()) &&
        depth <= 3
      ) {
        // Start a new hit section at this heading
        resultLines.push("\n" + line);
        sectionDepth = depth;
        inSection = true;
        continue;
      }

      // Close section when we hit a heading of same or higher level
      if (inSection && depth <= sectionDepth) {
        inSection = false;
      }
    }

    if (inSection) {
      resultLines.push(line);
    }
  }

  // If nothing found, return a relevant excerpt
  return resultLines.length > 0
    ? resultLines.join("\n")
    : extractExcerpt(docs, query);
}

function extractExcerpt(docs: string, query: string): string {
  const lines = docs.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(query.toLowerCase())) {
      const start = Math.max(0, i - 3);
      const end = Math.min(lines.length, i + 10);
      return lines.slice(start, end).join("\n");
    }
  }
  return docs.slice(0, 2000); // fallback
}

/* ------------------------------------------------------------------ */
/*  MCP Server                                                         */
/* ------------------------------------------------------------------ */

const server = new Server(
  {
    name: "ts-docs-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_package_docs",
      description: [
        "Get the full API documentation for an npm package as Markdown.",
        "Documentation is generated from the package's TypeScript definition files",
        "(.d.ts) using TypeDoc, so it is always accurate and version-aware.",
        "Results are cached by package version so subsequent calls are instant.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          package: {
            type: "string",
            description: "npm package name (e.g. 'zod', 'express', '@prisma/client')",
          },
          query: {
            type: "string",
            description:
              "Optional search term to find a specific symbol (class, function, type) within the docs. When omitted the full document is returned.",
          },
        },
        required: ["package"],
      },
    },
    {
      name: "list_available_packages",
      description: [
        "List npm packages available in the current project's node_modules",
        "that have TypeScript type definitions (.d.ts) and can be queried.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    /* ---- get_package_docs ---- */
    case "get_package_docs": {
      const pkg = String(args?.package ?? "");
      const query = args?.query ? String(args.query) : undefined;

      if (!pkg) {
        return {
          content: [{ type: "text", text: "Error: 'package' is required." }],
          isError: true,
        };
      }

      // 1. Resolve version
      const version = getPackageVersion(pkg);
      if (!version) {
        return {
          content: [
            {
              type: "text",
              text: `Package "${pkg}" not found in node_modules. Is it installed?`,
            },
          ],
          isError: true,
        };
      }

      // 2. Check cache
      let docs = readFromCache(pkg, version);

      // 3. Cache miss — generate
      if (!docs) {
        docs = generateDocsMarkdown(pkg);
        writeToCache(pkg, version, docs);
      }

      // 4. If query, search
      const result = query ? findSymbolInDocs(docs, query) : docs;

      return {
        content: [{ type: "text", text: result }],
      };
    }

    /* ---- list_available_packages ---- */
    case "list_available_packages": {
      // Scan top-level node_modules for packages with .d.ts
      const nodeModules = join(process.cwd(), "node_modules");
      if (!existsSync(nodeModules)) {
        return {
          content: [
            {
              type: "text",
              text: "No node_modules found in current directory.",
            },
          ],
          isError: true,
        };
      }

      const entries: string[] = [];
      const dirs = execSync(`ls -1 "${nodeModules}"`, { encoding: "utf-8" })
        .trim()
        .split("\n");

      for (const dir of dirs) {
        if (dir.startsWith("@")) {
          // Scoped package
          const scopedPath = join(nodeModules, dir);
          const scoped = execSync(`ls -1 "${scopedPath}"`, {
            encoding: "utf-8",
          })
            .trim()
            .split("\n");
          for (const sub of scoped) {
            const pkgJsonPath = join(scopedPath, sub, "package.json");
            if (existsSync(pkgJsonPath)) {
              const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
              if (pkgJson.types || pkgJson.typings) {
                entries.push(`${dir}/${sub}@${pkgJson.version ?? "?"}`);
              }
            }
          }
        } else {
          const pkgJsonPath = join(nodeModules, dir, "package.json");
          if (existsSync(pkgJsonPath)) {
            try {
              const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
              if (pkgJson.types || pkgJson.typings) {
                entries.push(`${dir}@${pkgJson.version ?? "?"}`);
              }
            } catch {
              // skip invalid package.json
            }
          }
        }
      }

      const text =
        entries.length > 0
          ? `Available packages (${entries.length}):\n${entries.join("\n")}`
          : "No packages with TypeScript types found in node_modules.";

      return {
        content: [{ type: "text", text }],
      };
    }

    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
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
