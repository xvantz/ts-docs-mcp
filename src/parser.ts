/* ------------------------------------------------------------------ */
/*  Parser — extract JSDoc + declarations from TypeScript source      */
/* ------------------------------------------------------------------ */

import type { PublicSymbol } from "./types.js";

/* ------------------------------------------------------------------ */
/*  JSDoc parsing                                                      */
/* ------------------------------------------------------------------ */

interface JSDocInfo {
  description: string;
  params: string;
  returns: string;
  deprecation: string | undefined;
  examples: string;
  endLine: number;
}

function parseJSDocBlock(lines: string[], endLine: number): JSDocInfo {
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

/* ------------------------------------------------------------------ */
/*  Declaration matching                                               */
/* ------------------------------------------------------------------ */

interface DeclMatch {
  name: string;
  kind: string;
}

function tryMatchDeclaration(line: string): DeclMatch | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) return null;

  // Order matters — more specific first

  // export default class/function/interface/type/enum
  let m = trimmed.match(/^(?:export\s+)?default\s+(class|function|interface|type|enum)\s+(\w+)/);
  if (m) return { name: m[2], kind: m[1] };

  // export class/interface/function/type/enum/const/let/var
  m = trimmed.match(/^(?:export\s+)?(?:declare\s+)?(class|interface|function|type|enum|const|let|var)\s+(\w+)/);
  if (m) return { name: m[2], kind: m[1] };

  // declare (no export) — .d.ts style
  m = trimmed.match(/^declare\s+(class|interface|function|type|enum|const|let|var|namespace)\s+(\w+)/);
  if (m) return { name: m[2], kind: m[1] };

  // declare module "name" — .d.ts pattern
  m = trimmed.match(/^declare\s+module\s+["']([^"']+)["']/);
  if (m) return { name: m[1], kind: "namespace" };

  // export declare function/class/interface
  m = trimmed.match(/^export\s+declare\s+(class|interface|function)\s+(\w+)/);
  if (m) return { name: m[2], kind: m[1] };

  // plain function foo(... — CJS-style
  m = trimmed.match(/^(?:async\s+)?function\s+(\w+)\s*\(/);
  if (m) return { name: m[1], kind: "function" };

  // plain class Foo — CJS-style
  m = trimmed.match(/^class\s+(\w+)/);
  if (m) return { name: m[1], kind: "class" };

  return null;
}

function normalizeKind(kind: string): PublicSymbol["kind"] {
  switch (kind) {
    case "const": case "let": case "var": return "variable";
    default: return kind as PublicSymbol["kind"];
  }
}

/* ------------------------------------------------------------------ */
/*  Line skipping & signature collection                               */
/* ------------------------------------------------------------------ */

/** Skip empty lines and //-comments. Returns index of first non-empty line, or lines.length. */
function skipEmpty(lines: string[], i: number): number {
  while (i < lines.length) {
    const t = lines[i].trim();
    if (t && !t.startsWith("//") && !t.startsWith("*")) break;
    i++;
  }
  return i;
}

/**
 * Collect the full declaration signature starting at line startIdx.
 * Returns [signature, nextLineIndex]. nextLineIndex points to the line
 * AFTER the signature (or after the opening brace for class/interface).
 * Signature is null when no declaration found.
 */
function collectSignature(lines: string[], startIdx: number): [string | null, number] {
  let i = skipEmpty(lines, startIdx);
  if (i >= lines.length) return [null, i];

  const firstLine = lines[i];
  let sig = firstLine;
  i++;

  // If the declaration already ends with { (body starts), don't go further
  if (firstLine.trim().endsWith("{")) {
    return [sig.trim(), i];
  }

  while (i < lines.length) {
    const t = lines[i].trim();

    // Stop at comments, JSDoc, empty
    if (!t || t.startsWith("//") || t.startsWith("/**") || t.startsWith("*/") || t.startsWith("*")) break;

    // Standalone opening brace — body starts next
    if (t === "{") break;

    sig += " " + t;

    // Stop at statement boundaries
    if (t.endsWith(";") || t.endsWith("{") || t.endsWith("}")) break;

    i++;
  }

  return [sig.trim(), i];
}

/** Count opening minus closing braces. */
function braceDelta(s: string): number {
  return (s.match(/\{/g) || []).length - (s.match(/\}/g) || []).length;
}

/**
 * Collect the body of a class/interface (everything inside outer braces).
 * initialDepth — brace depth already consumed from the signature line.
 */
function collectBody(lines: string[], startIdx: number, initialDepth = 0): [string[], number] {
  let depth = initialDepth;
  let i = startIdx;

  // Skip to opening brace if not already past it
  if (depth === 0) {
    while (i < lines.length) {
      depth += braceDelta(lines[i]);
      if (depth > 0) { i++; break; }
      i++;
    }
  }

  if (depth <= 0) return [[], i];

  const bodyLines: string[] = [];
  while (i < lines.length) {
    const delta = braceDelta(lines[i]);
    const nextDepth = depth + delta;

    if (nextDepth <= 0 && delta < 0) {
      // Closing brace for the outer body — stop before it
      break;
    }

    bodyLines.push(lines[i]);
    depth = nextDepth;
    i++;
  }

  return [bodyLines, i + 1]; // skip past the closing brace
}

/* ------------------------------------------------------------------ */
/*  Method parsing (inside class/interface body)                       */
/* ------------------------------------------------------------------ */

function parseBodyMethods(bodyLines: string[]): PublicSymbol["methods"] {
  const methods: PublicSymbol["methods"] = [];
  let i = 0;

  while (i < bodyLines.length) {
    const line = bodyLines[i].trim();

    if (!line || line.startsWith("//") || line.startsWith("*")) {
      i++;
      continue;
    }

    // Method with JSDoc
    if (line.startsWith("/**")) {
      const jsdocLines: string[] = [bodyLines[i]];
      let j: number;

      if (line.endsWith("*/")) {
        j = i; // single-line JSDoc
      } else {
        j = i + 1;
        while (j < bodyLines.length && !bodyLines[j].trim().endsWith("*/")) {
          jsdocLines.push(bodyLines[j]);
          j++;
        }
        if (j < bodyLines.length) jsdocLines.push(bodyLines[j]);
      }
      const info = parseJSDocBlock(jsdocLines, j);
      i = j + 1;

      // Declaration after JSDoc
      if (i < bodyLines.length) {
        const dl = bodyLines[i].trim();
        const mm = dl.match(/^(\w+)\s*(?:\(|[:=])/);
        if (mm && !mm[1].startsWith("_") && mm[1] !== "constructor") {
          methods.push({ name: mm[1], jsdoc: info.description, signature: dl.slice(0, 150), deprecation: info.deprecation });
        }
        i++;
      }
      continue;
    }

    // Plain method (no JSDoc)
    const mm = line.match(/^(\w+)\s*(?:\(|[:=]|$)/);
    if (mm && !mm[1].startsWith("_") && mm[1] !== "constructor") {
      if (!methods.find(m => m.name === mm[1]) && methods.length < 30) {
        methods.push({ name: mm[1], jsdoc: "", signature: line.slice(0, 200), deprecation: undefined });
      }
    }

    i++;
  }

  return methods;
}

/* ------------------------------------------------------------------ */
/*  JSDoc lookback                                                     */
/* ------------------------------------------------------------------ */

function findJSDocBefore(jsdocs: JSDocInfo[], lineIdx: number, lookback = 5): JSDocInfo | null {
  let best: JSDocInfo | null = null;
  for (const j of jsdocs) {
    if (j.endLine >= lineIdx - lookback && j.endLine < lineIdx) {
      if (!best || j.endLine > best.endLine) best = j;
    }
  }
  return best;
}

/** Combine all JSDoc parts into a single docstring. */
function fullJSDoc(info: JSDocInfo): string {
  const parts: string[] = [];
  if (info.description) parts.push(info.description);
  if (info.params) parts.push(info.params);
  if (info.returns) parts.push(info.returns);
  if (info.examples) parts.push("@example\n" + info.examples);
  return parts.join("\n");
}

/* ------------------------------------------------------------------ */
/*  Main parser                                                        */
/* ------------------------------------------------------------------ */

export function parsePublicAPI(source: string): PublicSymbol[] {
  const lines = source.split("\n");
  const symbols: PublicSymbol[] = [];
  const seen = new Set<string>();
  const allJSDocs: JSDocInfo[] = [];

  /* ---- Phase 1: JSDoc-attached declarations ---- */
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();

    if (line.startsWith("/**")) {
      const jsdocLines: string[] = [lines[i]];
      let j: number;

      if (line.endsWith("*/")) {
        // Single-line JSDoc — complete on this line
        j = i;
      } else {
        // Multi-line JSDoc — find the closing */
        j = i + 1;
        while (j < lines.length && !lines[j].trim().endsWith("*/")) {
          jsdocLines.push(lines[j]);
          j++;
        }
        if (j < lines.length) jsdocLines.push(lines[j]);
      }

      const jsdocInfo = parseJSDocBlock(jsdocLines, j);
      allJSDocs.push(jsdocInfo);
      i = j + 1;

      // Collect declaration after JSDoc
      const [signature, nextIdx] = collectSignature(lines, i);
      if (!signature) continue;

      i = emitSymbol(signature, nextIdx, jsdocInfo, lines, symbols, seen, true);
      continue;
    }

    i++;
  }

  /* ---- Phase 2: Catch declarations without JSDoc ---- */
  i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();

    // Skip JSDoc, comments, empty
    if (!line || line.startsWith("//") || line.startsWith("/**") || line.startsWith("*/") || line.startsWith("*") || line.startsWith("/*")) {
      i++;
      continue;
    }

    const match = tryMatchDeclaration(line);
    if (match && !seen.has(match.name)) {
      const [signature, nextIdx] = collectSignature(lines, i);
      if (!signature) { i++; continue; }

      const jsdoc = findJSDocBefore(allJSDocs, i);
      const emptyInfo: JSDocInfo = {
        description: jsdoc?.description ?? "",
        params: jsdoc?.params ?? "",
        returns: jsdoc?.returns ?? "",
        deprecation: jsdoc?.deprecation,
        examples: jsdoc?.examples ?? "",
        endLine: -1,
      };
      i = emitSymbol(signature, nextIdx, emptyInfo, lines, symbols, seen, false);
      continue;
    }

    i++;
  }

  return symbols;
}

/**
 * Parse a symbol from its signature and register it.
 * Returns the next line index to continue from.
 */
function emitSymbol(
  signature: string,
  nextIdx: number,
  jsdocInfo: JSDocInfo,
  lines: string[],
  symbols: PublicSymbol[],
  seen: Set<string>,
  fromPhase1: boolean
): number {
  const match = tryMatchDeclaration(signature);
  if (!match) return nextIdx;
  if (seen.has(match.name)) return nextIdx;

  seen.add(match.name);
  const kind = normalizeKind(match.kind);
  const braceDepth = braceDelta(signature);

  if (kind === "class" || kind === "interface") {
    const [bodyLines, afterBody] = collectBody(lines, nextIdx, braceDepth > 0 ? braceDepth : 0);
    const methods = parseBodyMethods(bodyLines);
    symbols.push({
      name: match.name,
      kind,
      jsdoc: fullJSDoc(jsdocInfo),
      signature,
      deprecation: jsdocInfo.deprecation,
      methods: methods && methods.length > 0 ? methods : undefined,
    });
    return afterBody;
  }

  // For namespaces / declare module: collect body and recursively parse inner declarations
  if (kind === "namespace") {
    const [bodyLines, afterBody] = collectBody(lines, nextIdx, braceDepth > 0 ? braceDepth : 0);
    if (bodyLines.length > 0) {
      const innerSource = bodyLines.join("\n");
      const innerSymbols = parsePublicAPI(innerSource);
      for (const s of innerSymbols) {
        if (!seen.has(s.name)) {
          seen.add(s.name);
          symbols.push(s);
        }
      }
    }
    // Still register the namespace itself
    symbols.push({
      name: match.name,
      kind: "namespace",
      jsdoc: fullJSDoc(jsdocInfo),
      signature,
      deprecation: jsdocInfo.deprecation,
    });
    return afterBody;
  }

  symbols.push({
    name: match.name,
    kind,
    jsdoc: fullJSDoc(jsdocInfo),
    signature,
    deprecation: jsdocInfo.deprecation,
  });

  return nextIdx;
}

/* ------------------------------------------------------------------ */
/*  Legacy exports for tests                                           */
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
