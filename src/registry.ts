/* ------------------------------------------------------------------ */
/*  Registry — npm metadata, GitHub source, tarball fallback          */
/* ------------------------------------------------------------------ */

import { execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { join, dirname } from "path";
import type { PackageInfo, SourceFile } from "./types.js";
import { CACHE_DIR } from "./cache.js";
import { throttledFetch } from "./throttle.js";

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

const NPM_REGISTRY = "https://registry.npmjs.org";

/* ------------------------------------------------------------------ */
/*  HTTP helpers                                                       */
/* ------------------------------------------------------------------ */

async function fetchJSON(url: string): Promise<any> {
  const res = await throttledFetch(url, {
    headers: { "Accept": "application/json", "User-Agent": "ts-docs-mcp/0.1" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

async function fetchText(url: string): Promise<string> {
  const res = await throttledFetch(url, {
    headers: { "User-Agent": "ts-docs-mcp/0.1" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

/* ------------------------------------------------------------------ */
/*  NPM registry → GitHub source                                       */
/* ------------------------------------------------------------------ */

/** Find types entry from nested exports map. */
function extractTypesHint(exports: any): string | null {
  if (!exports || typeof exports !== "object") return null;
  if (typeof exports === "string") return exports;
  if (exports.types && typeof exports.types === "string") return exports.types;
  for (const key of ["import", "require", "default", "node", "browser"]) {
    if (exports[key]) {
      const found = extractTypesHint(exports[key]);
      if (found) return found;
    }
  }
  return null;
}

/** Resolve package metadata and GitHub info from the npm registry. */
export async function getPackageInfo(pkg: string): Promise<PackageInfo> {
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

  // Get types file hint (for .d.ts fallback) — try nested exports conditions
  const typesHint: string | null =
    v?.types ?? v?.typings ?? extractTypesHint(v?.exports?.["."]) ?? null;
  const tarballUrl: string | null = v?.dist?.tarball ?? null;

  return { name: v?.name ?? pkg, version, description, owner, repo: repoName, sourceHint, typesHint, tarballUrl };
}

/* ------------------------------------------------------------------ */
/*  GitHub source fetching                                             */
/* ------------------------------------------------------------------ */

/** Try multiple source URL patterns and return the first that resolves. */
export async function fetchSourceFile(
  owner: string, repo: string, ref: string, hint: string | null,
  pkgName: string
): Promise<SourceFile | null> {
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
    "lib/index.js", "lib/main.js",
    "src/index.js", "src/main.js",
    "index.ts", "index.js",
    // Try package name as filename: fastify.js, express.js
    `${pkgDir}.ts`, `${pkgDir}.js`,
    `${repo}.ts`, `${repo}.js`,
    `lib/${pkgDir}.js`, `lib/${pkgDir}.ts`,
    `src/${pkgDir}.ts`, `src/${pkgDir}.js`,
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

/** Fetch a single source file from GitHub raw. */
export async function fetchSourceContent(
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

/** Follow re-exports in a TS source file to find the actual declarations. */
export async function resolveSource(
  owner: string, repo: string, ref: string, startPath: string, visited = new Set<string>()
): Promise<string[]> {
  const files: string[] = [startPath];

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
      } catch {}
    }
    if (count === 0) return;
  };

  await resolveLevel(startPath, 1);
  return files;
}

/* ------------------------------------------------------------------ */
/*  Tarball fallback                                                   */
/* ------------------------------------------------------------------ */

/** Resolve an import path like "./foo" or "./foo.js" to the actual .d.ts file path. */
function resolveDTsPath(currentFile: string, importPath: string): string | null {
  const baseDir = dirname(currentFile);

  const extMap: Record<string, string[]> = {
    ".js": [".d.ts", ".d.cts", ".d.mts"],
    ".mjs": [".d.mts", ".d.ts"],
    ".cjs": [".d.cts", ".d.ts"],
    ".ts": [".d.ts"],
    "": [".d.ts", "/index.d.ts", "/index.d.cts"],
  };

  for (const [ext, candidates] of Object.entries(extMap)) {
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
      for (const _ of candidates) {
        if (existsSync(join(baseDir, base + "/index.d.ts"))) return join(baseDir, base + "/index.d.ts");
        if (existsSync(join(baseDir, base + "/index.d.cts"))) return join(baseDir, base + "/index.d.cts");
      }
    }
  }

  return null;
}

/** Follow imports/re-exports in a .d.ts file to collect all referenced files from extracted tarball. */
function collectDTsFiles(root: string, entryPath: string, visited: Set<string>): string[] {
  if (visited.has(entryPath)) return [];
  visited.add(entryPath);
  const files: string[] = [entryPath];

  const content = readFileSync(entryPath, "utf-8");

  const importRegex = /(?:import|export)\s+(?:\*|{[^}]+}|\w+(?:\s*,\s*\w+)?)\s+from\s+["']([^"']+)["']/g;
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

/** Download npm tarball, extract .d.ts files, follow re-exports. Returns concatenated content. */
export async function fetchDtsFromTarball(
  tarballUrl: string, typesPath: string | null
): Promise<string | null> {
  const tmpDir = join(CACHE_DIR, `.tmp-tgz-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  const tgzPath = join(tmpDir, "pkg.tgz");

  try {
    const res = await throttledFetch(tarballUrl, { headers: { "User-Agent": "ts-docs-mcp/0.1" } });
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
