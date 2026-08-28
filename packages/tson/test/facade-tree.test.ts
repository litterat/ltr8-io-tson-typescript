/**
 * `readTree`/`validate` -- schemaless (Class 1) and schema-governed, sync and streaming. The
 * schema-governed cases reuse `compiler-schema-fixtures.ts`'s own resolve/link pipeline
 * (`resolveUserSchema`) rather than restating it, since building a schema is not this suite's
 * own concern -- only whether the facade reads correctly once one exists.
 */
import { describe, expect, it } from 'vitest';

import { readTree, validate } from '../src/facade/tree.js';
import { compile, type CompiledSchema } from '../src/compiler/compile.js';
import {
  TsonInternalError,
  TsonLexError,
  TsonNotImplementedError,
  TsonParseError,
  TsonReadError,
  TsonUnsupportedDocumentError,
} from '../src/core/errors.js';
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

describe('a collecting read never throws for a bad document', () => {
  // The reference implementation's own facade states this outright, and this port did not hold to
  // it: a base-syntax failure is raised by the lexer or the event stream before any ReadContext
  // exists to report through, so it went straight past the DiagnosticsCollector. A caller reaching
  // for `validate()` precisely because it "collects every problem and always returns a value" got
  // a throw for exactly the documents that made them reach for it.

  const MALFORMED: readonly (readonly [string, Uint8Array])[] = [
    ['an unclosed record', bytesOf('{ x: 1')],
    ['a value where a key belongs', bytesOf('{ : 1 }')],
    ['a trailing separator', bytesOf('[1 2 ,]')],
    ['malformed UTF-8', new Uint8Array([0x7b, 0x78, 0x3a, 0x20, 0xc3, 0x28, 0x7d])],
    ['a lone continuation byte', new Uint8Array([0x80])],
  ];

  it.each(MALFORMED)('validate collects %s as a diagnostic', (_name, bytes) => {
    const result = validate(bytes);
    expect(result.diagnostics).not.toHaveLength(0);
    expect(result.diagnostics[0]?.code).toBe('VALIDATION_ERROR');
    expect(result.value.kind).toBe('missing');
  });

  it('reports the position the underlying error already knew, rather than dropping it', () => {
    const result = validate(bytesOf('{ x: 1\n  y: }\n'));
    expect(result.diagnostics[0]?.dataPosition?.line).toBe(2);
  });

  it("gives the root value RFC 6901's own root pointer, not undefined", () => {
    // '' is a valid pointer meaning exactly "the document root"; undefined would mean "nowhere".
    const value = validate(bytesOf('{ x: 1')).value;
    expect(value).toMatchObject({ kind: 'missing', path: '' });
  });

  it('still refuses a declared encoding it will not read, as a diagnostic', () => {
    // TsonUnsupportedDocumentError is the third of the three, and reaches the collector the same
    // way -- a document this implementation will not read is a verdict on the document.
    const utf16 = new Uint8Array([0xff, 0xfe, 0x7b, 0x00, 0x7d, 0x00]);
    const result = validate(utf16);
    expect(result.diagnostics).not.toHaveLength(0);
  });

  it('readTree still fails fast, and as the one error type its contract names', () => {
    // Previously a TsonLexError/TsonParseError escaped here, which its own TSDoc never claimed.
    for (const [, bytes] of MALFORMED) {
      expect(() => readTree(bytes)).toThrow(TsonReadError);
    }
  });

  it('keeps the original error reachable as the cause, so nothing is lost by wrapping', () => {
    try {
      readTree(bytesOf('{ x: 1'));
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(TsonReadError);
      const cause = (error as TsonReadError).cause;
      expect(
        cause instanceof TsonParseError ||
          cause instanceof TsonLexError ||
          cause instanceof TsonUnsupportedDocumentError,
      ).toBe(true);
    }
  });

  it('does not turn a broken invariant into a verdict on the document', () => {
    // TsonInternalError means the bug is here. Reported as a diagnostic it would tell a caller
    // their input was bad, which is the one thing this catch must never do.
    const exploding = {
      read(): never {
        throw new TsonInternalError('deliberate');
      },
    };
    expect(() =>
      validate(bytesOf('{}'), {
        schema: { reader: () => exploding } as unknown as CompiledSchema,
        root: 'anything',
      }),
    ).toThrow(TsonInternalError);
  });
});

describe('a library gap reaches the collector as NOT_IMPLEMENTED, not as a verdict', () => {
  // `compiler/compile.ts` builds each entry's reader lazily -- a deliberate divergence from the
  // reference implementation's eager compile -- so a construct with no reader yet is discovered
  // only when a value of that type is read, past whatever receiver is in scope. It keeps its own
  // diagnostic code rather than folding into VALIDATION_ERROR because the two mean opposite
  // things: one says the document is bad, the other says this library is incomplete.
  const gap: CompiledSchema = {
    reader: () => ({
      read(): never {
        throw new TsonNotImplementedError('no reader for `!tuple` yet');
      },
    }),
  } as unknown as CompiledSchema;

  it('validate collects it, with the code that says whose fault it is', () => {
    const result = validate(bytesOf('{}'), { schema: gap, root: 'anything' });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      code: 'NOT_IMPLEMENTED',
      message: 'no reader for `!tuple` yet',
    });
    expect(result.value.kind).toBe('missing');
  });

  it('readTree still throws, with the original reachable as the cause', () => {
    try {
      readTree(bytesOf('{}'), { schema: gap, root: 'anything' });
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(TsonReadError);
      expect((error as TsonReadError).cause).toBeInstanceOf(TsonNotImplementedError);
    }
  });
});
