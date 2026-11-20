/**
 * A port of the Java reference's `SealedFactoryEncodingParityTest`
 * (`tson-json/src/test/java/io/ltr8/tson/json/SealedFactoryEncodingParityTest.java`) -- a sealed
 * family whose members compose an application of a parametric record reads alike in both encodings
 * ([TSON-JSON] §9.4): each member pins the selector where it is declared, a value differing per
 * application being written there and never taken from a parameter ([TSON-SCHEMA] §5.10), and a
 * payload nested under a single field is read the same way in both.
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
!!import:"https://tson.io/2026/40/m/core.tn"
!schema {
  msg    => abstract { kind: text =? }
  msg_of => <V> msg & { body: V }

  ping_body  => { seq: int32 }
  pong_body  => { seq: int32  latency: int32 }
  pong_bodies => [pong_body]

  ping => msg_of<ping_body> & { kind?: = "ping" }
  pong => msg_of<pong_bodies> & { kind?: = "pong" }

  channel => { m: msg }
}
`;

let schemas: { readonly text: CompiledSchema; readonly json: JsonCompiledSchema } | undefined;

/** The schema compiled once on first use, so a schema that fails to load fails each test that reads it. */
function compiled(): { readonly text: CompiledSchema; readonly json: JsonCompiledSchema } {
  if (schemas === undefined) {
    const linked = resolveUserSchema(SCHEMA_SOURCE);
    schemas = { text: compile(linked), json: compileJsonSchema(linked) };
  }
  return schemas;
}

function tson(rootType: string, body: string): readonly Diagnostic[] {
  return validateText(bytesOf(body), { schema: compiled().text, root: rootType }).diagnostics;
}

function json(rootType: string, body: string): readonly Diagnostic[] {
  return validateJson(body, { schema: compiled().json, root: rootType }).diagnostics;
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

describe('a sealed family whose members compose an application of a parametric record', () => {
  it('the pin a member writes selects it, with no tag in either encoding', () => {
    bothAccept(
      'channel',
      '!channel { m: { kind: ping  body: { seq: 1 } } }',
      '{"m":{"kind":"ping","body":{"seq":1}}}',
    );
  });

  it('the other member, whose payload is a container', () => {
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
