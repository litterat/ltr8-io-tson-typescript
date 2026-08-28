/**
 * `readTree`/`validate` -- schemaless (Class 1) and schema-governed, sync and streaming. The
 * schema-governed cases reuse `compiler-schema-fixtures.ts`'s own resolve/link pipeline
 * (`resolveUserSchema`) rather than restating it, since building a schema is not this suite's
 * own concern -- only whether the facade reads correctly once one exists.
 */
import { describe, expect, it } from 'vitest';

import { readTree, validate } from '../src/facade/tree.js';
import { compile, type CompiledSchema } from '../src/compiler/compile.js';
import { TsonReadError } from '../src/core/errors.js';
import type { LinkedSchema } from '../src/link/link.js';
import { resolveUserSchema } from './compiler-schema-fixtures.js';

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

async function* chunksOf(text: string, size: number): AsyncGenerator<Uint8Array> {
  const bytes = bytesOf(text);
  await Promise.resolve();
  for (let i = 0; i < bytes.length; i += size) {
    yield bytes.subarray(i, i + size);
  }
}

describe('readTree/validate: schemaless (Class 1)', () => {
  it('reads a record synchronously with no options', () => {
    const value = readTree(bytesOf('{ x: 1 y: "two" }'));
    expect(value.kind).toBe('record');
  });

  it('reads an array as an ArrayNode -- schemaless has no tuple distinction', () => {
    const value = readTree(bytesOf('[1 2 3]'));
    expect(value.kind).toBe('array');
  });

  it('throws a structural error for malformed syntax, synchronously', () => {
    expect(() => readTree(bytesOf('{ x: '))).toThrow();
  });

  it('throws TsonReadError, fail-fast, for a reported problem (an unresolvable type-ref)', () => {
    expect(() => readTree(bytesOf('!nope 1'))).toThrow(TsonReadError);
  });

  it('validate collects rather than throwing, an empty document being no problem at all', () => {
    const result = validate(bytesOf('{}'));
    expect(result.diagnostics).toEqual([]);
    expect(result.value.kind).toBe('record');
  });

  it('reads identically over a chunked async source', async () => {
    const whole = readTree(bytesOf('{ x: 1 y: [1 2 3] }'));
    const chunked = await readTree(chunksOf('{ x: 1 y: [1 2 3] }', 4));
    expect(chunked).toEqual(whole);
  });

  it('preserveUnknownTypeRefs keeps an unresolvable type-ref rather than reporting it', () => {
    const reported = validate(bytesOf('!nope 1'));
    expect(reported.diagnostics).not.toEqual([]);
    const kept = validate(bytesOf('!nope 1'), { preserveUnknownTypeRefs: true });
    expect(kept.diagnostics).toEqual([]);
  });
});

describe('readTree/validate: schema-governed', () => {
  const SCHEMA = `
!!id:"test://catalog.tn"
!!meta:"https://tson.io/2026/33/m/meta.tn"
!!import:"https://tson.io/2026/33/m/core.tn"
{
  reading => { id: uuid label: non_empty_text }
}
`;
  const linked: LinkedSchema = resolveUserSchema(SCHEMA);
  const compiled: CompiledSchema = compile(linked);

  const CONFORMING = bytesOf('{ id: "f81d4fae-7dec-11d0-a765-00a0c91e6bf6" label: "north ridge" }');

  it('reads a conforming document as a record, its typeRef the entry name', () => {
    const value = readTree(CONFORMING, { schema: compiled, root: 'reading' });
    expect(value).toMatchObject({ kind: 'record', typeRef: 'reading' });
  });

  it('validate collects a constraint violation rather than throwing', () => {
    const result = validate(bytesOf('{ id: "f81d4fae-7dec-11d0-a765-00a0c91e6bf6" label: "" }'), {
      schema: compiled,
      root: 'reading',
    });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({ code: 'ATOM_CONSTRAINT_VIOLATION' });
  });

  it('readTree throws TsonReadError for the same violation', () => {
    expect(() =>
      readTree(bytesOf('{ id: "f81d4fae-7dec-11d0-a765-00a0c91e6bf6" label: "" }'), {
        schema: compiled,
        root: 'reading',
      }),
    ).toThrow(TsonReadError);
  });

  it('reads identically over a chunked async source', async () => {
    const whole = readTree(CONFORMING, { schema: compiled, root: 'reading' });
    const chunkedText = new TextDecoder().decode(CONFORMING);
    const chunked = await readTree(chunksOf(chunkedText, 5), { schema: compiled, root: 'reading' });
    expect(chunked).toEqual(whole);
  });
});
