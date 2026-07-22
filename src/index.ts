#!/usr/bin/env node

/**
 * ts-docs-mcp — MCP server providing accurate, version-aware TypeScript API docs.
 * Sources: npm registry → GitHub raw → JSDoc → tarball .d.ts → DefinitelyTyped
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { PublicSymbol } from "./types.js";
import { getPackageInfo, resolveSubpath } from "./registry.js";
import { fetchSourceFile, fetchSourceContent, resolveSource } from "./github.js";
import { fetchDtsFromTarball, fetchTypesFromDTs } from "./tarball.js";
import { parsePublicAPI } from "./parser.js";
import { toSummary, formatSymbolDetail, mergeSymbols } from "./format.js";
import { readCache, writeCache } from "./cache.js";

/* ------------------------------------------------------------------ */
/*  Response helper                                                    */
/* ------------------------------------------------------------------ */

function respond(symbols: PublicSymbol[], pkgName: string, version: string, description: string, query?: string) {
  if (query) {
    const found = symbols.filter(s => s.name.toLowerCase().includes(query.toLowerCase()));
    if (found.length) {
      return { content: [{ type: "text" as const, text: found.map(formatSymbolDetail).join("\n\n---\n\n") }] };
    }
    return { content: [{ type: "text" as const, text: `Symbol "${query}" not found.` }] };
  }
  return { content: [{ type: "text" as const, text: toSummary(symbols, pkgName, version, description) }] };
}

/* ------------------------------------------------------------------ */
/*  MCP Server                                                         */
/* ------------------------------------------------------------------ */

const server = new Server(
  { name: "ts-docs-mcp", version: "0.6.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_package_docs",
      description: [
        "Get accurate API documentation for any npm package.",
        "Optionally specify a version (default: latest), subpath (for package subpath exports),",
        "or query to find a specific symbol.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          package: {
            type: "string",
            description: "npm package name, e.g. 'zod', 'express', '@prisma/client'",
          },
          version: {
            type: "string",
            description: "Optional — exact version to fetch (e.g. '3.23.8'). Defaults to latest.",
          },
          subpath: {
            type: "string",
            description: "Optional — subpath export entry, e.g. 'v4/classic' for zod/v4/classic.",
          },
          query: {
            type: "string",
            description:
              "Optional — find a specific symbol within the package.",
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
      const versionArg = args?.version ? String(args.version) : undefined;
      const subpath = args?.subpath ? String(args.subpath) : undefined;
      const query = args?.query ? String(args.query) : undefined;

      if (!pkg) {
        return { content: [{ type: "text", text: "Error: 'package' is required." }], isError: true };
      }

      try {
        // 1. Fetch package metadata (with optional version override)
        const info = await getPackageInfo(pkg, versionArg);

        // 1b. Resolve subpath exports if requested
        let typesHint = info.typesHint;
        let sourceHint = info.sourceHint;
        let label = info.name;

        if (subpath && info.tarballUrl) {
          const resolved = resolveSubpath(info.exports ?? {}, subpath);
          if (resolved.typesHint) typesHint = resolved.typesHint;
          if (resolved.sourceHint) sourceHint = resolved.sourceHint;
          label = `${info.name}/${subpath}`;
        }

        // 2. Check cache (includes subpath in key)
        const cached = readCache(label, info.version, subpath);
        if (cached) {
          const data = JSON.parse(cached);
          return respond(data.symbols, label, info.version, info.description, query);
        }

        // 3. Fetch source from GitHub
        const file = await fetchSourceFile(info.owner, info.repo, info.version, sourceHint, info.name);
        if (!file) {
          return {
            content: [{
              type: "text",
              text: `Could not fetch source for "${label}" v${info.version} from GitHub. The package may not have a public GitHub repository with source code.`,
            }],
            isError: true,
          };
        }

        // 4. Resolve re-exports (only at root — subpath re-exports are already resolved)
        const allFiles = await resolveSource(info.owner, info.repo, info.version, file.path, new Set());

        // 5. Parse all source files
        let allSource = file.content;
        for (const f of allFiles.slice(1)) {
          const content = await fetchSourceContent(info.owner, info.repo, info.version, f);
          if (content) allSource += "\n\n" + content;
        }

        const symbols = parsePublicAPI(allSource);

        // 6. Tarball fallback (uses subpath-specific typesHint)
        if (info.tarballUrl) {
          const dtsContent = await fetchDtsFromTarball(info.tarballUrl, typesHint);
          if (dtsContent) {
            const dtsSymbols = parsePublicAPI(dtsContent);
            if (dtsSymbols.length > 0) {
              const merged = mergeSymbols(symbols, dtsSymbols);
              writeCache(label, info.version, JSON.stringify({ symbols: merged, fetchedAt: Date.now() }), subpath);
              return respond(merged, label, info.version, info.description, query);
            }
          }
        }

        // 7. DefinitelyTyped fallback
        const dtsTypesFallback = await fetchTypesFromDTs(info.name);
        if (dtsTypesFallback) {
          const dtsSymbols = parsePublicAPI(dtsTypesFallback);
          if (dtsSymbols.length > 0) {
            const merged = mergeSymbols(symbols, dtsSymbols);
            const dtLabel = `${label} (types via @types/${info.name})`;
            writeCache(dtLabel, info.version, JSON.stringify({ symbols: merged, fetchedAt: Date.now() }), subpath);
            return respond(merged, dtLabel, info.version, info.description, query);
          }
        }

        // 8. Cache & respond
        writeCache(label, info.version, JSON.stringify({ symbols, fetchedAt: Date.now() }), subpath);
        return respond(symbols, label, info.version, info.description, query);

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
