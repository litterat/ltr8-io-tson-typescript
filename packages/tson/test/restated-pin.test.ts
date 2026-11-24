import { describe, expect, it } from 'vitest';

import { TsonSchemaValidationError } from '../src/core/errors.js';
import type { LinkedSchema } from '../src/link/link.js';
import { standardLibrary } from '../src/stdlib/index.js';

/**
 * [TSON-SCHEMA] §5.8: a restatement may change a default and MUST NOT change a pin, the two compared under the
 * field type's own equality (§5.5).
 */

function link(body: string): LinkedSchema {
  return standardLibrary().resolveSchema(
    '!!id:"https://example.test/pin.tn"\n' +
      '!!import:"https://tson.io/2026/40/m/meta.tn"\n' +
      '!!import:"https://tson.io/2026/40/m/core.tn"\n' +
      `!schema ${body}`,
  );
}

function refused(body: string): string {
  try {
    link(body);
  } catch (error) {
    if (error instanceof TsonSchemaValidationError) return error.message;
    throw error;
  }
  throw new Error('expected the schema to be refused');
}

describe('a restatement may not change a pin (§5.8)', () => {
  it('§5.8: a restatement changing a pin is refused', () => {
    expect(
      refused(`{
        base => { name: text  pet_type: text = "pet" }
        dog  => base & { pet_type: = "dog" }
      }`),
    ).toContain(
      "'dog': not a valid restatement of 'base''s fields (§5.8): field 'pet_type' is pinned to \"pet\" and restated as \"dog\"",
    );
  });

  it('§5.8: a pin changed further down a chain is refused', () => {
    expect(
      refused(`{
        base  => { kind?: text ~ "any" }
        dog   => base & { kind?: = "dog" }
        puppy => dog & { kind?: = "puppy" }
      }`),
    ).toContain(
      "'puppy': not a valid restatement of 'dog''s fields (§5.8): field 'kind' is pinned to \"dog\" and restated as \"puppy\"",
    );
  });

  it('§5.8, §5.10: a pin absorbed from an application is not changed', () => {
    expect(
      refused(`{
        boxed => <T> { v: T  tag: text = "box" }
        other => boxed<int32> & { tag: = "other" }
      }`),
    ).toContain(
      "'other': not a valid restatement of 'boxed<int32>''s fields (§5.8): field 'tag' is pinned to \"box\" and restated as \"other\"",
    );
  });

  it("§5.8, §5.10: a parametric record's changed pin is refused at its declaration, applied or not", () => {
    const records = `
        base  => { tag: text = "base" }
        boxed => <T> base & { v: T  tag: = "boxed" }
      `;
    for (const applier of ['', '  b => boxed<int32>\n']) {
      expect(refused(`{${records}${applier}}`)).toContain(
        "'boxed': not a valid restatement of 'base''s fields (§5.8): field 'tag' is pinned to \"base\" and restated as \"boxed\"",
      );
    }
  });

  it('§5.8, §5.10: a pin changed over an application over a parameter is refused at the declaration', () => {
    expect(
      refused(`{
        box  => <T> { v: T  tag: text = "box" }
        wrap => <T> box<T> & { tag: = "x" }
      }`),
    ).toContain(
      "'wrap': not a valid restatement of 'box<T>''s fields (§5.8): field 'tag' is pinned to \"box\" and restated as \"x\"",
    );
  });

  it('§5.8, §5.10: whether a restated type narrows stays with the application', () => {
    expect(() =>
      link(`{
        box  => <T> { v: T }
        wrap => <T> box<T> & { v: int32 }
        ok   => wrap<int32>
      }`),
    ).not.toThrow();
  });

  it('§5.8: a numeric pin restated as another value is refused, and as another spelling of it is not', () => {
    expect(refused('{ x => { n?: int32 = 255 }  y => x & { n?: = 254 } }')).toContain(
      "field 'n' is pinned to 255 and restated as 254",
    );
    expect(() => link('{ x => { n?: int32 = 255 }  y => x & { n?: = 0xFF } }')).not.toThrow();
  });

  it('§5.8, §5.5: a text pin compares as the field type compares it', () => {
    expect(() =>
      link('{ x => { n?: text = "caf\u00e9" }  y => x & { n?: = "cafe\u0301" } }'),
    ).not.toThrow();
  });

  it('§5.5, §5.8: the identity restatement is admitted under the field type equality', () => {
    expect(() =>
      link(`{
        base    => { pet_type: text = "pet"  mask: uint8 = 0xFF  kind?: text ~ "any" }
        same    => base & { pet_type: = pet  mask: = 255 }
        retyped => base & { pet_type: text = "pet" }
        dog     => base & { kind?: = "dog" }
      }`),
    ).not.toThrow();
  });
});
