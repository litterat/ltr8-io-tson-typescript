import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fromBytes, runSync } from '../src/io/bytes.js';
import { parseSchemaDocument } from '../src/compiler/schemaParser.js';

/**
 * The six bundled schemas must parse. They are vendored under `spec/m/`, loaded at runtime, and
 * are what the resolver gate is measured against -- so a parser that cannot read them is not
 * usable, however many synthetic cases it passes.
 *
 * The reference implementation pins exactly this (`TsonSchemaParserTest`'s `metaKernelParses`,
 * `metaSchemaParses`, `coreTypeLibraryParses`). A declaration count here is the whole of one
 * document's schema map, a nested map's members included under their paths (§2.2.3, §4.1): the
 * kernel's six machinery maps `numeric`, `unicode`, `net`, `atom`, `meta` and `binary` hold 68 of
 * its 87.
 */
function parseBundled(name: string): { total: number; root: number; imports: number } {
  const path = fileURLToPath(new URL(`../../../spec/m/${name}`, import.meta.url));
  const document = runSync(parseSchemaDocument(fromBytes(new Uint8Array(readFileSync(path)))));
  const names = [...document.body.declarations.keys()];
  return {
    total: names.length,
    root: names.filter((declared) => !declared.includes('.')).length,
    imports: document.imports.length,
  };
}

describe('the bundled schemas parse (spec/m)', () => {
  it.each([
    ['meta.tn', 83, 19, 0],
    ['numeric.tn', 24, 17, 1],
    ['temporal.tn', 11, 6, 1],
    ['net.tn', 24, 13, 1],
    ['core.tn', 6, 6, 3],
    ['policy.tn', 7, 1, 1],
  ])('%s parses', (name, total, root, imports) => {
    expect(parseBundled(name)).toEqual({ total, root, imports });
  });
});
