/* ------------------------------------------------------------------ */
/*  Cache unit tests                                                   */
/* ------------------------------------------------------------------ */

import { describe, it, expect, afterEach } from "vitest";
import { rmSync, existsSync } from "fs";
import { join } from "path";
import { readCache, writeCache, CACHE_DIR } from "../cache.js";

const testKey = "test-pkg@1.0.0".replace(/\//g, "_");
const testPath = join(CACHE_DIR, `${testKey}.json`);

describe("cache", () => {
  afterEach(() => {
    if (existsSync(testPath)) rmSync(testPath, { force: true });
  });

  it("writes and reads cache files", () => {
    writeCache("test-pkg", "1.0.0", JSON.stringify({ data: "hello" }));
    const result = readCache("test-pkg", "1.0.0");
    expect(result).not.toBeNull();
    expect(JSON.parse(result!)).toEqual({ data: "hello" });
  });

  it("returns null for non-existent cache", () => {
    const result = readCache("non-existent", "0.0.0");
    expect(result).toBeNull();
  });

  it("CACHE_DIR is an absolute path", () => {
    expect(CACHE_DIR).toBeTruthy();
    expect(CACHE_DIR).toContain("ts-docs-mcp");
    expect(CACHE_DIR.startsWith("/")).toBe(true);
  });
});
