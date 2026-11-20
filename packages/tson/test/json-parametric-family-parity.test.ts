/**
 * A port of the Java reference's `ParametricFamilyEncodingParityTest`
 * (`tson-json/src/test/java/io/ltr8/tson/json/ParametricFamilyEncodingParityTest.java`) -- a family declared
 * through a parametric record dispatches the same way in both encodings ([TSON-JSON] §9.4, [TSON-SCHEMA] §5.10).
 * No position names a parametric record bare, so a family's base is a record: an abstract record a parametric
 * record composes, its members reaching it through the parametric record's written parent, or an abstract
 * parametric record's application, an abstract record carrying the parametric record's selector. A value at the
 * base's position is a value of one of its members, selected by the discriminators where the base states them and
 * by a tag where it states none.
 *
 * As `json-cross-encoding-parity.test.ts`'s own top note explains, `sameRule` here compares the code and the data
 * pointer, not `expected`/`message`.
 */
import { describe, expect, it } from 'vitest';

import type { Diagnostic } from '../src/core/diagnostic.js';
import { compile, type CompiledSchema } from '../src/compiler/compile.js';
import { validate as validateText } from '../src/facade/tree.js';
import { compileJsonSchema, type JsonCompiledSchema } from '../src/json/schema/compile.js';
import { validateJson } from '../src/json/facade.js';
import { resolveUserSchema } from './compiler-schema-fixtures.js';

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

/** An abstract record states the selector, a parametric record composes it, and each member pins it -- by the pin. */
const SEALED_SCHEMA = `
!!id:"https://example.test/tsealed.tn"
!!import:"https://tson.io/2026/40/m/core.tn"
!schema {
  dog_type => { breed: text }
  cat_type => { indoor: boolean }
  pet      => abstract { type: text =? }
  pet_of   => <V> pet & { value: V }
  dogpet   => pet_of<dog_type> & { type?: = "dog" }
  catpet   => pet_of<cat_type> & { type?: = "cat" }
  holder   => { p: pet }
}
`;

/** The base states no selector, and each member declares an application of the parametric record -- by tag. */
const ABSTRACT_SCHEMA = `
!!id:"https://example.test/tabstract.tn"
!!import:"https://tson.io/2026/40/m/core.tn"
!schema {
  dog_type => { breed: text }
  cat_type => { indoor: boolean }
  pet      => abstract { }
  pet_of   => <V> pet & { value: V }
  dogpet   => pet_of<dog_type>
  catpet   => pet_of<cat_type>
  holder   => { p: pet }
}
`;

/** The base is an abstract parametric record's application, carrying its selector -- by the pin. */
const APPLIED_SCHEMA = `
!!id:"https://example.test/tapplied.tn"
!!import:"https://tson.io/2026/40/m/core.tn"
!schema {
  pet      => abstract <V> { type: text =?  value: V }
  dogpet   => pet<text> & { type?: = "dog"  breed: text }
  catpet   => pet<text> & { type?: = "cat"  indoor: boolean }
  pet_text => pet<text>
  holder   => { p: pet_text }
}
`;

interface Pair {
  readonly text: CompiledSchema;
  readonly json: JsonCompiledSchema;
}

const compiled = new Map<string, Pair>();

/** `source` compiled once on first use, so a schema that fails to load fails each test that reads it. */
function pairOf(source: string): Pair {
  let pair = compiled.get(source);
  if (pair === undefined) {
    const linked = resolveUserSchema(source);
    pair = { text: compile(linked), json: compileJsonSchema(linked) };
    compiled.set(source, pair);
  }
  return pair;
}

function tson(schema: CompiledSchema, rootType: string, body: string): readonly Diagnostic[] {
  return validateText(bytesOf(body), { schema, root: rootType }).diagnostics;
}

function json(schema: JsonCompiledSchema, rootType: string, body: string): readonly Diagnostic[] {
  return validateJson(body, { schema, root: rootType }).diagnostics;
}

function verdictsOf(diagnostics: readonly Diagnostic[]): readonly { code: string; path: string }[] {
  return diagnostics.map((d) => ({ code: d.code, path: d.path ?? '?' }));
}

function bothAccept(source: string, rootType: string, tsonBody: string, jsonBody: string): void {
  const pair = pairOf(source);
  expect(
    tson(pair.text, rootType, tsonBody),
    'the TSON side refused a document it should take',
  ).toEqual([]);
  expect(
    json(pair.json, rootType, jsonBody),
    'the JSON side refused a document the TSON side took',
  ).toEqual([]);
}

function sameRule(source: string, rootType: string, tsonBody: string, jsonBody: string): void {
  const pair = pairOf(source);
  const fromTson = tson(pair.text, rootType, tsonBody);
  expect(
    fromTson.length,
    'the TSON side reported nothing, so this compares nothing',
  ).toBeGreaterThan(0);
  expect(verdictsOf(json(pair.json, rootType, jsonBody))).toEqual(verdictsOf(fromTson));
}

// ── SEALED: the pin selects, and no tag is written ─────────────────────────────────────────────

describe('SEALED: the pin selects, and no tag is written', () => {
  it('a sealed base through a parametric record dispatches on its pin in both', () => {
    bothAccept(
      SEALED_SCHEMA,
      'holder',
      '!holder { p: { type: "dog"  value: { breed: lab } } }',
      '{"p":{"type":"dog","value":{"breed":"lab"}}}',
    );
  });

  it('the other pin selects the other member in both', () => {
    bothAccept(
      SEALED_SCHEMA,
      'holder',
      '!holder { p: { type: "cat"  value: { indoor: true } } }',
      '{"p":{"type":"cat","value":{"indoor":true}}}',
    );
  });
});

// ── APPLIED: an abstract parametric record's application is the base ─────────────────────────

describe('APPLIED: an abstract parametric record’s application is the base, and the pin selects', () => {
  it('an abstract parametric record’s application dispatches on its pin in both', () => {
    bothAccept(
      APPLIED_SCHEMA,
      'holder',
      '!holder { p: { type: "cat"  value: x  indoor: true } }',
      '{"p":{"type":"cat","value":"x","indoor":true}}',
    );
  });

  it('a pin no member of the application states is one rule in both', () => {
    sameRule(
      APPLIED_SCHEMA,
      'holder',
      '!holder { p: { type: "bird"  value: x } }',
      '{"p":{"type":"bird","value":"x"}}',
    );
  });
});

// ── ABSTRACT: a tag selects, and only a member's name is one ───────────────────────────────────

describe('ABSTRACT: a tag selects, and only a member’s name is one', () => {
  it('an abstract base through a parametric record dispatches on the member tag in both', () => {
    bothAccept(
      ABSTRACT_SCHEMA,
      'holder',
      '!holder { p: !dogpet { value: { breed: lab } } }',
      '{"p":{"$type":"dogpet","value":{"breed":"lab"}}}',
    );
  });

  it('a pin value ("dog") is not a type in either -- a tag naming it selects nothing, and both encodings must say so the same way', () => {
    sameRule(
      ABSTRACT_SCHEMA,
      'holder',
      '!holder { p: !dog { value: { breed: lab } } }',
      '{"p":{"$type":"dog","value":{"breed":"lab"}}}',
    );
  });

  it('ABSTRACT has no direct instances, so the tag is not optional the way a SEALED base’s is', () => {
    sameRule(
      ABSTRACT_SCHEMA,
      'holder',
      '!holder { p: { value: { breed: lab } } }',
      '{"p":{"value":{"breed":"lab"}}}',
    );
  });

  it('and the base’s own name selects nothing: it is the family, not a member of it', () => {
    sameRule(
      ABSTRACT_SCHEMA,
      'holder',
      '!holder { p: !pet { value: { breed: lab } } }',
      '{"p":{"$type":"pet","value":{"breed":"lab"}}}',
    );
  });
});
