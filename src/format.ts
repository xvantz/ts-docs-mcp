/* ------------------------------------------------------------------ */
/*  Formatter — markdown output for LLM consumption                   */
/* ------------------------------------------------------------------ */

import type { PublicSymbol } from "./types.js";

/** Merge two symbol arrays, deduplicating by name. Prefers GitHub (first) over tarball (second). */
export function mergeSymbols(github: PublicSymbol[], tarball: PublicSymbol[]): PublicSymbol[] {
  const names = new Set<string>();
  const merged: PublicSymbol[] = [];
  for (const s of github) {
    if (!names.has(s.name)) {
      names.add(s.name);
      merged.push(s);
    }
  }
  for (const s of tarball) {
    if (!names.has(s.name)) {
      names.add(s.name);
      merged.push(s);
    }
  }
  return merged;
}

/** Clean a raw signature for display: remove leading 'export ', collapse whitespace, truncate. */
function cleanSignature(sig: string, maxLen = 120): string {
  return sig
    .replace(/^export\s+/, "")
    .replace(/^(declare\s+)?(async\s+)?/, "")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

/** Show a compact one-line entry for a symbol in the summary list. */
function symbolLine(item: PublicSymbol): string {
  const snippet = cleanSignature(item.signature, 80);

  if (item.deprecation) {
    const reason = item.deprecation.replace(/\s*@deprecated\s*/g, "").slice(0, 100);
    return `- ⚠️ **${item.name}** — *Deprecated:* ${reason}`;
  }

  if (item.jsdoc) {
    const firstLine = item.jsdoc.replace(/\n/g, " ").slice(0, 200);
    return `- **${item.name}** — ${firstLine}`;
  }

  return `- \`${item.name}\` — ${snippet}`;
}

/** Build a concise API overview grouped by symbol kind. */
export function toSummary(symbols: PublicSymbol[], pkgName: string, version: string, description: string): string {
  const lines: string[] = [];
  lines.push(`# ${pkgName} API v${version}`);
  if (description) lines.push(`> ${description}`);
  lines.push("");

  const perKind: Record<string, PublicSymbol[]> = {};
  for (const s of symbols) {
    if (!perKind[s.kind]) perKind[s.kind] = [];
    perKind[s.kind].push(s);
  }

  const order = ["class", "interface", "function", "enum", "type", "variable"];
  for (const kind of order) {
    const all = perKind[kind];
    if (!all?.length) continue;
    const plural = kind === "class" ? "Classes" : kind === "interface" ? "Interfaces" : kind === "function" ? "Functions" : kind === "type" ? "Type Aliases" : kind === "variable" ? "Variables" : `${kind}s`;
    const maxShow = 15;
    const items = all.slice(0, maxShow);
    lines.push(`## ${plural} (${all.length})${all.length > maxShow ? ` — showing ${maxShow}` : ""}\n`);

    for (const item of items) {
      lines.push(symbolLine(item));
    }
    lines.push("");
  }

  const totalShown = Object.values(perKind).reduce((acc, arr) => acc + Math.min(arr.length, 15), 0);
  if (totalShown < symbols.length) {
    lines.push(`*Showing ${totalShown} of ${symbols.length} symbols. Use \`query\` to find a specific symbol.*`);
  }

  return lines.join("\n");
}

/** Build a detailed page for a single symbol. */
export function formatSymbolDetail(item: PublicSymbol): string {
  const lines: string[] = [];
  lines.push(`## ${item.name} (${item.kind})`);
  if (item.deprecation) lines.push(`> ⚠️ *Deprecated:* ${item.deprecation}`);
  if (item.jsdoc) lines.push(`> ${item.jsdoc}`);
  lines.push("");
  lines.push(`\`\`\`typescript\n${item.signature}\n\`\`\``);
  lines.push("");

  if (item.methods && item.methods.length > 0) {
    const withJSDoc = item.methods.filter(m => m.jsdoc);
    lines.push("### Methods\n");
    for (const m of (withJSDoc.length > 0 ? withJSDoc : item.methods).slice(0, 25)) {
      if (m.jsdoc) {
        if (m.deprecation) lines.push(`> ⚠️ *Deprecated:* ${m.deprecation}`);
        lines.push(`> ${m.jsdoc}`);
      }
      lines.push(`- \`${m.signature.replace(/\n/g, " ").replace(/  +/g, " ").slice(0, 150)}\``);
    }
    if (item.methods.length > 25) {
      lines.push(`\n*… ${item.methods.length - 25} more methods*`);
    }
  }

  return lines.join("\n");
}
