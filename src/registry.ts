/* ------------------------------------------------------------------ */
/*  Registry — npm package metadata                                   */
/* ------------------------------------------------------------------ */

import type { PackageInfo } from "./types.js";
import { throttledFetch } from "./throttle.js";

export const NPM_REGISTRY = "https://registry.npmjs.org";
export const TIMEOUT = 10_000;

/* ------------------------------------------------------------------ */
/*  HTTP helpers                                                       */
/* ------------------------------------------------------------------ */

export async function fetchJSON(url: string): Promise<any> {
  const res = await throttledFetch(url, {
    headers: { Accept: "application/json", "User-Agent": "ts-docs-mcp/0.1" },
  }, TIMEOUT);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

export async function fetchText(url: string): Promise<string> {
  const res = await throttledFetch(url, {
    headers: { "User-Agent": "ts-docs-mcp/0.1" },
  }, TIMEOUT);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

/* ------------------------------------------------------------------ */
/*  Concurrency helper                                                 */
/* ------------------------------------------------------------------ */

export async function mapConcurrent<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  const results: (R | undefined)[] = new Array(items.length);
  let nextIdx = 0;
  const worker = async () => {
    while (nextIdx < items.length) {
      const idx = nextIdx++;
      results[idx] = await fn(items[idx]);
    }
  };
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results as R[];
}

/* ------------------------------------------------------------------ */
/*  Package info                                                       */
/* ------------------------------------------------------------------ */

/** Find types entry from nested exports map (exports, import, require, etc.). */
export function extractTypesHint(exports: any): string | null {
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

/** Resolve subpath export entry (e.g. "./v4/classic") from package exports map. */
export function resolveSubpath(exports: any, subpath: string): { typesHint: string | null; sourceHint: string | null } {
  const key = subpath.startsWith(".") ? subpath : `./${subpath}`;
  const entry = exports[key];
  if (!entry) return { typesHint: null, sourceHint: null };

  if (typeof entry === "string") {
    return { typesHint: entry, sourceHint: entry };
  }

  // Conditional export — extract types + source from nested conditions
  const typesHint = extractTypesHint(entry);
  let sourceHint: string | null = null;
  if (entry.source && typeof entry.source === "string") sourceHint = entry.source;
  if (!sourceHint) {
    // Try to derive source from import/default
    const importPath = entry.import || entry.default || null;
    if (typeof importPath === "string") sourceHint = importPath;
  }
  return { typesHint, sourceHint };
}

/**
 * Resolve package metadata and GitHub info from the npm registry.
 * When versionOverride is provided, fetches that specific version.
 */
export async function getPackageInfo(pkg: string, versionOverride?: string): Promise<PackageInfo> {
  const data = await fetchJSON(`${NPM_REGISTRY}/${encodeURIComponent(pkg)}`);
  const version = versionOverride || data["dist-tags"]?.latest;
  if (!version) throw new Error(`No version found for "${pkg}"`);

  const v = data.versions?.[version];
  if (!v) throw new Error(`Version "${version}" not found for "${pkg}"`);

  const description = v?.description ?? data.description ?? "";

  // Parse GitHub repo
  const repo = v?.repository ?? data.repository;
  const repoStr = typeof repo === "string" ? repo : repo?.url ?? "";
  let match = repoStr.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
  if (!match) match = repoStr.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!match) throw new Error(`"${pkg}": not a GitHub repository`);

  const owner = match[1];
  const repoName = match[2];

  // Find source entry point for root (".")
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

  // Get types file hint (for .d.ts fallback)
  const typesHint: string | null =
    v?.types ?? v?.typings ?? extractTypesHint(v?.exports?.["."]) ?? null;
  const tarballUrl: string | null = v?.dist?.tarball ?? null;

  return { name: v?.name ?? pkg, version, description, owner, repo: repoName, sourceHint, typesHint, tarballUrl, exports: v?.exports };
}
