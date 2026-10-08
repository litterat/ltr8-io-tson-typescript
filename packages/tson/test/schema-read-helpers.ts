/**
 * Test-only helpers for the schema-reading tests: load a schema through the public
 * front door and read a document with the text reader and the JSON reader, so a rule both
 * encodings read is held to the same answer.
 */
import { compile, validate } from '../src/compiler/compile.js';
import { compileJsonSchema } from '../src/json/schema/compile.js';
import { validateJson } from '../src/json/facade.js';
import { standardLibrary } from '../src/stdlib/index.js';
import type { LinkedSchema } from '../src/link/link.js';

let counter = 0;

/** A schema document around `body`, with a fresh `!!id`. */
export function schemaSource(body: string, header = ''): Uint8Array {
  const source = `!!id:"https://example.test/schema${String(counter++)}.tn"\n!!meta:"https://tson.io/2026/37/m/meta.tn"\n!!import:"https://tson.io/2026/37/m/core.tn"\n${header}\n{\n${body}\n}\n`;
  return new TextEncoder().encode(source);
}

/** Loads `body` through `createTson`'s public path; throws what a refusal throws. */
export function load(body: string, header = ''): LinkedSchema {
  return standardLibrary().resolveSchema(schemaSource(body, header));
}

/** The message of the error loading `body` raises, or undefined when it loads. */
export function loadError(body: string, header = ''): string | undefined {
  try {
    load(body, header);
    return undefined;
  } catch (error) {
    const e = error as { message?: string; diagnostics?: readonly { message: string }[] };
    return [e.message ?? String(error), ...(e.diagnostics ?? []).map((d) => d.message)].join(' | ');
  }
}

/** Diagnostic codes of reading `doc` as `root` in the text reader. */
export function textCodes(linked: LinkedSchema, root: string, doc: string): string[] {
  return validate(compile(linked), root, new TextEncoder().encode(doc)).diagnostics.map(
    (d) => d.code,
  );
}

/** Diagnostic codes of reading `doc` as `root` in the JSON reader. */
export function jsonCodes(linked: LinkedSchema, root: string, doc: string): string[] {
  return validateJson(doc, { schema: compileJsonSchema(linked), root }).diagnostics.map(
    (d) => d.code,
  );
}

/** Diagnostic messages in the text reader. */
export function textMessages(linked: LinkedSchema, root: string, doc: string): string[] {
  return validate(compile(linked), root, new TextEncoder().encode(doc)).diagnostics.map(
    (d) => d.message,
  );
}

/** Diagnostic messages in the JSON reader. */
export function jsonMessages(linked: LinkedSchema, root: string, doc: string): string[] {
  return validateJson(doc, { schema: compileJsonSchema(linked), root }).diagnostics.map(
    (d) => d.message,
  );
}
