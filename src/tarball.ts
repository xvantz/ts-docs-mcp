/* ------------------------------------------------------------------ */
/*  Tarball download + DefinitelyTyped fallback                       */
/* ------------------------------------------------------------------ */

import { execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { join, dirname } from "path";
import { CACHE_DIR } from "./cache.js";
import { throttledFetch } from "./throttle.js";
import { fetchJSON, NPM_REGISTRY } from "./registry.js";

/* ------------------------------------------------------------------ */
/*  .d.ts path resolution                                              */
/* ------------------------------------------------------------------ */

const DTS_EXT_MAP: Record<string, string[]> = {
  ".js": [".d.ts", ".d.cts", ".d.mts"],
  ".mjs": [".d.mts", ".d.ts"],
  ".cjs": [".d.cts", ".d.ts"],
  ".ts": [".d.ts"],
  "": [".d.ts", "/index.d.ts", "/index.d.cts"],
};

/** Resolve an import path like "./foo" or "./foo.js" to the actual .d.ts file. */
export function resolveDTsPath(currentFile: string, importPath: string): string | null {
  const baseDir = dirname(currentFile);
  for (const [ext, candidates] of Object.entries(DTS_EXT_MAP)) {
    let base = importPath;
    if (ext && importPath.endsWith(ext)) {
      base = importPath.slice(0, -ext.length);
    } else if (ext) {
      continue;
    }
    for (const candidate of candidates) {
      const target = join(baseDir, base + candidate);
      if (existsSync(target)) return target;
    }
    if (ext === "") {
      if (existsSync(join(baseDir, base + "/index.d.ts"))) return join(baseDir, base + "/index.d.ts");
      if (existsSync(join(baseDir, base + "/index.d.cts"))) return join(baseDir, base + "/index.d.cts");
    }
  }
  return null;
}

/** Follow imports/re-exports in a .d.ts file to collect all referenced files. */
function collectDTsFiles(root: string, entryPath: string, visited: Set<string>): string[] {
  if (visited.has(entryPath)) return [];
  visited.add(entryPath);
  const files: string[] = [entryPath];

  const content = readFileSync(entryPath, "utf-8");
  const importRegex = /(?:import|export)\s+(?:\*|{[^}]+}|\w+(?:\s*,\s*\w+)?)\s+from\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(content)) !== null) {
    if (files.length >= 50) break;
    const importPath = match[1];
    if (!importPath.startsWith(".")) continue;
    const resolved = resolveDTsPath(entryPath, importPath);
    if (resolved && existsSync(resolved) && !visited.has(resolved)) {
      const nested = collectDTsFiles(root, resolved, visited);
      files.push(...nested);
    }
  }
  return files;
}

/* ------------------------------------------------------------------ */
/*  Main export                                                        */
/* ------------------------------------------------------------------ */

/**
 * Download npm tarball, extract .d.ts files, follow re-exports.
 * Returns concatenated content or null.
 */
export async function fetchDtsFromTarball(
  tarballUrl: string, typesPath: string | null
): Promise<string | null> {
  const tmpDir = join(CACHE_DIR, `.tmp-tgz-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  const tgzPath = join(tmpDir, "pkg.tgz");

  try {
    const res = await throttledFetch(tarballUrl, {
      headers: { "User-Agent": "ts-docs-mcp/0.1" },
    }, 15_000);
    if (!res.ok) { console.error("[ts-docs-mcp] tarball fetch failed:", res.status); return null; }
    const buffer = Buffer.from(await res.arrayBuffer());
    writeFileSync(tgzPath, buffer);

    execSync(`tar xzf "${tgzPath}" -C "${tmpDir}" --strip-components=1 2>/dev/null`, { stdio: "pipe", timeout: 15000 });

    const visited = new Set<string>();
    const collected: string[] = [];

    if (typesPath) {
      const cleanPath = typesPath.replace(/^\.\//, "");
      const entry = join(tmpDir, cleanPath);
      if (existsSync(entry)) {
        collected.push(...collectDTsFiles(tmpDir, entry, visited));
      }
    }

    if (collected.length === 0) {
      const allFiles = execSync(
        `find "${tmpDir}" -name '*.d.ts' -o -name '*.d.cts' -o -name '*.d.mts' 2>/dev/null | head -50`,
        { encoding: "utf-8" }
      ).trim().split("\n").filter(Boolean);
      for (const f of allFiles) {
        if (visited.has(f)) continue;
        collected.push(f);
        visited.add(f);
      }
    }

    if (collected.length === 0) {
      console.error("[ts-docs-mcp] no .d.ts found in tarball");
      return null;
    }

    const parts: string[] = [];
    for (const f of collected) {
      parts.push(`// ${f.replace(tmpDir, "")}`);
      parts.push(readFileSync(f, "utf-8"));
    }
    return parts.join("\n");
  } catch (e: any) { console.error("[ts-docs-mcp] tarball error:", e.message); return null; }
  finally { rmSync(tmpDir, { recursive: true, force: true }); }
}

/* ------------------------------------------------------------------ */
/*  DefinitelyTyped fallback                                            */
/* ------------------------------------------------------------------ */

/**
 * When a package ships no .d.ts files (JS-only, e.g. express),
 * try fetching types from @types/{name} on npm.
 */
export async function fetchTypesFromDTs(originalName: string): Promise<string | null> {
  const typesName = originalName.startsWith("@")
    ? `@types/${originalName.slice(1).replace("/", "__")}`
    : `@types/${originalName}`;

  let data: any;
  try {
    data = await fetchJSON(`${NPM_REGISTRY}/${encodeURIComponent(typesName)}`);
  } catch {
    return null;
  }

  const version = data["dist-tags"]?.latest;
  if (!version) return null;

  const v = data.versions?.[version];
  const tarballUrl = v?.dist?.tarball;
  const typesHint = v?.types ?? v?.typings ?? "index.d.ts";
  if (!tarballUrl) return null;

  console.error(`[ts-docs-mcp] falling back to ${typesName}@${version}`);
  return fetchDtsFromTarball(tarballUrl, typesHint);
}
