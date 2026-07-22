/* ------------------------------------------------------------------ */
/*  Parser unit tests                                                  */
/* ------------------------------------------------------------------ */

import { describe, it, expect } from "vitest";
import { parsePublicAPI } from "../parser.js";

describe("parsePublicAPI", () => {
  it("parses a class with JSDoc", () => {
    const source = `
/**
 * A user in the system.
 * @deprecated Use NewUser instead
 */
export class User {
  name: string;
  age: number;
}
`;
    const symbols = parsePublicAPI(source);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe("User");
    expect(symbols[0].kind).toBe("class");
    expect(symbols[0].jsdoc).toContain("A user in the system");
    expect(symbols[0].deprecation).toContain("Use NewUser instead");
  });

  it("parses an interface with JSDoc", () => {
    const source = `
/** Props for the button component. */
export interface ButtonProps {
  label: string;
  onClick: () => void;
}
`;
    const symbols = parsePublicAPI(source);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe("ButtonProps");
    expect(symbols[0].kind).toBe("interface");
  });

  it("parses a function with JSDoc", () => {
    const source = `
/** Greet a user by name. */
export function greet(name: string): string {
  return \`Hello \${name}\`;
}
`;
    const symbols = parsePublicAPI(source);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe("greet");
    expect(symbols[0].kind).toBe("function");
    expect(symbols[0].jsdoc).toContain("Greet a user");
  });

  it("parses a type alias with JSDoc", () => {
    const source = `
/** Configuration options. */
export type Config = {
  host: string;
  port: number;
};
`;
    const symbols = parsePublicAPI(source);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe("Config");
    expect(symbols[0].kind).toBe("type");
  });

  it("parses a const export with JSDoc", () => {
    const source = `
/** Default pagination limit. */
export const DEFAULT_LIMIT = 20;
`;
    const symbols = parsePublicAPI(source);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe("DEFAULT_LIMIT");
    expect(symbols[0].kind).toBe("variable");
  });

  it("parses enum with JSDoc", () => {
    const source = `
/** HTTP methods. */
export enum HttpMethod {
  GET,
  POST,
}
`;
    const symbols = parsePublicAPI(source);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe("HttpMethod");
    expect(symbols[0].kind).toBe("enum");
  });

  it("handles declaration files (declare function)", () => {
    const source = `
/** Create a new server instance. */
export declare function createServer(opts?: ServerOptions): Server;
`;
    const symbols = parsePublicAPI(source);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe("createServer");
    expect(symbols[0].kind).toBe("function");
  });

  it("handles CommonJS-style function", () => {
    const source = `
/**
 * Create an express application.
 */
function createApplication() {
  return {};
}
`;
    const symbols = parsePublicAPI(source);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe("createApplication");
  });

  it("captures symbols even without JSDoc", () => {
    const source = `
export const foo = 1;
export function bar() {}
`;
    const symbols = parsePublicAPI(source);
    expect(symbols).toHaveLength(2);
    expect(symbols[0].name).toBe("foo");
    expect(symbols[0].kind).toBe("variable");
    expect(symbols[0].jsdoc).toBe("");
    expect(symbols[1].name).toBe("bar");
    expect(symbols[1].kind).toBe("function");
  });

  it("parses multiple symbols", () => {
    const source = `
/** First class. */
export class A {}

/** Second class. */
export class B {}
`;
    const symbols = parsePublicAPI(source);
    expect(symbols).toHaveLength(2);
    expect(symbols[0].name).toBe("A");
    expect(symbols[1].name).toBe("B");
  });

  it("extracts @deprecated without reason", () => {
    const source = `
/** @deprecated */
export class OldClass {}
`;
    const symbols = parsePublicAPI(source);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].deprecation).toBeDefined();
  });

  it("extracts methods from class with JSDoc", () => {
    const source = `
/** Service for user operations. */
export class UserService {
  /** Find user by ID. */
  findById(id: string): User | null {
    return null;
  }
}
`;
    const symbols = parsePublicAPI(source);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].methods).toBeDefined();
    expect(symbols[0].methods!.length).toBeGreaterThanOrEqual(1);
    expect(symbols[0].methods![0].name).toBe("findById");
    expect(symbols[0].methods![0].jsdoc).toContain("Find user");
  });

  it("parses default exports", () => {
    const source = `
/** Default export. */
export default class DefaultClass {}
`;
    const symbols = parsePublicAPI(source);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe("DefaultClass");
    expect(symbols[0].kind).toBe("class");
  });

  it("handles empty source", () => {
    expect(parsePublicAPI("")).toHaveLength(0);
    expect(parsePublicAPI("// just a comment")).toHaveLength(0);
  });
});
