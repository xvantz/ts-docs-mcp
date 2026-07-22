/* ------------------------------------------------------------------ */
/*  Cache — file-based caching for registry responses                 */
/* ------------------------------------------------------------------ */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

export const CACHE_DIR = ".llm-cache";

function cacheKey(pkg: string, version: string): string {
  return `${pkg}@${version}`.replace(/\//g, "_");
}

function cachePath(key: string): string {
  return join(CACHE_DIR, `${key}.json`);
}

/** Read cached data for a package version. Returns null if missing. */
export function readCache(pkg: string, version: string): string | null {
  const p = cachePath(cacheKey(pkg, version));
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf-8");
}

/** Write package documentation to cache. */
export function writeCache(pkg: string, version: string, data: string): void {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cachePath(cacheKey(pkg, version)), data, "utf-8");
}
