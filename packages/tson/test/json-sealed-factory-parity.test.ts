/**
 * A port of the Java reference's `SealedFactoryEncodingParityTest`
 * (`tson-json/src/test/java/io/ltr8/tson/json/SealedFactoryEncodingParityTest.java`) -- a sealed
 * family whose members a subtype-template factory mints reads alike in both encodings
 * ([TSON-JSON] §9.4): the pin a factory writes from a type parameter (`kind: = T`) places a value
 * exactly as a hand-written pin does, and a payload nested under a single field is read the same
 * way in both.
 *
 * The shape is distinct from `json-cross-encoding-parity.test.ts`'s own template-family cases:
 * here the base is a closed `abstract` record and every member is minted, which is what puts
 * [TSON-SCHEMA] §5.7's fixation on the dispatch path -- `kind: = T` is an ordinary REQUIRED_FIXED
 * field of the closed member by the time either encoding reads it.
 *
 * As `json-cross-encoding-parity.test.ts`'s own top note explains, this port's `sameRule` compares
 * the code and the data pointer, not `expected`/`message`: each stack's prose is independently
 * authored, never literally shared the way the Java reference's `base.diagnostics` makes a handful
 * of its own.
 */
import { describe, expect, it } from 'vitest';

import type { Diagnostic } from '../src/core/diagnostic.js';
import { compile, type CompiledSchema } from '../src/compiler/compile.js';
import { validate as validateText } from '../src/facade/tree.js';
import { compileJsonSchema, type JsonCompiledSchema } from '../src/json/schema/compile.js';
import { validateJson } from '../src/json/facade.js';
import { resolveUserSchema } from './compiler-schema-fixtures.js';

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

const SCHEMA_SOURCE = `
!!id:"https://example.test/sealed-factory.tn"
!!meta:"https://tson.io/2026/37/m/meta.tn"
!!import:"https://tson.io/2026/37/m/core.tn"
{
  msg    => abstract { kind: text =? }
  msg_of => <T, V> msg & { kind?: = T  body: V }

  ping_body => { seq: int32 }
  pong_body => { seq: int32  latency: int32 }

  ping => msg_of<"ping", ping_body>
  pong => msg_of<"pong", [pong_body]>

  channel => { m: msg }
}
`;

const LINKED = resolveUserSchema(SCHEMA_SOURCE);
const JSON_SCHEMA: JsonCompiledSchema = compileJsonSchema(LINKED);
const TEXT_SCHEMA: CompiledSchema = compile(LINKED);

function tson(rootType: string, body: string): readonly Diagnostic[] {
  return validateText(bytesOf(body), { schema: TEXT_SCHEMA, root: rootType }).diagnostics;
}

function json(rootType: string, body: string): readonly Diagnostic[] {
  return validateJson(body, { schema: JSON_SCHEMA, root: rootType }).diagnostics;
}

function verdictsOf(diagnostics: readonly Diagnostic[]): readonly { code: string; path: string }[] {
  return diagnostics.map((d) => ({ code: d.code, path: d.path ?? '?' }));
}

function bothAccept(rootType: string, tsonBody: string, jsonBody: string): void {
  expect(tson(rootType, tsonBody), 'the TSON side refused a document it should take').toEqual([]);
  expect(json(rootType, jsonBody), 'the JSON side refused a document the TSON side took').toEqual(
    [],
  );
}

function sameRule(rootType: string, tsonBody: string, jsonBody: string): void {
  const fromTson = tson(rootType, tsonBody);
  expect(
    fromTson.length,
    'the TSON side reported nothing, so this compares nothing',
  ).toBeGreaterThan(0);
  expect(verdictsOf(json(rootType, jsonBody))).toEqual(verdictsOf(fromTson));
}

describe('a sealed family a subtype-template factory mints', () => {
  it('the pin the factory wrote from T selects the member, with no tag in either encoding', () => {
    bothAccept(
      'channel',
      '!channel { m: { kind: ping  body: { seq: 1 } } }',
      '{"m":{"kind":"ping","body":{"seq":1}}}',
    );
  });

  it('the other member, whose payload is a container -- minted over a synthetic of its own', () => {
    bothAccept(
      'channel',
      '!channel { m: { kind: pong  body: [ { seq: 1  latency: 7 } ] } }',
      '{"m":{"kind":"pong","body":[{"seq":1,"latency":7}]}}',
    );
  });

  it('a pin no member states is one rule in both -- so the acceptance above is a dispatch, not a pass-through', () => {
    sameRule(
      'channel',
      '!channel { m: { kind: nope  body: { seq: 1 } } }',
      '{"m":{"kind":"nope","body":{"seq":1}}}',
    );
  });

  it('and the selected member validates in full: a field its payload requires is still missing', () => {
    sameRule(
      'channel',
      '!channel { m: { kind: ping  body: { } } }',
      '{"m":{"kind":"ping","body":{}}}',
    );
  });
});
