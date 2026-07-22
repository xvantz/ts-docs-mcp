/* ------------------------------------------------------------------ */
/*  Formatter unit tests                                               */
/* ------------------------------------------------------------------ */

import { describe, it, expect } from "vitest";
import { toSummary, formatSymbolDetail, mergeSymbols } from "../format.js";
import type { PublicSymbol } from "../types.js";

function makeSymbol(overrides: Partial<PublicSymbol> & { name: string }): PublicSymbol {
  return {
    kind: "function",
    jsdoc: "",
    signature: `export function ${overrides.name}()`,
    ...overrides,
  };
}

describe("mergeSymbols", () => {
  it("merges two arrays, deduplicating by name", () => {
    const a = [makeSymbol({ name: "foo" }), makeSymbol({ name: "bar" })];
    const b = [makeSymbol({ name: "bar" }), makeSymbol({ name: "baz" })];
    const merged = mergeSymbols(a, b);
    expect(merged).toHaveLength(3);
    expect(merged.map(s => s.name).sort()).toEqual(["bar", "baz", "foo"]);
  });

  it("keeps first occurrence (GitHub priority)", () => {
    const a = [makeSymbol({ name: "x", jsdoc: "from github" })];
    const b = [makeSymbol({ name: "x", jsdoc: "from tarball" })];
    const merged = mergeSymbols(a, b);
    expect(merged).toHaveLength(1);
    expect(merged[0].jsdoc).toBe("from github");
  });

  it("handles empty arrays", () => {
    expect(mergeSymbols([], [])).toHaveLength(0);
    const s = [makeSymbol({ name: "a" })];
    expect(mergeSymbols(s, [])).toHaveLength(1);
    expect(mergeSymbols([], s)).toHaveLength(1);
  });
});

describe("toSummary", () => {
  it("shows header with package name and version", () => {
    const result = toSummary([], "my-pkg", "1.0.0", "A test package");
    expect(result).toContain("# my-pkg API v1.0.0");
    expect(result).toContain("A test package");
  });

  it("groups symbols by kind", () => {
    const symbols = [
      makeSymbol({ name: "getUser", kind: "function" }),
      makeSymbol({ name: "User", kind: "interface" }),
    ];
    const result = toSummary(symbols, "pkg", "1.0.0", "");
    expect(result).toContain("## Functions");
    expect(result).toContain("## Interfaces");
  });

  it("shows deprecation badge", () => {
    const symbols = [
      makeSymbol({ name: "oldFunc", deprecation: "Use newFunc" }),
    ];
    const result = toSummary(symbols, "pkg", "1.0.0", "");
    expect(result).toContain("⚠️");
    expect(result).toContain("Use newFunc");
  });

  it("shows JSDoc description when available", () => {
    const symbols = [
      makeSymbol({ name: "getUser", jsdoc: "Fetches a user." }),
    ];
    const result = toSummary(symbols, "pkg", "1.0.0", "");
    expect(result).toContain("Fetches a user");
  });

  it("shows signature snippet when no JSDoc", () => {
    const symbols = [
      makeSymbol({ name: "getUser", signature: "export function getUser(id: string): User" }),
    ];
    const result = toSummary(symbols, "pkg", "1.0.0", "");
    expect(result).toContain("function getUser(id: string)");
  });

  it('shows count footer when exceeding 15 per group', () => {
    const symbols = Array.from({ length: 20 }, (_, i) =>
      makeSymbol({ name: `fn${i}`, kind: "function" })
    );
    const result = toSummary(symbols, "pkg", "1.0.0", "");
    expect(result).toContain("showing 15");
    expect(result).toContain("Showing 15 of 20 symbols");
  });
});

describe("formatSymbolDetail", () => {
  it("shows name and kind in header", () => {
    const result = formatSymbolDetail(makeSymbol({ name: "myFunc", kind: "function" }));
    expect(result).toContain("## myFunc (function)");
  });

  it("shows deprecation notice", () => {
    const result = formatSymbolDetail(makeSymbol({ name: "old", deprecation: "gone" }));
    expect(result).toContain("⚠️");
    expect(result).toContain("gone");
  });

  it("shows JSDoc when available", () => {
    const result = formatSymbolDetail(makeSymbol({ name: "f", jsdoc: "Docs here" }));
    expect(result).toContain("Docs here");
  });

  it("includes signature in code block", () => {
    const result = formatSymbolDetail(makeSymbol({ name: "f", signature: "function f(): void" }));
    expect(result).toContain("```typescript");
    expect(result).toContain("function f(): void");
  });

  it("shows methods when available", () => {
    const result = formatSymbolDetail(makeSymbol({
      name: "Service",
      kind: "class",
      methods: [{ name: "doStuff", jsdoc: "Does stuff", signature: "doStuff(): void", deprecation: undefined }],
    }));
    expect(result).toContain("### Methods");
    expect(result).toContain("doStuff");
    expect(result).toContain("Does stuff");
  });
});
