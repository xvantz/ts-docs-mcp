/* ------------------------------------------------------------------ */
/*  Cache — file-based caching with TTL and XDG path                  */
/* ------------------------------------------------------------------ */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const TTL_MS = 24 * 60 * 60 * 1000;     // 24 hours
const CLEANUP_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** XDG-compatible cache directory. */
function cacheDir(): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "ts-docs-mcp");
}

export const CACHE_DIR = cacheDir();

function cacheKey(pkg: string, version: string, subpath?: string): string {
  const base = `${pkg}@${version}`;
  const key = subpath ? `${base}/${subpath}` : base;
  return key.replace(/\//g, "_");
}

function cachePath(key: string): string {
  return join(CACHE_DIR, `${key}.json`);
}

/** Read cached data for a package version. Returns null if missing or expired. */
export function readCache(pkg: string, version: string, subpath?: string): string | null {
  const p = cachePath(cacheKey(pkg, version, subpath));
  if (!existsSync(p)) return null;

  try {
    const stat = statSync(p);
    const age = Date.now() - stat.mtimeMs;
    if (age > TTL_MS) {
      // Stale — delete and return null so it's re-fetched
      try { rmSync(p); } catch { /* best effort */ }
      return null;
    }
    return readFileSync(p, "utf-8");
  } catch {
    return null;
  }
}

/** Write package documentation to cache. Cleans old entries periodically. */
export function writeCache(pkg: string, version: string, data: string, subpath?: string): void {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
  writeFileSync(cachePath(cacheKey(pkg, version, subpath)), data, "utf-8");

  // Probabilistic cleanup: ~5% chance per write to avoid perf hit
  if (Math.random() < 0.05) {
    cleanup();
  }
}

/** Remove cache entries older than CLEANUP_MS. */
function cleanup(): void {
  if (!existsSync(CACHE_DIR)) return;
  const now = Date.now();
  for (const entry of readdirSync(CACHE_DIR)) {
    const full = join(CACHE_DIR, entry);
    try {
      const stat = statSync(full);
      if (stat.isFile() && now - stat.mtimeMs > CLEANUP_MS) {
        rmSync(full);
      }
    } catch { /* skip */ }
  }
}
