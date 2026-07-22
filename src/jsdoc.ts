/* ------------------------------------------------------------------ */
/*  JSDoc parsing — extracts structured info from /** comments        */
/* ------------------------------------------------------------------ */

import type { PublicSymbol } from "./types.js";

export interface JSDocInfo {
  description: string;
  params: string;
  returns: string;
  deprecation: string | undefined;
  examples: string;
  endLine: number;
}

/** Parse a JSDoc block into structured info. Preserves @param, @returns, @deprecated, @example. */
export function parseJSDocBlock(lines: string[], endLine: number): JSDocInfo {
  const cleaned = lines.map(l =>
    l.replace(/^\s*\/\*\*?\s?/, "")
     .replace(/\s*\*\/$/, "")
     .replace(/^\s*\*\s?/, "")
  );

  const descParts: string[] = [];
  const paramLines: string[] = [];
  let returns = "";
  let deprecation: string | undefined;
  let exampleParts: string[] = [];
  let inExample = false;

  for (const line of cleaned) {
    const trimmed = line.trim();
    if (trimmed.startsWith("@param ")) {
      paramLines.push(trimmed);
      inExample = false;
    } else if (trimmed.startsWith("@returns ") || trimmed.startsWith("@return ")) {
      returns = trimmed;
      inExample = false;
    } else if (trimmed.startsWith("@deprecated")) {
      deprecation = trimmed.replace(/^@deprecated\s*/, "").trim() || "true";
      inExample = false;
    } else if (trimmed.startsWith("@example")) {
      inExample = true;
    } else if (trimmed.startsWith("@")) {
      inExample = false;
    } else if (inExample) {
      exampleParts.push(trimmed);
    } else if (trimmed) {
      descParts.push(trimmed);
    }
  }

  return {
    description: descParts.join(" ").trim(),
    params: paramLines.join("\n"),
    returns,
    deprecation: deprecation || undefined,
    examples: exampleParts.join("\n"),
    endLine,
  };
}

/** Combine all JSDoc parts into a single docstring. */
export function fullJSDoc(info: JSDocInfo): string {
  const parts: string[] = [];
  if (info.description) parts.push(info.description);
  if (info.params) parts.push(info.params);
  if (info.returns) parts.push(info.returns);
  if (info.examples) parts.push("@example\n" + info.examples);
  return parts.join("\n");
}

/** Find JSDoc blocks that end N lines before a given line. */
export function findJSDocBefore(jsdocs: JSDocInfo[], lineIdx: number, lookback = 5): JSDocInfo | null {
  let best: JSDocInfo | null = null;
  for (const j of jsdocs) {
    if (j.endLine >= lineIdx - lookback && j.endLine < lineIdx) {
      if (!best || j.endLine > best.endLine) best = j;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/*  Legacy helpers (kept for backward compat)                          */
/* ------------------------------------------------------------------ */

/** Simple JSDoc text extraction (no @tags). */
export function parseJSDoc(jsdocLines: string[]): string {
  return jsdocLines
    .map(l => l.replace(/^\s*\*\s?/, "").replace(/^\s*\/\*\*?\s?/, "").replace(/\s*\*\/$/, ""))
    .filter(l => l.trim() && !l.trim().startsWith("@"))
    .join(" ")
    .trim();
}

/** Extract deprecation notice from JSDoc lines. */
export function extractDeprecation(jsdocLines: string[]): string | undefined {
  for (const l of jsdocLines) {
    const trimmed = l.trim();
    if (trimmed.includes("@deprecated")) {
      return trimmed.replace(/^\s*\*\s*@deprecated\s*/, "").trim();
    }
  }
  return undefined;
}
