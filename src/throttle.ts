/* ------------------------------------------------------------------ */
/*  Throttle — token-bucket rate limiter with 429 backoff             */
/* ------------------------------------------------------------------ */

interface Bucket {
  tokens: number;
  max: number;
  lastRefill: number;
  refillIntervalMs: number;
  backoffUntil: number;
}

const buckets = new Map<string, Bucket>();

/** Create or get a token bucket for a named endpoint. */
function getBucket(name: string, maxTokens: number, refillMs: number): Bucket {
  let b = buckets.get(name);
  if (!b) {
    b = { tokens: maxTokens, max: maxTokens, lastRefill: Date.now(), refillIntervalMs: refillMs, backoffUntil: 0 };
    buckets.set(name, b);
  }
  return b;
}

/** Refill tokens based on elapsed time. */
function refill(b: Bucket): void {
  const now = Date.now();
  const elapsed = now - b.lastRefill;
  if (elapsed >= b.refillIntervalMs) {
    const add = Math.floor(elapsed / b.refillIntervalMs);
    b.tokens = Math.min(b.max, b.tokens + add);
    b.lastRefill = now;
  }
}

/** Consume one token. Returns wait time in ms if bucket empty, or 0 if allowed. */
function consume(b: Bucket): number {
  refill(b);
  if (b.tokens > 0) {
    b.tokens--;
    return 0;
  }
  // Next token available in...
  return b.refillIntervalMs - (Date.now() - b.lastRefill);
}

/** Fetch with rate limiting. Returns response or throws on rate limit exhaustion. */
export async function throttledFetch(url: string, init?: RequestInit): Promise<Response> {
  const endpoint = pickEndpoint(url);
  const bucket = getBucket(endpoint, 30, 1000); // 30 req/sec per endpoint

  // Check backoff (from previous 429)
  const now = Date.now();
  if (bucket.backoffUntil > now) {
    const wait = bucket.backoffUntil - now;
    console.error(`[ts-docs-mcp] backoff ${endpoint} for ${wait}ms`);
    await delay(wait);
  }

  // Wait for token
  let waitMs = consume(bucket);
  if (waitMs > 0) {
    console.error(`[ts-docs-mcp] rate limit ${endpoint}, waiting ${waitMs}ms`);
    await delay(waitMs);
    waitMs = consume(bucket); // second chance
    if (waitMs > 0) await delay(waitMs);
  }

  const res = await fetch(url, init);

  // Handle 429 — backoff and retry once
  if (res.status === 429) {
    const retryAfter = parseRetryAfter(res.headers);
    bucket.backoffUntil = Date.now() + retryAfter;
    console.error(`[ts-docs-mcp] 429 ${endpoint}, retry-after ${retryAfter}ms`);
    await delay(retryAfter);
    // Reset and retry
    bucket.tokens = 1;
    return throttledFetch(url, init);
  }

  return res;
}

/** Determine which endpoint the URL belongs to. */
function pickEndpoint(url: string): string {
  if (url.includes("registry.npmjs.org")) return "npm";
  if (url.includes("raw.githubusercontent.com")) return "github-raw";
  return "other";
}

/** Parse Retry-After header (seconds or HTTP-date). */
function parseRetryAfter(headers: Headers): number {
  const val = headers.get("retry-after");
  if (!val) return 5000;
  const secs = parseInt(val, 10);
  if (!isNaN(secs)) return secs * 1000;
  // HTTP-date format — fallback to 5s
  return 5000;
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
