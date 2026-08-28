import { describe, expect, it } from 'vitest';
import { field, optional, record } from '../src/bind/combinators.js';
import type { AtomBinding, Binding, RecordBinding } from '../src/bind/binding.js';
import type { AtomEncoder } from '../src/bind/encode.js';
import { TsonWriteError } from '../src/core/errors.js';
import { defaultAtomEncoder, writeBinding } from '../src/write/bindingWriter.js';
import { fromString, runSync } from '../src/io/bytes.js';
import { parseDocument } from '../src/compiler/dataParser.js';

/**
 * `write/bindingWriter.ts` -- the bound-object writer, ported from `TsonObjectWriter.java`'s
 * public surface but built on `bind/encode.ts`'s `toDataValue` rather than walking the object
 * graph itself (this file's own top note explains why that seam is what keeps `write/` out of
 * `compiler/`). Every written document is also re-parsed with the real Tier 3 parser
 * (`compiler/dataParser.ts`), so a test here checks not just the text but that it is TSON at all.
 */

function atomBinding<T>(wireType: string): Binding<T> {
  return { kind: 'atom', wireType } as unknown as AtomBinding<T>;
}

function assertParses(text: string): void {
  expect(() => runSync(parseDocument(fromString(text)))).not.toThrow();
}

describe('defaultAtomEncoder -- stage 1, a wireType the built-in vocabulary recognises', () => {
  it("formats through that type's own atom, quoted or bare per its own rule", () => {
    // A plain (non-variant, non-annotated) atom binding writes no `!typeRef` of its own --
    // `bind/encode.ts`'s `toDataValue` only ever adds one for a variant member's discriminating
    // tag or an `AnnotatedBinding`'s framing (its own top note: "no schema in view, by design").
    // The binding, not the document, is what supplies the type on the way back in, so this is
    // a value round trip through the *same* binding, not a self-describing document.
    const INT32 = atomBinding<number>('int32');
    const UUID = atomBinding<{ bytes: Uint8Array }>('uuid');
    interface Row {
      readonly n: number;
      readonly id: { readonly bytes: Uint8Array };
    }
    const row: RecordBinding<Row> = record<Row>({
      fields: [field<Row, 'n'>(0, 'n', 'n', INT32), field<Row, 'id'>(1, 'id', 'id', UUID)],
      construct: ([n, id]) => ({ n: n as number, id: id as Row['id'] }),
    });
    const bytes = new Uint8Array([
      0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd,
      0xef,
    ]);
    const text = writeBinding(row, { n: 42, id: { bytes } });
    expect(text).toBe('{ n: 42 id: "01234567-89ab-cdef-0123-456789abcdef" }');
    assertParses(text);
  });
});

describe('defaultAtomEncoder -- stage 2, a wireType the built-in vocabulary does not recognise', () => {
  it("falls back to the value's own primitive JS type", () => {
    const CURRENCY = atomBinding<string>('currency');
    const FLAG = atomBinding<boolean>('flag');
    interface Row {
      readonly currency: string;
      readonly active: boolean;
    }
    const row: RecordBinding<Row> = record<Row>({
      fields: [
        field<Row, 'currency'>(0, 'currency', 'currency', CURRENCY),
        field<Row, 'active'>(1, 'active', 'active', FLAG),
      ],
      construct: ([currency, active]) => ({
        currency: currency as string,
        active: active as boolean,
      }),
    });
    const text = writeBinding(row, { currency: 'USD', active: true });
    expect(text).toBe('{ currency: "USD" active: true }');
    assertParses(text);
  });

  it('refuses a host value with no primitive framing and no known wireType', () => {
    const OPAQUE = atomBinding<unknown>('opaque');
    expect(() =>
      defaultAtomEncoder({ kind: 'atom', wireType: 'opaque' } as AtomBinding<unknown>, {
        not: 'primitive',
      }),
    ).toThrow(TsonWriteError);
    void OPAQUE;
  });
});

describe('an optional field absent from the host is omitted, never written as null', () => {
  it('omits the field entirely', () => {
    const TEXT = atomBinding<string>('text');
    interface Row {
      readonly name: string;
      readonly nickname?: string;
    }
    const row: RecordBinding<Row> = record<Row>({
      fields: [
        field<Row, 'name'>(0, 'name', 'name', TEXT),
        optional<Row, 'nickname'>(1, 'nickname', 'nickname', TEXT),
      ],
      construct: ([name, nickname]) =>
        nickname === undefined
          ? { name: name as string }
          : { name: name as string, nickname: nickname as string },
    });
    const text = writeBinding(row, { name: 'Ada' });
    expect(text).toBe('{ name: "Ada" }');
    assertParses(text);
  });
});

describe('a caller-supplied AtomEncoder overrides the default entirely', () => {
  it('is consulted for every atom leaf', () => {
    const INT = atomBinding<number>('int32');
    const shout: AtomEncoder = (_binding, value) => ({
      kind: 'token',
      text: String(value).toUpperCase(),
      form: 'unquoted',
    });
    const text = writeBinding(INT, 7, shout);
    expect(text).toBe('7');
  });
});
