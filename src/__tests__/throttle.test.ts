/* ------------------------------------------------------------------ */
/*  Throttle unit tests                                                */
/* ------------------------------------------------------------------ */

import { describe, it, expect } from "vitest";
import { pickEndpoint, resetBuckets } from "../throttle.js";

describe("pickEndpoint", () => {
  it("identifies npm registry URLs", () => {
    expect(pickEndpoint("https://registry.npmjs.org/zod")).toBe("npm");
    expect(pickEndpoint("https://registry.npmjs.org/@types/express")).toBe("npm");
  });

  it("identifies GitHub raw URLs", () => {
    expect(pickEndpoint("https://raw.githubusercontent.com/colinhacks/zod/main/src/index.ts")).toBe("github-raw");
  });

  it("defaults to 'other' for unknown URLs", () => {
    expect(pickEndpoint("https://example.com/file.txt")).toBe("other");
  });
});

describe("resetBuckets", () => {
  it("clears all buckets without error", () => {
    expect(() => resetBuckets()).not.toThrow();
  });
});
