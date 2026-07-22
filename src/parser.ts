/* ------------------------------------------------------------------ */
/*  Parser — extract JSDoc + declarations from TypeScript source      */
/* ------------------------------------------------------------------ */

import type { PublicSymbol } from "./types.js";

/** Parse JSDoc + declarations from TypeScript source code. */
export function parsePublicAPI(source: string): PublicSymbol[] {
  const symbols: PublicSymbol[] = [];
  const lines = source.split("\n");

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();

    // Detect JSDoc comment
    if (line.startsWith("/**")) {
      let jsdocLines: string[] = [];
      while (i < lines.length && !lines[i].trim().startsWith("*/")) {
        jsdocLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        jsdocLines.push(lines[i]); // include */
        i++;
      }

      // Collect the declaration (until { or ; or next comment)
      let declLines: string[] = [];
      while (i < lines.length) {
        const dl = lines[i].trim();
        if (dl === "" || dl.startsWith("//")) { i++; continue; }
        declLines.push(lines[i]);
        if (dl === "{" || dl.endsWith("{") || dl.endsWith(";") ||
            dl.startsWith("/**") || dl.startsWith("*/")) {
          break;
        }
        i++;
      }

      const decl = declLines.join("\n").trim();
      const jsdoc = parseJSDoc(jsdocLines);
      const deprecation = extractDeprecation(jsdocLines);

      const classMatch = decl.match(/(?:export\s+)?(?:default\s+)?class\s+(\w+)/);
      const ifaceMatch = decl.match(/(?:export\s+)?(?:default\s+)?interface\s+(\w+)/);
      const funcMatch = decl.match(/(?:export\s+)?(?:default\s+)?function\s+(\w+)/);
      const typeMatch = decl.match(/(?:export\s+)?type\s+(\w+)/);
      const constMatch = decl.match(/(?:export\s+)?(?:const|let|var)\s+(\w+)/);
      const enumMatch = decl.match(/(?:export\s+)?(?:default\s+)?enum\s+(\w+)/);
      const plainFuncMatch = decl.match(/^(?:declare\s+)?(?:async\s+)?function\s+(\w+)/);

      if (classMatch) {
        symbols.push({
          name: classMatch[1], kind: "class", jsdoc, signature: decl,
          deprecation,
          methods: parseMethods(source, classMatch[1]),
        });
      } else if (ifaceMatch) {
        symbols.push({
          name: ifaceMatch[1], kind: "interface", jsdoc, signature: decl,
          deprecation,
          methods: parseMethods(source, ifaceMatch[1]),
        });
      } else if (funcMatch || plainFuncMatch) {
        const name = funcMatch?.[1] ?? plainFuncMatch![1];
        symbols.push({
          name, kind: "function", jsdoc, signature: decl,
          deprecation,
        });
      } else if (enumMatch) {
        symbols.push({
          name: enumMatch[1], kind: "enum", jsdoc, signature: decl,
          deprecation,
        });
      } else if (typeMatch) {
        symbols.push({
          name: typeMatch[1], kind: "type", jsdoc, signature: decl,
          deprecation,
        });
      } else if (constMatch) {
        symbols.push({
          name: constMatch[1], kind: "variable", jsdoc, signature: decl,
          deprecation,
        });
      }
    } else {
      i++;
    }
  }

  return symbols;
}

function parseJSDoc(jsdocLines: string[]): string {
  return jsdocLines
    .map(l => l.replace(/^\s*\*\s?/, "").replace(/^\s*\/\*\*?\s?/, "").replace(/\s*\*\/$/, ""))
    .filter(l => l.trim() && !l.trim().startsWith("@"))
    .join(" ")
    .trim();
}

function extractDeprecation(jsdocLines: string[]): string | undefined {
  for (const l of jsdocLines) {
    const trimmed = l.trim();
    if (trimmed.includes("@deprecated")) {
      return trimmed.replace(/^\s*\*\s*@deprecated\s*/, "").trim();
    }
  }
  return undefined;
}

/** Find methods on a class/interface by scanning its body. */
function parseMethods(source: string, className: string): { name: string; jsdoc: string; signature: string; deprecation?: string }[] {
  const methods: { name: string; jsdoc: string; signature: string; deprecation?: string }[] = [];
  const lines = source.split("\n");

  let inBody = false;
  let braceDepth = 0;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();
    if (line.includes(`class ${className}`) || line.includes(`interface ${className}`) ||
        line.includes(`${className}: core.$constructor`)) {
      inBody = true;
      braceDepth = 0;
      i++;
      continue;
    }

    if (inBody) {
      if (line.includes("{") || line.endsWith("{")) braceDepth++;
      if (line.includes("}") || line.startsWith("}")) {
        braceDepth--;
        if (braceDepth < 0) break;
        i++;
        continue;
      }

      if (braceDepth > 0 && (line.startsWith("/**") || line.startsWith("//"))) {
        let jsdocLines: string[] = [];
        let j = i;
        if (line.startsWith("/**")) {
          while (j < lines.length && !lines[j].trim().startsWith("*/")) {
            jsdocLines.push(lines[j]);
            j++;
          }
          if (j < lines.length) { jsdocLines.push(lines[j]); j++; }
        } else {
          jsdocLines = [line];
          j++;
        }

        let declLines: string[] = [];
        while (j < Math.min(j + 10, lines.length)) {
          const dl = lines[j].trim();
          declLines.push(lines[j]);
          if (dl === "{" || dl.endsWith("{")) break;
          j++;
        }

        const decl = declLines.join("\n").trim();
        const methodMatch = decl.match(/(?:(\w+)\s*[=:]\s*(?:\([^)]*\)\s*=>|[^;]+)|(\w+)\s*\([^)]*\))/);
        const methodName = methodMatch?.[1] ?? methodMatch?.[2];
        if (methodName && !methodName.startsWith("_") && methodName !== "constructor") {
          const jsdoc = parseJSDoc(jsdocLines);
          const deprecation = extractDeprecation(jsdocLines);
          methods.push({ name: methodName, jsdoc, signature: decl, deprecation });
        }

        i = j;
        continue;
      }

      const methodMatch = line.match(/^\s*(\w+)\s*(?:\(|[:=])/);
      if (methodMatch && !methodMatch[1].startsWith("_") && methodMatch[1] !== "constructor") {
        const name = methodMatch[1];
        const existing = methods.find(m => m.name === name);
        if (!existing && methods.length < 30) {
          methods.push({ name, jsdoc: "", signature: line, deprecation: undefined });
        }
      }
    }

    i++;
  }

  return methods;
}
