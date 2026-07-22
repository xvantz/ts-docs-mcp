#!/usr/bin/env node

/**
 * ts-docs-mcp — MCP server that provides LLMs with accurate,
 * version-aware TypeScript API documentation.
 *
 * Sources documentation directly from source code:
 *   npm registry → GitHub raw → JSDoc + signatures → tarball .d.ts fallback
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
import type { PublicSymbol } from "./types.js";
import { getPackageInfo } from "./registry.js";
import { fetchSourceFile, fetchSourceContent, resolveSource } from "./github.js";
import { fetchDtsFromTarball, fetchTypesFromDTs } from "./tarball.js";
import { parsePublicAPI } from "./parser.js";
import { toSummary, formatSymbolDetail, mergeSymbols } from "./format.js";
import { readCache, writeCache } from "./cache.js";

/* ------------------------------------------------------------------ */
/*  Response helper — deduplicates query filtering + formatting        */
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
          return respond(data.symbols, info.name, info.version, info.description, query);
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

        // 6. Always try tarball fallback & merge (GitHub source often partial — barrel files)
        if (info.tarballUrl) {
          const dtsContent = await fetchDtsFromTarball(info.tarballUrl, info.typesHint);
          if (dtsContent) {
            const dtsSymbols = parsePublicAPI(dtsContent);
            if (dtsSymbols.length > 0) {
              const merged = mergeSymbols(symbols, dtsSymbols);
              writeCache(info.name, info.version, JSON.stringify({ symbols: merged, fetchedAt: Date.now() }));
              return respond(merged, info.name, info.version, info.description, query);
            }
          }
        }

        // 6.5 DefinitelyTyped fallback — try @types/{name} if regular .d.ts failed
        const dtsTypesFallback = await fetchTypesFromDTs(info.name);
        if (dtsTypesFallback) {
          const dtsSymbols = parsePublicAPI(dtsTypesFallback);
          if (dtsSymbols.length > 0) {
            const merged = mergeSymbols(symbols, dtsSymbols);
            const label = `${info.name} (types via @types/${info.name})`;
            writeCache(info.name, info.version, JSON.stringify({ symbols: merged, fetchedAt: Date.now() }));
            return respond(merged, label, info.version, info.description, query);
          }
        }

        // 7. Cache & respond
        writeCache(info.name, info.version, JSON.stringify({ symbols, fetchedAt: Date.now() }));
        return respond(symbols, info.name, info.version, info.description, query);

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
