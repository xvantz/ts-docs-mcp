/* ------------------------------------------------------------------ */
/*  Types — shared interfaces for ts-docs-mcp                         */
/* ------------------------------------------------------------------ */

/** Info about an npm package resolved from the registry. */
export interface PackageInfo {
  name: string;
  version: string;
  description: string;
  owner: string;
  repo: string;
  sourceHint: string | null;
  typesHint: string | null;
  tarballUrl: string | null;
}

/** A parsed public API symbol with its JSDoc documentation. */
export interface PublicSymbol {
  name: string;
  kind: "class" | "interface" | "function" | "type" | "variable" | "enum" | "namespace";
  jsdoc: string;
  signature: string;
  deprecation?: string;
  methods?: { name: string; jsdoc: string; signature: string; deprecation?: string }[];
}

/** Result of fetching a source file from GitHub. */
export interface SourceFile {
  content: string;
  path: string;
}
