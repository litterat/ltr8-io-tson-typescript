import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fromBytes, runSync } from '../src/io/bytes.js';
import { parseSchemaDocument } from '../src/compiler/schemaParser.js';

/**
 * The three bundled schemas must parse. They are vendored under `spec/m/`, loaded at runtime, and
 * are what Wave 3's resolver gate is measured against — so a parser that cannot read them is not
 * usable, however many synthetic cases it passes.
 *
 * The reference implementation pins exactly this (`TsonSchemaParserTest`'s `metaKernelParses`,
 * `metaSchemaParses`, `coreTypeLibraryParses`). This port had no equivalent, which is how the
 * schema-grammar package reported green while `core.tn` failed to parse at line 105.
 */
function parseBundled(name: string): number {
  const path = fileURLToPath(new URL(`../../../spec/m/${name}`, import.meta.url));
  const document = runSync(parseSchemaDocument(fromBytes(new Uint8Array(readFileSync(path)))));
  return document.body.declarations.size;
}

describe('the bundled schemas parse (spec/m)', () => {
  it.each([
    ['meta-kernel.tn', 49],
    ['meta.tn', 30],
    ['core.tn', 48],
  ])('%s parses', (name, expectedDeclarations) => {
    expect(parseBundled(name)).toBe(expectedDeclarations);
  });
});
