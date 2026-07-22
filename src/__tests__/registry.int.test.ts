/* ------------------------------------------------------------------ */
/*  Registry integration tests (network) — skip in CI by default      */
/* ------------------------------------------------------------------ */

import { describe, it, expect } from "vitest";
import { getPackageInfo } from "../registry.js";

describe.runIf(process.env.CI !== "true")("getPackageInfo (integration)", () => {
  it("resolves zod metadata", async () => {
    const info = await getPackageInfo("zod");
    expect(info.name).toBe("zod");
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(info.owner).toBe("colinhacks");
    expect(info.repo).toBe("zod");
    expect(info.tarballUrl).toMatch(/registry\.npmjs\.org/);
    expect(info.typesHint).toBeTruthy();
  });

  it("resolves drizzle-orm metadata", async () => {
    const info = await getPackageInfo("drizzle-orm");
    expect(info.name).toBe("drizzle-orm");
    expect(info.owner).toBe("drizzle-team");
    expect(info.repo).toBe("drizzle-orm");
    expect(info.tarballUrl).toBeTruthy();
  });

  it("resolves express metadata (no types field)", async () => {
    const info = await getPackageInfo("express");
    expect(info.name).toBe("express");
    expect(info.owner).toBe("expressjs");
    // express v5 doesn't have a types field
    expect(info.typesHint).toBeNull();
    expect(info.tarballUrl).toBeTruthy();
  });

  it("throws for non-existent package", async () => {
    await expect(getPackageInfo("this-package-does-not-exist-12345"))
      .rejects.toThrow();
  }, 15000);
});
