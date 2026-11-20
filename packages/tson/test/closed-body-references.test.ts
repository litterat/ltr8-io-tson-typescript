import { describe, expect, it } from 'vitest';

import { compile, validate } from '../src/compiler/compile.js';
import type { LinkedSchema } from '../src/link/link.js';
import { encodeUtf8 } from '../src/io/utf8.js';
import { standardLibrary } from '../src/stdlib/index.js';
import {
  fieldTypeName,
  kindOfEntry,
  namespaceEntry,
  recordEntry,
  referenceEntry,
} from './linked-entries.js';

/**
 * The references a namespace type and a reference hold are rewritten as every other body's are
 * (§5.10, §8.2): materialisation closes an application in a namespace type's `key_type` and `value_type`, and
 * §8.2's synthetic merge renames a reference's `of` onto the entry it merged to.
 */

function link(declarations: string): LinkedSchema {
  return standardLibrary().resolveSchema(`!!id:"https://example.test/closed-body-refs.tn"
!!import:"https://tson.io/2026/40/m/meta.tn"
!schema {
  box => <T> { v: T }
  ${declarations}
}`);
}

describe('a body’s references close like every other body’s (§5.10, §8.2)', () => {
  it('a namespace type’s value_type closes its application, so a value of it reads against the record', () => {
    const linked = link(`
      api => !meta.namespace { key_type: meta.identifier  value_type: box<text> }
      use => { f: api }`);
    const api = namespaceEntry(linked, 'api');
    expect(api.valueType.arguments).toEqual([]);
    expect(fieldTypeName(recordEntry(linked, api.valueType.name), 'v')).toBe('text');
    const compiled = compile(linked);
    expect(validate(compiled, 'use', encodeUtf8('{ f: { a => { v: "s" } } }')).diagnostics).toEqual(
      [],
    );
    expect(
      validate(compiled, 'use', encodeUtf8('{ f: { a => { v: [x] } } }')).diagnostics.length,
    ).toBeGreaterThan(0);
  });

  it('a reference follows the merge of the synthetic it names', () => {
    const linked = link(`
      r      => meta.ref<[box<text>]>
      direct => { d: [box<text>] }`);
    const reference = referenceEntry(linked, 'r');
    expect(reference.of.name).toBe(fieldTypeName(recordEntry(linked, 'direct'), 'd'));
    expect(kindOfEntry(linked, reference.of.name)).toBe('array');
  });

  it('the same reference at a field’s type closes to a minted reference entry whose `of` names a live entry', () => {
    const linked = link('rec => { f: meta.ref<[box<text>]> }');
    const reference = referenceEntry(linked, fieldTypeName(recordEntry(linked, 'rec'), 'f'));
    expect(kindOfEntry(linked, reference.of.name)).toBe('array');
  });
});
