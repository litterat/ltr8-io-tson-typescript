import { describe, expect, it } from 'vitest';

import { writeDataValue } from '../src/write/astWriter.js';
import { resolvedOutput } from '../src/schema/resolvedOutput.js';
import { canonicalizeIdentity } from '../src/link/identity.js';
import type { LinkedSchema } from '../src/link/link.js';
import { standardLibrary } from '../src/stdlib/index.js';

/**
 * [TSON-SCHEMA] §8.1: a resolved schema written as data -- the root `!schema` map, each entry its value
 * under the constructor that built it, each nested map `!meta.schema` with its members named beneath it
 * (§4.1), and the derived `@meta.synthetic` and `@meta.application` at the keys that carry them (§8.2).
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
    expect(text).toMatch(/flag => !enum \{/u);
  });

  it('names the applied constructor from the entry, never from the body: a set is `!meta.set_type`', () => {
    const text = written('tags => set<text>');
    expect(text).toMatch(/tags => !meta\.set_type \{/u);
    expect(text).not.toMatch(/tags => !meta\.array/u);
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

  it('marks what the resolver minted `@meta.synthetic` at its key, and an application `@meta.application` (§8.2)', () => {
    const text = written(
      'box => <T> { v: T }\nboxed => box<text>\nitem => { a: text }\nlist => { xs: [item] }',
    );
    expect(text).toMatch(/@meta\.application:box<text> boxed =>/u);
    expect(text).toMatch(/@meta\.synthetic array_item_[0-9a-f]{8} =>/u);
  });

  it('writes a free-text value quoted and a bare keyword bare, the void sentinel `_` never bare', () => {
    const text = written(
      'code => !text ^ { pattern: "[A-Z]+" }\nslug => !unicode.identifier_type { continue_add: "_" }',
    );
    expect(text).toMatch(/pattern: "\[A-Z\]\+"/u);
  });
});
