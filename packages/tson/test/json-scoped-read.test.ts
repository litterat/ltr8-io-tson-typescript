/**
 * [TSON-JSON] §8.5's scoped positions, the open sum, read end to end: the value names its own type
 * in an annotation object, `$type` alone for the governing namespace (LOCAL) and `$schema` with
 * `$type` for a foreign one (EXTERN), and a value naming no type is refused in every mode. Core's
 * `declared`, `extern` and `dynamic`, and the `extern_of`/`extern_type` narrowings, share one
 * reader, so what is under test is the two constraint values and the annotation object's two
 * forms, not five code paths. `compiler-scoped-reader.test.ts` is the text peer.
 */
import { describe, expect, it } from 'vitest';

import { isVerdict, type Diagnostic } from '../src/core/diagnostic.js';
import { TsonSchemaFetchError } from '../src/core/errors.js';
import { canonicalizeIdentity } from '../src/link/identity.js';
import type { LinkedSchema } from '../src/link/link.js';
import { validateJson, validateJsonAsync } from '../src/json/facade.js';
import { compileJsonSchema } from '../src/json/schema/compile.js';
import { jsonValueToText } from '../src/json/write.js';
import { resolveUserSchema } from './compiler-schema-fixtures.js';

const CLAIM = 'https://example.test/json-scope-claim.tn';
const REPORT = 'https://example.test/json-scope-report.tn';
const WIDE = 'https://例え.test/注文.tn';
const LIBRARY = '/local/json-scope-orders.tn';

const PREAMBLE = (id: string): string => `!!id:"${id}"
!!meta:"https://tson.io/2026/37/m/meta.tn"
!!import:"https://tson.io/2026/37/m/core.tn"`;

const HOST_SCHEMA = `${PREAMBLE('https://example.test/json-scope-host.tn')}
{
  note      => { body: text }
  memo      => { body: text  urgent: boolean }
  count     => !integer ^ { min: 0  max: 9 }
  envelope  => { local: declared  foreign: extern  either: dynamic }
  narrowed  => { one: extern_of<"${CLAIM}"> }
  pinpoint  => { one: extern_type<"${CLAIM}", claim> }
  inbox     => { items: [extern] }
  routed    => { wide: extern_of<"${WIDE}">  library: extern_of<"${LIBRARY}"> }
}`;

const CLAIM_SCHEMA = `${PREAMBLE(CLAIM)}
{
  claim  => { id: text  amount: int32 }
  remark => { text: text }
  holder => { inner: claim }
}`;

const REPORT_SCHEMA = `${PREAMBLE(REPORT)}
{
  report => { study: text }
}`;

const ordersSchema = (id: string): string => `${PREAMBLE(id)}
{
  order => { n: int32 }
}`;

const registry = new Map<string, LinkedSchema>();
for (const source of [CLAIM_SCHEMA, REPORT_SCHEMA, ordersSchema(WIDE), ordersSchema(LIBRARY)]) {
  const linked = resolveUserSchema(source);
  registry.set(canonicalizeIdentity(linked.id), linked);
}
const host = resolveUserSchema(HOST_SCHEMA);
const COMPILED = compileJsonSchema(host, {
  foreignSchemas: (uri) => registry.get(canonicalizeIdentity(uri)),
});

const FOREIGN_REMARK = `{"$schema": "${CLAIM}", "$type": "remark", "text": "t"}`;
const NOTE = '{"$type": "note", "body": "b"}';

function envelope(local: string, foreign: string, either: string): string {
  return `{"local": ${local}, "foreign": ${foreign}, "either": ${either}}`;
}

function problems(root: string, json: string, compiled = COMPILED): readonly Diagnostic[] {
  return validateJson(json, { schema: compiled, root }).diagnostics;
}

function refusal(root: string, json: string, compiled = COMPILED): Diagnostic {
  const found = problems(root, json, compiled);
  expect(found.length, JSON.stringify(found)).toBe(1);
  const first = found[0];
  if (first === undefined) throw new Error('unreachable');
  return first;
}

function accepted(root: string, json: string): string {
  const result = validateJson(json, { schema: COMPILED, root });
  expect(result.diagnostics).toEqual([]);
  if (result.value === undefined) throw new Error('accepted a read with no value');
  return jsonValueToText(result.value);
}

describe('§8.5 LOCAL: $type alone names a type the governing schema declares', () => {
  it('a declared position takes any type the governing schema declares', () => {
    for (const local of [
      '{"$type": "note", "body": "hi"}',
      '{"$type": "memo", "body": "hi", "urgent": true}',
    ]) {
      expect(accepted('envelope', envelope(local, FOREIGN_REMARK, NOTE))).toMatch(
        /^\{"local":\{"body":"hi"/,
      );
    }
  });

  it('§3.3 the wrapper carries a value of any shape -- an atom from the governing namespace', () => {
    expect(
      problems(
        'envelope',
        envelope(
          '{"$type": "count", "$value": 7}',
          FOREIGN_REMARK,
          '{"$type": "int32", "$value": -1}',
        ),
      ),
    ).toEqual([]);
  });

  it('the selected type validates in full: its facets hold inside the wrapper', () => {
    const d = refusal(
      'envelope',
      envelope('{"$type": "count", "$value": 10}', FOREIGN_REMARK, NOTE),
    );
    expect(d.path?.startsWith('/local')).toBe(true);
  });

  it('a name the governing schema does not hold is UNKNOWN_TYPE', () => {
    const d = refusal(
      'envelope',
      envelope('{"$type": "claim", "id": "a", "amount": 1}', FOREIGN_REMARK, NOTE),
    );
    expect(d.code).toBe('UNKNOWN_TYPE');
    expect(d.path).toBe('/local');
  });
});

describe('§8.5 a value naming no type is a validation error in every mode', () => {
  it.each(['"hi"', '3', 'true', '[1, 2]', '{"body": "hi"}'])('bare value %s', (bare) => {
    const d = refusal('envelope', envelope(bare, FOREIGN_REMARK, NOTE));
    expect(d.code).toBe('VALIDATION_ERROR');
    expect(d.path).toBe('/local');
  });

  it('null is the void sentinel (§6.1.2), and a scoped field that is not voidable refuses it as missing', () => {
    expect(refusal('envelope', envelope('null', FOREIGN_REMARK, NOTE)).code).toBe('FIELD_REQUIRED');
  });

  it('an annotation object without $type names no type either', () => {
    expect(refusal('envelope', envelope('{"$value": 1}', FOREIGN_REMARK, NOTE)).code).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('a $type that is not a string names no type either', () => {
    expect(
      refusal('envelope', envelope('{"$type": 1, "$value": 1}', FOREIGN_REMARK, NOTE)).code,
    ).toBe('VALIDATION_ERROR');
  });
});

describe('§8.5 EXTERN: $schema opens a scope for the annotated value alone', () => {
  it('the foreign type is read by the foreign schema, inline where it reads the value as a record', () => {
    const text = accepted(
      'envelope',
      envelope(
        '{"$type": "note", "body": "hi"}',
        `{"$schema": "${CLAIM}", "$type": "claim", "id": "C-1", "amount": 450}`,
        NOTE,
      ),
    );
    expect(text).toContain('"foreign":{"id":"C-1","amount":450}');
  });

  it('and wrapped, for which a record is as good a value as any other', () => {
    expect(
      problems(
        'envelope',
        envelope(
          '{"$type": "note", "body": "hi"}',
          `{"$schema": "${CLAIM}", "$type": "claim", "$value": {"id": "C-1", "amount": 450}}`,
          NOTE,
        ),
      ),
    ).toEqual([]);
  });

  it('the foreign value validates in full against the foreign schema, and its diagnostic says so', () => {
    const d = refusal(
      'envelope',
      envelope(
        '{"$type": "note", "body": "hi"}',
        `{"$schema": "${CLAIM}", "$type": "claim", "id": "C-1"}`,
        NOTE,
      ),
    );
    expect(d.code).toBe('FIELD_REQUIRED');
    expect(d.path).toBe('/foreign/amount');
    expect(d.schemaId).toBe(canonicalizeIdentity(CLAIM));
  });

  it('everything below the pushed value resolves in the foreign schema', () => {
    expect(
      problems(
        'envelope',
        envelope(
          '{"$type": "note", "body": "hi"}',
          `{"$schema": "${CLAIM}", "$type": "holder", "inner": {"id": "C-1", "amount": 1}}`,
          NOTE,
        ),
      ),
    ).toEqual([]);
  });

  it('dynamic holds both cells', () => {
    expect(
      problems(
        'envelope',
        envelope('{"$type": "note", "body": "hi"}', FOREIGN_REMARK, FOREIGN_REMARK),
      ),
    ).toEqual([]);
  });

  it('a heterogeneous [extern] array: each element opens its own scope', () => {
    expect(
      problems(
        'inbox',
        `{"items": [
          {"$schema": "${CLAIM}", "$type": "claim", "id": "C-1", "amount": 1},
          {"$schema": "${REPORT}", "$type": "report", "study": "RAD-9"}
        ]}`,
      ),
    ).toEqual([]);
  });

  it('a $schema member inside the foreign value, at a position that is not scoped, is SCOPE_NOT_ADMITTED (§3.3, [TSON-SCHEMA] §7.8)', () => {
    const d = refusal(
      'envelope',
      envelope(
        '{"$type": "note", "body": "hi"}',
        `{"$schema": "${CLAIM}", "$type": "holder",
          "inner": {"$schema": "${CLAIM}", "$type": "claim", "id": "C-1", "amount": 1}}`,
        NOTE,
      ),
    );
    expect(d.code).toBe('SCOPE_NOT_ADMITTED');
    expect(d.path).toBe('/foreign/inner/$schema');
  });

  it('$schema leads (§3.3): one after $type is misplaced, and the object is not read as a scope push', () => {
    const found = problems(
      'envelope',
      envelope(
        '{"$type": "note", "body": "hi"}',
        `{"$type": "claim", "$schema": "${CLAIM}", "id": "C-1", "amount": 1}`,
        NOTE,
      ),
    );
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]?.path).toBe('/foreign');
  });
});

describe('§8.5 the cells an instance does not hold', () => {
  it('a declared position refuses a scope push as a validation error', () => {
    const d = refusal('envelope', envelope(FOREIGN_REMARK, FOREIGN_REMARK, NOTE));
    expect(d.code).toBe('VALIDATION_ERROR');
    expect(d.path).toBe('/local');
  });

  it('an extern position requires a scope push', () => {
    const d = refusal(
      'envelope',
      envelope('{"$type": "note", "body": "hi"}', '{"$type": "note", "body": "hi"}', NOTE),
    );
    expect(d.code).toBe('VALIDATION_ERROR');
    expect(d.path).toBe('/foreign');
  });

  it('a scope push naming no $type is a validation error', () => {
    const d = refusal(
      'envelope',
      envelope(
        '{"$type": "note", "body": "hi"}',
        `{"$schema": "${CLAIM}", "id": "C-1", "amount": 1}`,
        NOTE,
      ),
    );
    expect(d.code).toBe('VALIDATION_ERROR');
  });

  it('a $schema that is not a string names no schema (§3.2)', () => {
    const d = refusal(
      'envelope',
      envelope(
        '{"$type": "note", "body": "hi"}',
        '{"$schema": 1, "$type": "claim", "id": "C-1", "amount": 1}',
        NOTE,
      ),
    );
    expect(d.code).toBe('TYPE_MISMATCH');
    expect(d.path).toBe('/foreign/$schema');
  });
});

describe('§5.10 extern_of and extern_type each mint their own entry', () => {
  it('three applications differing only in their `schemas` map are three entries, not one', () => {
    const bodies = [...host.entries.values()]
      .map((d) => d.body)
      .filter((b): b is Extract<typeof b, { kind: 'scoped' }> => 'kind' in b && b.kind === 'scoped')
      .filter((b) => b.schemas !== undefined);
    const keys = new Set(bodies.map((b) => JSON.stringify([...(b.schemas ?? [])])));
    expect(keys.size).toBeGreaterThanOrEqual(4);
  });
});

describe('§8.5 narrowing: schemas is a closed set, matched by canonical identity', () => {
  it('extern_of admits its schema and no other', () => {
    expect(
      problems('narrowed', `{"one": {"$schema": "${CLAIM}", "$type": "remark", "text": "t"}}`),
    ).toEqual([]);
    // Canonical identity: the scheme is not part of it ([TSON-DATA] §2.2.1).
    expect(
      problems(
        'narrowed',
        `{"one": {"$schema": "${CLAIM.replace('https:', 'http:')}", "$type": "remark", "text": "t"}}`,
      ),
    ).toEqual([]);
    expect(
      refusal('narrowed', `{"one": {"$schema": "${REPORT}", "$type": "report", "study": "s"}}`)
        .code,
    ).toBe('VALIDATION_ERROR');
  });

  it('extern_type admits its type and no other', () => {
    expect(
      problems(
        'pinpoint',
        `{"one": {"$schema": "${CLAIM}", "$type": "claim", "id": "C-1", "amount": 1}}`,
      ),
    ).toEqual([]);
    expect(
      refusal('pinpoint', `{"one": {"$schema": "${CLAIM}", "$type": "remark", "text": "t"}}`).code,
    ).toBe('VALIDATION_ERROR');
  });

  it('extern_of names a schema by any identity a document may carry: beyond US-ASCII, or path-only', () => {
    expect(
      problems(
        'routed',
        `{"wide": {"$schema": "${WIDE}", "$type": "order", "n": 1},
          "library": {"$schema": "${LIBRARY}", "$type": "order", "n": 2}}`,
      ),
    ).toEqual([]);
  });
});

describe('§8.5 reaching the foreign schema is not a verdict on the document', () => {
  const nowhere = `{"$schema": "https://example.test/nowhere.tn", "$type": "claim", "id": "C-1"}`;

  it('a schema nothing supplies is SCHEMA_NOT_FOUND', () => {
    const d = refusal('envelope', envelope('{"$type": "note", "body": "hi"}', nowhere, NOTE));
    expect(d.code).toBe('SCHEMA_NOT_FOUND');
    expect(isVerdict(d.code)).toBe(false);
  });

  it('a lookup that throws a fetch failure reports that failure’s own code', () => {
    const compiled = compileJsonSchema(host, {
      foreignSchemas: (uri) => {
        throw new TsonSchemaFetchError(uri, 'timeout', 'too slow');
      },
    });
    const d = refusal(
      'envelope',
      envelope('{"$type": "note", "body": "hi"}', nowhere, NOTE),
      compiled,
    );
    expect(d.code).toBe('SCHEMA_TIMEOUT');
    expect(isVerdict(d.code)).toBe(false);
  });

  it('a compile with no lookup behind it reaches no foreign schema: SCHEMA_NOT_PERMITTED', () => {
    const standalone = compileJsonSchema(host);
    const d = refusal(
      'envelope',
      envelope('{"$type": "note", "body": "hi"}', FOREIGN_REMARK, NOTE),
      standalone,
    );
    expect(d.code).toBe('SCHEMA_NOT_PERMITTED');
    expect(isVerdict(d.code)).toBe(false);
  });

  it('a type the foreign schema does not declare is UNKNOWN_TYPE, named against that schema', () => {
    const d = refusal(
      'envelope',
      envelope(
        '{"$type": "note", "body": "hi"}',
        `{"$schema": "${CLAIM}", "$type": "note", "body": "hi"}`,
        NOTE,
      ),
    );
    expect(d.code).toBe('UNKNOWN_TYPE');
    expect(d.expected).toContain('claim');
  });

  it('only the unreachable value goes without a verdict: siblings still read on', () => {
    const found = problems('envelope', envelope('{"$type": "count", "$value": 10}', nowhere, NOTE));
    expect(found.map((d) => d.code).sort()).toEqual(
      ['SCHEMA_NOT_FOUND', expect.any(String)].sort(),
    );
  });
});

describe('§8.5 streaming: async equals sync at every byte split', () => {
  const documents = [
    envelope(
      '{"$type": "memo", "body": "hi", "urgent": true}',
      `{"$schema": "${CLAIM}", "$type": "claim", "$value": {"id": "C-1", "amount": 450}}`,
      FOREIGN_REMARK,
    ),
    envelope('{"$type": "note", "body": "hi"}', '{"$type": "note", "body": "hi"}', NOTE),
    envelope('"bare"', `{"$schema": "https://example.test/nowhere.tn", "$type": "x"}`, NOTE),
  ];

  async function* chunks(parts: readonly Uint8Array[]): AsyncGenerator<Uint8Array> {
    for (const part of parts) {
      await Promise.resolve();
      yield part;
    }
  }

  it('every document reads to the same verdicts and value at every split', async () => {
    for (const doc of documents) {
      const bytes = new TextEncoder().encode(doc);
      const sync = validateJson(bytes, { schema: COMPILED, root: 'envelope' });
      for (let at = 0; at <= bytes.length; at += 1) {
        const parts = [bytes.slice(0, at), bytes.slice(at)].filter((c) => c.length > 0);
        const split = await validateJsonAsync(chunks(parts), {
          schema: COMPILED,
          root: 'envelope',
        });
        expect(
          split.diagnostics.map((d) => [d.code, d.path]),
          `split at ${String(at)} of ${doc}`,
        ).toEqual(sync.diagnostics.map((d) => [d.code, d.path]));
        expect(split.value === undefined, `split at ${String(at)}`).toBe(sync.value === undefined);
        if (split.value !== undefined && sync.value !== undefined) {
          expect(jsonValueToText(split.value)).toBe(jsonValueToText(sync.value));
        }
      }
    }
  });
});
