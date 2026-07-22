/* ------------------------------------------------------------------ */
/*  Cache — file-based cache with LRU-like eviction (7d no-access)    */
/* ------------------------------------------------------------------ */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { homedir } from "os";

/** Package version data is immutable — no TTL. Evict only after 7 days of no access. */
const EVICT_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** XDG-compatible cache directory. */
function cacheDir(): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "ts-docs-mcp");
}

export const CACHE_DIR = cacheDir();

interface CacheEntry {
  data: string;               // serialized symbol data
  version: string;            // package version for verification
  lastAccessed: number;       // timestamp of last read
}

function cacheKey(pkg: string, version: string, subpath?: string): string {
  const base = `${pkg}@${version}`;
  const key = subpath ? `${base}/${subpath}` : base;
  return key.replace(/\//g, "_");
}

function cachePath(key: string): string {
  return join(CACHE_DIR, `${key}.json`);
}

/** Read cached data. Updates `lastAccessed` on hit so LRU eviction works. Returns null if missing. */
export function readCache(pkg: string, version: string, subpath?: string): string | null {
  const p = cachePath(cacheKey(pkg, version, subpath));
  if (!existsSync(p)) return null;

  try {
    const raw = readFileSync(p, "utf-8");
    const entry: CacheEntry = JSON.parse(raw);

    // Touch lastAccessed so LRU eviction knows this entry is active
    entry.lastAccessed = Date.now();
    writeFileSync(p, JSON.stringify(entry), "utf-8");

    return entry.data;
  } catch {
    // Corrupt cache — remove and return null
    try { rmSync(p, { force: true }); } catch { /* best effort */ }
    return null;
  }
}

/** Write package documentation to cache. */
export function writeCache(pkg: string, version: string, data: string, subpath?: string): void {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }

  const entry: CacheEntry = {
    data,
    version,
    lastAccessed: Date.now(),
  };

  writeFileSync(cachePath(cacheKey(pkg, version, subpath)), JSON.stringify(entry), "utf-8");

  // Probabilistic cleanup: ~5% chance per write to avoid perf hit on large dirs
  if (Math.random() < 0.05) {
    cleanup();
  }
}

/** Remove entries not accessed in EVICT_AFTER_MS. */
function cleanup(): void {
  if (!existsSync(CACHE_DIR)) return;
  const now = Date.now();

  for (const entry of readdirSync(CACHE_DIR)) {
    const full = join(CACHE_DIR, entry);
    try {
      const raw = readFileSync(full, "utf-8");
      const cache: CacheEntry = JSON.parse(raw);
      if (now - cache.lastAccessed > EVICT_AFTER_MS) {
        rmSync(full, { force: true });
      }
    } catch {
      // Can't parse — delete corrupt entry
      try { rmSync(full, { force: true }); } catch { /* skip */ }
    }
  }
}
