/**
 * A port of the Java reference's `TemplateFamilyEncodingParityTest`
 * (`tson-json/src/test/java/io/ltr8/tson/json/TemplateFamilyEncodingParityTest.java`) -- a
 * template family base dispatches the same way in both encodings ([TSON-JSON] §9.4, [TSON-SCHEMA]
 * §5.10): a record-bodied template carries `extension`, so a value at a position typed by it is a
 * value of one of its instantiations, selected by the discriminators where the base is SEALED and
 * by a tag where it is ABSTRACT.
 *
 * Two schemas, one per base shape, each its own `describe` block -- matching the Java class's own
 * `SEALED`/`ABSTRACT` constants. As `json-cross-encoding-parity.test.ts`'s own top note explains,
 * `sameRule` here compares the code and the data pointer, not `expected`/`message`.
 */
import { describe, expect, it } from 'vitest';

import type { Diagnostic } from '../src/core/diagnostic.js';
import { compile, type CompiledSchema } from '../src/compiler/compile.js';
import { validate as validateText } from '../src/facade/tree.js';
import { compileJsonSchema, type JsonCompiledSchema } from '../src/json/schema/compile.js';
import { validateJson } from '../src/json/facade.js';
import { resolveUserSchema } from './compiler-schema-fixtures.js';

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

/** The template itself is the base, SEALED by the surviving discriminator -- dispatch by the pin. */
const SEALED_SCHEMA = `
!!id:"https://example.test/tsealed.tn"
!!meta:"https://tson.io/2026/37/m/meta.tn"
!!import:"https://tson.io/2026/37/m/core.tn"
{
  dog_type => { breed: text }
  cat_type => { indoor: boolean }
  pet      => <T, V> { type?: text = T  value: V }
  dogpet   => pet<"dog", dog_type>
  catpet   => pet<"cat", cat_type>
  holder   => { p: pet }
}
`;

/** The template itself is the base, ABSTRACT for want of a discriminator -- dispatch by tag. */
const ABSTRACT_SCHEMA = `
!!id:"https://example.test/tabstract.tn"
!!meta:"https://tson.io/2026/37/m/meta.tn"
!!import:"https://tson.io/2026/37/m/core.tn"
{
  dog_type => { breed: text }
  cat_type => { indoor: boolean }
  pet      => <V> { value: V }
  dogpet   => pet<dog_type>
  catpet   => pet<cat_type>
  holder   => { p: pet }
}
`;

function compiledPair(source: string): { text: CompiledSchema; json: JsonCompiledSchema } {
  const linked = resolveUserSchema(source);
  return { text: compile(linked), json: compileJsonSchema(linked) };
}

const SEALED = compiledPair(SEALED_SCHEMA);
const ABSTRACT = compiledPair(ABSTRACT_SCHEMA);

function tson(schema: CompiledSchema, rootType: string, body: string): readonly Diagnostic[] {
  return validateText(bytesOf(body), { schema, root: rootType }).diagnostics;
}

function json(schema: JsonCompiledSchema, rootType: string, body: string): readonly Diagnostic[] {
  return validateJson(body, { schema, root: rootType }).diagnostics;
}

function verdictsOf(diagnostics: readonly Diagnostic[]): readonly { code: string; path: string }[] {
  return diagnostics.map((d) => ({ code: d.code, path: d.path ?? '?' }));
}

function bothAccept(
  pair: { text: CompiledSchema; json: JsonCompiledSchema },
  rootType: string,
  tsonBody: string,
  jsonBody: string,
): void {
  expect(
    tson(pair.text, rootType, tsonBody),
    'the TSON side refused a document it should take',
  ).toEqual([]);
  expect(
    json(pair.json, rootType, jsonBody),
    'the JSON side refused a document the TSON side took',
  ).toEqual([]);
}

function sameRule(
  pair: { text: CompiledSchema; json: JsonCompiledSchema },
  rootType: string,
  tsonBody: string,
  jsonBody: string,
): void {
  const fromTson = tson(pair.text, rootType, tsonBody);
  expect(
    fromTson.length,
    'the TSON side reported nothing, so this compares nothing',
  ).toBeGreaterThan(0);
  expect(verdictsOf(json(pair.json, rootType, jsonBody))).toEqual(verdictsOf(fromTson));
}

// ── SEALED: the pin selects, and no tag is written ─────────────────────────────────────────────

describe('SEALED: the pin selects, and no tag is written', () => {
  it('a sealed template base dispatches on its pin in both', () => {
    bothAccept(
      SEALED,
      'holder',
      '!holder { p: { type: "dog"  value: { breed: lab } } }',
      '{"p":{"type":"dog","value":{"breed":"lab"}}}',
    );
  });

  it('the other pin selects the other member in both', () => {
    bothAccept(
      SEALED,
      'holder',
      '!holder { p: { type: "cat"  value: { indoor: true } } }',
      '{"p":{"type":"cat","value":{"indoor":true}}}',
    );
  });
});

// ── ABSTRACT: a tag selects, and only a member's name is one ───────────────────────────────────

describe('ABSTRACT: a tag selects, and only a member’s name is one', () => {
  it('an abstract template base dispatches on the member tag in both', () => {
    bothAccept(
      ABSTRACT,
      'holder',
      '!holder { p: !dogpet { value: { breed: lab } } }',
      '{"p":{"$type":"dogpet","value":{"breed":"lab"}}}',
    );
  });

  it('a pin value ("dog") is not a type in either -- a tag naming it selects nothing, and both encodings must say so the same way', () => {
    sameRule(
      ABSTRACT,
      'holder',
      '!holder { p: !dog { value: { breed: lab } } }',
      '{"p":{"$type":"dog","value":{"breed":"lab"}}}',
    );
  });

  it('ABSTRACT has no direct instances, so the tag is not optional the way a SEALED base’s is', () => {
    sameRule(
      ABSTRACT,
      'holder',
      '!holder { p: { value: { breed: lab } } }',
      '{"p":{"value":{"breed":"lab"}}}',
    );
  });

  it('and the base’s own name selects nothing: it is the family, not a member of it', () => {
    sameRule(
      ABSTRACT,
      'holder',
      '!holder { p: !pet { value: { breed: lab } } }',
      '{"p":{"$type":"pet","value":{"breed":"lab"}}}',
    );
  });
});
