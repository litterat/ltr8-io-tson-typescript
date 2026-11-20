import { describe, expect, it } from 'vitest';

import { writeDataValue } from '../src/write/astWriter.js';
import { resolvedOutput } from '../src/schema/resolvedOutput.js';
import { canonicalizeIdentity } from '../src/link/identity.js';
import type { LinkedSchema } from '../src/link/link.js';
import { standardLibrary } from '../src/stdlib/index.js';

/**
 * [TSON-SCHEMA] §8.1: a resolved schema written as data -- the root `!schema` map, each entry its value
 * under the constructor that built it, each nested map `!meta.schema` with its members named beneath it
 * (§4.1), a type written in place where it is written (§4.2), and the derived `@meta.completion` and
 * `@meta.application` at the keys that carry them (§8.1, §8.2).
 */

const CORE = 'https://tson.io/2026/40/m/core.tn';

function written(source: string): string {
  const schema: LinkedSchema = standardLibrary().resolveSchema(
    `!!id:"https://example.test/out.tn"\n!!import:"${CORE}"\n!schema {\n${source}\n}\n`,
  );
  const own = canonicalizeIdentity(schema.id);
  return writeDataValue(
    resolvedOutput(schema, { own: (path) => schema.origins.get(path) === own }),
  );
}

describe('resolvedOutput (§8.1)', () => {
  it('writes the root as `!schema`, each type entry under the constructor that built it', () => {
    const text = written('point => { x: int32 }\nflag => !enum [on off]');
    expect(text.startsWith('!schema {')).toBe(true);
    expect(text).toMatch(/point => !meta\.record \{/u);
    expect(text).toMatch(/flag => !meta\.enum_type \{/u);
  });

  it('writes a completion as the plain construction, `@meta.completion` naming the incomplete entries it completed (§5.5, §8.1)', () => {
    const text = written('tags => set<text>\nflag => !enum [on off]');
    expect(text).toMatch(
      /@meta\.completion:\{ of: \[ meta\.set_type \] \} tags => !meta\.array \{/u,
    );
    expect(text).toMatch(/@meta\.completion:\{ of: \[ enum \] \} flag => !meta\.enum_type \{/u);
  });

  it('writes a nested schema map nested, tagged `!meta.schema`, its members under their own names (§4.1)', () => {
    const text = written(
      'geo => !schema {\n  address => { street: text }\n}\nhome => { a: geo.address }',
    );
    expect(text).toMatch(/geo => !meta\.schema \{/u);
    expect(text).toMatch(/address => !meta\.record \{/u);
    expect(text).not.toMatch(/geo\.address =>/u);
    expect(text).toMatch(/type: geo\.address/u);
  });

  it('writes a type in place where it is written, minting no entry, and marks no key `@meta.synthetic` (§4.2, §8.2)', () => {
    const text = written('item => { a: text }\nlist => { xs: [item] }');
    expect(text).toMatch(/xs => \{ type: \{ of: !meta\.array \{ element_type: item /u);
    expect(text).not.toMatch(/@meta\.synthetic/u);
    expect(text).not.toMatch(/_[0-9a-f]{8} =>/u);
  });

  it('marks a declared application `@meta.application` at its key (§8.2)', () => {
    const text = written('box => <T> { v: T }\nboxed => box<text>');
    expect(text).toMatch(/@meta\.application:\{ head: box arguments: \[ text \] \} boxed =>/u);
  });

  it('writes a free-text value quoted and a bare keyword bare, the void sentinel `_` never bare', () => {
    const text = written(
      'code => !text ^ { pattern: "[A-Z]+" }\nslug => !unicode.identifier_type { continue_add: "_" }',
    );
    expect(text).toMatch(/pattern: "\[A-Z\]\+"/u);
  });
});
