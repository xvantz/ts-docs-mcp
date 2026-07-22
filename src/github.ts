/* ------------------------------------------------------------------ */
/*  GitHub source fetching                                            */
/* ------------------------------------------------------------------ */

import { join, dirname } from "path";
import type { SourceFile } from "./types.js";
import { mapConcurrent, TIMEOUT } from "./registry.js";
import { throttledFetch } from "./throttle.js";

const MAX_RESOLVE_FILES = 20;
const MAX_RESOLVE_DEPTH = 2;
const CONCURRENCY = 5;
const RE_EXPORT_RE = /export\s+(?:\*|{[^}]+?})\s+from\s+['"]([^'"]+)['"]/g;

/** Auth header for GitHub raw requests (5000 req/hr instead of 60). */
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_HEADERS: Record<string, string> = GITHUB_TOKEN
  ? { Authorization: `Bearer ${GITHUB_TOKEN}`, "User-Agent": "ts-docs-mcp/0.1" }
  : { "User-Agent": "ts-docs-mcp/0.1" };

/** Fetch from GitHub raw with optional auth. */
async function fetchGitHubText(url: string): Promise<string> {
  const res = await throttledFetch(url, { headers: GITHUB_HEADERS }, TIMEOUT);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

/* ------------------------------------------------------------------ */
/*  Raw URL helpers                                                    */
/* ------------------------------------------------------------------ */

/** Build GitHub raw content URLs for a given ref and path, trying multiple refs. */
function buildRawURLs(owner: string, repo: string, ref: string, path: string): string[] {
  const refs = ref.startsWith("v") ? [ref, ref.slice(1)] : [`v${ref}`, ref];
  const branches = ["main", "master"];
  const urls: string[] = [];
  for (const r of [...refs, ...branches]) {
    urls.push(`https://raw.githubusercontent.com/${owner}/${repo}/${r}/${path}`);
  }
  return urls;
}

/** Try to fetch a file from GitHub raw via multiple refs. */
async function tryFetchRaw(urls: string[]): Promise<string | null> {
  for (const url of urls) {
    try {
      const text = await fetchGitHubText(url);
      // GitHub raw returns HTTP 200 with "404: Not Found\n" body for missing files
      if (text.length > 15 && !text.startsWith("404:")) return text;
    } catch { /* try next ref */ }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
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
    paths.push(cleanHint);
    paths.push(`packages/${repo}/${cleanHint}`);
    paths.push(`packages/${pkgDir}/${cleanHint}`);
    paths.push(`lib/${cleanHint}`);
  }
  paths.push(
    "src/index.ts", "lib/index.ts",
    "lib/index.js", "lib/main.js",
    "src/index.js", "src/main.js",
    "index.ts", "index.js",
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

  for (const p of paths) {
    const urls = buildRawURLs(owner, repo, ref, p);
    const content = await tryFetchRaw(urls);
    if (content) return { content, path: p };
  }
  return null;
}

/** Fetch a single source file from GitHub raw. */
export async function fetchSourceContent(
  owner: string, repo: string, ref: string, path: string
): Promise<string | null> {
  const urls = buildRawURLs(owner, repo, ref, path);
  return tryFetchRaw(urls);
}

/** Resolve re-exports in a single file and return referenced file paths. */
async function resolveReExports(
  owner: string, repo: string, ref: string, path: string, visited: Set<string>, depth: number
): Promise<string[]> {
  if (depth > MAX_RESOLVE_DEPTH) return [];
  const content = await fetchSourceContent(owner, repo, ref, path);
  if (!content) return [];

  const found: string[] = [];
  const re = new RegExp(RE_EXPORT_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const importPath = match[1];
    const normalized = importPath.replace(/\.js$/, ".ts").replace(/\.ts$/, "");
    const baseDir = dirname(path);
    const resolved = join(baseDir, `${normalized}.ts`).replace(/^\.\//, "");
    if (!visited.has(resolved) && found.length < MAX_RESOLVE_FILES) {
      visited.add(resolved);
      found.push(resolved);
    }
  }
  return found;
}

/**
 * Follow re-exports to find all declaration files.
 * BFS with parallel fetch per level.
 */
export async function resolveSource(
  owner: string, repo: string, ref: string, startPath: string, visited = new Set<string>()
): Promise<string[]> {
  const files: string[] = [startPath];
  visited.add(startPath);

  let currentLevel: string[] = [startPath];
  let depth = 0;

  while (currentLevel.length > 0 && files.length < MAX_RESOLVE_FILES && depth <= MAX_RESOLVE_DEPTH) {
    const results = await mapConcurrent(currentLevel, (path) =>
      resolveReExports(owner, repo, ref, path, visited, depth),
    CONCURRENCY);
    const nextLevel = results.flat();
    const capped = nextLevel.slice(0, MAX_RESOLVE_FILES - files.length);
    files.push(...capped);
    currentLevel = capped;
    depth++;
  }
  return files;
}
