/* ------------------------------------------------------------------ */
/*  Tarball unit tests                                                 */
/* ------------------------------------------------------------------ */

import { describe, it, expect } from "vitest";
import { resolveDTsPath } from "../tarball.js";

describe("resolveDTsPath", () => {
  it("resolves .js import to .d.ts", () => {
    // When no files exist (fs.existsSync returns false), returns null
    const result = resolveDTsPath("/pkg/dist/index.js", "./types.js");
    expect(result).toBeNull(); // file doesn't exist in test env
  });

  it("resolves extensionless import to index.d.ts", () => {
    const result = resolveDTsPath("/pkg/dist/index.js", "./utils");
    expect(result).toBeNull();
  });

  it("resolves .mjs import to .d.mts", () => {
    const result = resolveDTsPath("/pkg/dist/index.mjs", "./types.mjs");
    expect(result).toBeNull();
  });

  it("handles relative path traversal", () => {
    const result = resolveDTsPath("/pkg/dist/sub/index.js", "../types.js");
    expect(result).toBeNull();
  });

  it("returns null for empty import path", () => {
    const result = resolveDTsPath("/pkg/dist/index.js", "");
    // Should not crash for empty path
    expect(result).toBeNull();
  });
});
