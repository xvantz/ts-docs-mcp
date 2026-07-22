/* ------------------------------------------------------------------ */
/*  Throttle — per-endpoint token bucket rate limiter                  */
/* ------------------------------------------------------------------ */

interface Bucket {
  max: number;
  tokens: number;
  refillPerSec: number;
  lastRefill: number;
  backoffUntil: number;
  warnedAt: number;     // last time we logged a wait (rate-limit stderr noise)
  waitsLogged: number;
}

const buckets = new Map<string, Bucket>();

const ENDPOINTS: Record<string, { max: number; refillPerSec: number }> = {
  "npm":        { max: 30, refillPerSec: 10 },   // npm registry is generous
  "github-raw": { max: 10, refillPerSec: 2 },    // GitHub unauthenticated: 60/hr = 1/min
  "other":      { max: 10, refillPerSec: 5 },
};

function getBucket(endpoint: string): Bucket {
  let b = buckets.get(endpoint);
  if (!b) {
    const cfg = ENDPOINTS[endpoint] ?? ENDPOINTS["other"];
    b = {
      max: cfg.max,
      tokens: cfg.max,
      refillPerSec: cfg.refillPerSec,
      lastRefill: Date.now(),
      backoffUntil: 0,
      warnedAt: 0,
      waitsLogged: 0,
    };
    buckets.set(endpoint, b);
  }
  return b;
}

/** Refill tokens based on elapsed time. */
function refill(b: Bucket): void {
  const now = Date.now();
  const elapsed = (now - b.lastRefill) / 1000;
  if (elapsed < 0.05) return; // <50ms, skip to avoid float noise
  const add = Math.floor(elapsed * b.refillPerSec);
  if (add > 0) {
    b.tokens = Math.min(b.max, b.tokens + add);
    b.lastRefill = now;
  }
}

/** Try to consume one token. Returns wait time in ms or 0 if allowed. */
function tryConsume(b: Bucket): number {
  refill(b);
  if (b.tokens > 0) {
    b.tokens--;
    return 0;
  }
  // Time until next token (approximate)
  return Math.ceil(1000 / b.refillPerSec);
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Pick endpoint name from URL. */
export function pickEndpoint(url: string): string {
  if (url.includes("registry.npmjs.org")) return "npm";
  if (url.includes("raw.githubusercontent.com")) return "github-raw";
  return "other";
}

/** Parse Retry-After header (seconds). */
function parseRetryAfter(headers: Headers): number {
  const val = headers.get("retry-after");
  if (!val) return 5000;
  const secs = parseInt(val, 10);
  return isNaN(secs) ? 5000 : secs * 1000;
}

/** Log rate-limit info at most once per 30s per endpoint (keeps stderr clean). */
function logOnce(b: Bucket, endpoint: string, msg: string): void {
  const now = Date.now();
  if (now - b.warnedAt > 30_000) {
    console.error(`[ts-docs-mcp] ${endpoint}: ${msg}`);
    b.warnedAt = now;
  }
  b.waitsLogged++;
}

/**
 * Fetch with per-endpoint rate limiting + 429 backoff.
 * Each call consumes one token. If bucket empty, waits for next token.
 */
export async function throttledFetch(url: string, init?: RequestInit, timeoutMs = 10_000): Promise<Response> {
  const endpoint = pickEndpoint(url);
  const bucket = getBucket(endpoint);

  // Check 429 backoff
  const now = Date.now();
  if (bucket.backoffUntil > now) {
    const wait = bucket.backoffUntil - now;
    logOnce(bucket, endpoint, `429 backoff ${wait}ms`);
    await delay(wait);
  }

  // Wait for a token
  let waitMs = tryConsume(bucket);
  if (waitMs > 0) {
    logOnce(bucket, endpoint, `rate limited, waiting ~${waitMs}ms`);
    await delay(waitMs);
    // Try again
    waitMs = tryConsume(bucket);
    if (waitMs > 0) await delay(waitMs);
  }

  // Fetch with timeout
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }

  // Handle 429 — backoff and retry once
  if (res.status === 429) {
    const retryAfter = parseRetryAfter(res.headers);
    bucket.backoffUntil = Date.now() + retryAfter;
    logOnce(bucket, endpoint, `429, retry-after ${retryAfter}ms`);
    await delay(retryAfter);
    bucket.tokens = Math.min(bucket.max, 1); // one token to retry
    return throttledFetch(url, init, timeoutMs);
  }

  return res;
}

/** Reset all buckets (for testing). */
export function resetBuckets(): void {
  buckets.clear();
}
