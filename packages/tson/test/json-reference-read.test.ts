/**
 * A position typed by a reference ([TSON-SCHEMA] §4.2, §5.12) read from JSON ([TSON-JSON] §5.6).
 * A reference over a constructor holds type names, and one over any other type holds the qualified
 * name of a value of the governing schema; either way the JSON form is a string holding the text
 * TSON writes unquoted, read by the same production and judged by what the name reaches. The case
 * sets of the Java reference's `JsonTypeNameRefReadTest` and `JsonValueRefReadTest`, the host
 * bindings (`Ref`, `TypeRef` and `String` components) excepted: this package reads into a JSON
 * tree, so a bound class has nowhere to land.
 */
import { describe, expect, it } from 'vitest';

import type { Diagnostic } from '../src/core/diagnostic.js';
import { validateJson } from '../src/json/facade.js';
import { compileJsonSchema, type JsonCompiledSchema } from '../src/json/schema/compile.js';
import { resolveUserSchema } from './compiler-schema-fixtures.js';

function problems(schema: JsonCompiledSchema, root: string, json: string): readonly Diagnostic[] {
  return validateJson(json, { schema, root }).diagnostics;
}

function only(found: readonly Diagnostic[]): Diagnostic {
  expect(found.length, `expected exactly one problem, got ${JSON.stringify(found)}`).toBe(1);
  const first = found[0];
  if (first === undefined) throw new Error('unreachable');
  return first;
}

// ── §5.6 a reference that names types ───────────────────────────────────────────────────────

const TYPE_NAMES = compileJsonSchema(
  resolveUserSchema(`
!!id:"https://example.test/json-kinds.tn"
!!import:"https://tson.io/2026/40/m/core.tn"
!schema {
  stock_id    => !net.uuid_type {}
  customer_id => !net.uuid_type {}
  sku         => text
  ledger      => { named: meta.ref<net.uuid_type> }
}
`),
);

describe('§5.6 a position typed by meta.ref<constructor> holds type names', () => {
  const ledger = (json: string): readonly Diagnostic[] => problems(TYPE_NAMES, 'ledger', json);

  it('a string naming a member is admitted', () => {
    expect(ledger('{"named": "stock_id"}')).toEqual([]);
    expect(ledger('{"named": "uuid"}')).toEqual([]);
  });

  it('the name of a type built with another constructor is refused as no member', () => {
    const refusal = only(ledger('{"named": "sku"}'));
    expect(refusal.code).toBe('ATOM_CONSTRAINT_VIOLATION');
    expect(refusal.path).toBe('/named');
    expect(refusal.message).toContain('is not a member of this kind');
  });

  it('a value of a member is no name', () => {
    expect(only(ledger('{"named": "7d3e5f8a-1b2c-4d5e-8f90-a1b2c3d4e5f6"}')).code).toBe(
      'ATOM_FORM_INVALID',
    );
  });

  it('a reference is an atom read from a string, so a tagged object is the wrong JSON kind, not a member', () => {
    expect(
      only(
        ledger(
          '{"named": {"$type": "stock_id", "$value": "7d3e5f8a-1b2c-4d5e-8f90-a1b2c3d4e5f6"}}',
        ),
      ).code,
    ).toBe('TYPE_MISMATCH');
  });
});

// ── §5.12 a reference that names values ─────────────────────────────────────────────────────

const VALUE_NAMES = compileJsonSchema(
  resolveUserSchema(`
!!id:"https://example.test/json-picks.tn"
!!import:"https://tson.io/2026/40/m/core.tn"
!schema {
  order     => { id: text }
  customer  => { name: text }
  orders    => !meta.namespace { key_type: meta.identifier  value_type: order }
  order_ref => meta.ref<order>
  pick      => { which: order_ref }
  o1        => !order { id: A-1 }
  c1        => !customer { name: Ada }
  book      => !orders { first => { id: B-1 } }
}
`),
);

describe('§5.12 a position typed by a reference over a non-constructor holds the name of a value', () => {
  const pick = (name: string): readonly Diagnostic[] =>
    problems(VALUE_NAMES, 'pick', `{"which": "${name}"}`);

  it('a name is judged by what it reaches, a nested value included', () => {
    expect(pick('o1')).toEqual([]);
    expect(pick('book.first')).toEqual([]);
  });

  it('a name reaching nothing, a value of another type, a type, or a missing member is refused at the field', () => {
    for (const refused of ['nope', 'c1', 'order', 'book.second']) {
      const found = pick(refused);
      expect(
        found.map((d) => d.code),
        refused,
      ).toEqual(['ATOM_CONSTRAINT_VIOLATION']);
      expect(found[0]?.path, refused).toBe('/which');
    }
  });
});
