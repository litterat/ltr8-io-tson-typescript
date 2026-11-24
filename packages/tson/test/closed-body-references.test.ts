import { describe, expect, it } from 'vitest';

import { compile, validate } from '../src/compiler/compile.js';
import type { LinkedSchema } from '../src/link/link.js';
import { encodeUtf8 } from '../src/io/utf8.js';
import { standardLibrary } from '../src/stdlib/index.js';
import { fieldTypeName, namespaceEntry } from './linked-entries.js';

/**
 * A type slot of a namespace type closes an application where it is written (§4.2, §5.10): `value_type`'s
 * `{ of: !meta.apply { head: box  arguments: [text] } }` -- the explicit spelling, an argument list being schema
 * grammar no data value spells ([TSON-DATA] §7.2.5) -- stays in place, the substituted record held in a
 * `meta.type_inline` recording the application. A slot that holds a name alone -- a reference's `of` -- takes no
 * application and no type written in place.
 */

const SCHEMA_HEAD = `!!id:"https://example.test/closed-body-refs.tn"
!!import:"https://tson.io/2026/40/m/meta.tn"
!schema {
  box => <T> { v: T }
`;

function link(declarations: string): LinkedSchema {
  return standardLibrary().resolveSchema(`${SCHEMA_HEAD}  ${declarations}
}`);
}

describe('a type slot closes an application in place (§4.2, §5.10)', () => {
  it('a namespace type’s value_type holds the closed application in place, so a value of it reads against the record', () => {
    const linked = link(`
      api => !meta.namespace { key_type: meta.identifier  value_type: { of: !meta.apply { head: box  arguments: [text] } } }
      use => { f: api }`);
    const valueType = namespaceEntry(linked, 'api').valueType;
    expect(valueType.kind).toBe('inline');
    if (valueType.kind !== 'inline' || valueType.of.kind !== 'record') {
      throw new Error('value_type is no record written in place');
    }
    expect(valueType.application?.head.name).toBe('box');
    expect(fieldTypeName(valueType.of, 'v')).toBe('text');
    const compiled = compile(linked);
    expect(validate(compiled, 'use', encodeUtf8('{ f: { a => { v: "s" } } }')).diagnostics).toEqual(
      [],
    );
    expect(
      validate(compiled, 'use', encodeUtf8('{ f: { a => { v: [x] } } }')).diagnostics.length,
    ).toBeGreaterThan(0);
  });
});

describe('a slot holding a name takes no application (§4.2)', () => {
  it('a reference’s `of` naming an application is refused: the form is declared and named', () => {
    expect(() => link('r => meta.ref<box<text>>')).toThrow();
  });

  it('a reference’s `of` holding a type written in place is refused', () => {
    expect(() => link('r => meta.ref<[box<text>]>')).toThrow();
  });
});
