import { describe, expect, it } from 'vitest';
import {
  array,
  bridge,
  field,
  map,
  optional,
  record,
  tuple,
  variant,
} from '../src/bind/combinators.js';
import { fromCoreValue, fromDataValue } from '../src/bind/decode.js';
import { TsonReadError } from '../src/core/errors.js';
import type { AtomBinding, Binding, RecordBinding } from '../src/bind/binding.js';
import type { AnnotatedBinding } from '../src/bind/binding.js';
import type { CoreValue, DataValue } from '../src/ast/value.js';

/**
 * `bind/decode.ts` -- `fromCoreValue`/`fromDataValue` convert the structural AST
 * (`ast/value.ts`) back to a bound host value, the read counterpart of `bind/encode.ts`'s
 * `toCoreValue`/`toDataValue`, tested the same way `bind-encode.test.ts` tests its write
 * counterpart: round-tripping through `bind/combinators.ts`-authored bindings, against
 * [TSON-DATA] §2.3's `data-value = *annotation [type-ref] core-value` split and the record/array/
 * map shapes §2.5-§2.7 define.
 */

function atomBinding<T>(wireType: string): Binding<T> {
  return { kind: 'atom', wireType } as unknown as AtomBinding<T>;
}

const INT: Binding<number> = atomBinding('int32');
const TEXT: Binding<string> = atomBinding('text');

function token(text: string): CoreValue {
  return { kind: 'token', text, form: 'unquoted' };
}

function dataToken(text: string, typeRef?: string): DataValue {
  return { annotations: [], ...(typeRef === undefined ? {} : { typeRef }), coreValue: token(text) };
}

/** An `AtomDecoder` that reads an `int32` token as a JS `number` and a `text` token as-is. */
function intDecoder(binding: AtomBinding<unknown>, wire: { text: string }): unknown {
  return binding.wireType === 'int32' ? Number(wire.text) : wire.text;
}

describe('fromCoreValue -- atom leaves (§5)', () => {
  it('uses the default decoder (the token text, unconverted) with no decoder supplied', () => {
    expect(fromCoreValue(TEXT, token('hello'))).toBe('hello');
  });

  it('delegates to a supplied AtomDecoder', () => {
    expect(fromCoreValue(INT, token('42'), intDecoder)).toBe(42);
  });

  it('rejects a non-token core-value at an atom position', () => {
    expect(() => fromCoreValue(INT, { kind: 'empty-brace' }, intDecoder)).toThrow(TsonReadError);
  });

  it('round-trips toCoreValue -> fromCoreValue for an atom', async () => {
    const { toCoreValue } = await import('../src/bind/encode.js');
    const wire = toCoreValue(INT, 7, () => ({ kind: 'token', text: '7', form: 'unquoted' }));
    expect(fromCoreValue(INT, wire, intDecoder)).toBe(7);
  });
});

describe('fromCoreValue -- record (§2.5)', () => {
  interface Point {
    readonly x: number;
    readonly y?: number;
  }
  const pointBinding: RecordBinding<Point> = record<Point>({
    fields: [field<Point, 'x'>(0, 'x', 'x', INT), optional<Point, 'y'>(1, 'y', 'y', INT)],
    construct: ([x, y]) =>
      y === undefined ? { x: x as number } : { x: x as number, y: y as number },
  });

  function recordOf(fields: Record<string, string>): CoreValue {
    return {
      kind: 'record',
      fields: Object.entries(fields).map(([name, text]) => ({
        name,
        value: { value: dataToken(text) },
      })),
    };
  }

  it('reads every present field by wire name', () => {
    expect(fromCoreValue(pointBinding, recordOf({ x: '1', y: '2' }), intDecoder)).toEqual({
      x: 1,
      y: 2,
    });
  });

  it('leaves an absent OPTIONAL field undefined', () => {
    expect(fromCoreValue(pointBinding, recordOf({ x: '1' }), intDecoder)).toEqual({ x: 1 });
  });

  it('treats {} as the empty record (§2.8)', () => {
    interface Empty {
      readonly tag: 'empty';
    }
    const emptyBinding: RecordBinding<Empty> = record<Empty>({
      fields: [],
      construct: () => ({ tag: 'empty' }),
    });
    expect(fromCoreValue(emptyBinding, { kind: 'empty-brace' }, intDecoder)).toEqual({
      tag: 'empty',
    });
  });

  it('rejects a field the record type does not declare (closed under its type)', () => {
    expect(() => fromCoreValue(pointBinding, recordOf({ x: '1', z: '9' }), intDecoder)).toThrow(
      TsonReadError,
    );
  });

  it('rejects a missing REQUIRED scalar field', () => {
    expect(() => fromCoreValue(pointBinding, recordOf({}), intDecoder)).toThrow(TsonReadError);
  });

  it('defaults a missing REQUIRED array-shaped field to empty, not an error', () => {
    interface Tags {
      readonly names: readonly string[];
    }
    const tagsBinding: RecordBinding<Tags> = record<Tags>({
      fields: [
        field<Tags, 'names'>(
          0,
          'names',
          'names',
          array<readonly string[], string>({
            element: TEXT,
            construct: (v) => v,
            read: (h) => h,
          }),
        ),
      ],
      construct: ([names]) => ({ names: names as readonly string[] }),
    });
    expect(fromCoreValue(tagsBinding, { kind: 'record', fields: [] }, intDecoder)).toEqual({
      names: [],
    });
  });

  it('round-trips toCoreValue -> fromCoreValue for a record', async () => {
    const { toCoreValue } = await import('../src/bind/encode.js');
    const encodeAtom = (_b: AtomBinding<unknown>, v: unknown) => ({
      kind: 'token' as const,
      text: String(v),
      form: 'unquoted' as const,
    });
    const wire = toCoreValue(pointBinding, { x: 3, y: 4 }, encodeAtom);
    expect(fromCoreValue(pointBinding, wire, intDecoder)).toEqual({ x: 3, y: 4 });
  });
});

describe('fromCoreValue -- tuple (§2.7)', () => {
  const pairBinding = tuple([INT, TEXT] as const);

  it('reads elements positionally', () => {
    const wire: CoreValue = {
      kind: 'array',
      elements: [{ value: dataToken('1') }, { value: dataToken('two') }],
    };
    expect(fromCoreValue(pairBinding, wire, intDecoder)).toEqual([1, 'two']);
  });

  it('rejects the wrong arity', () => {
    const wire: CoreValue = { kind: 'array', elements: [{ value: dataToken('1') }] };
    expect(() => fromCoreValue(pairBinding, wire, intDecoder)).toThrow(TsonReadError);
  });

  it('rejects a non-array core-value', () => {
    expect(() => fromCoreValue(pairBinding, { kind: 'empty-brace' }, intDecoder)).toThrow(
      TsonReadError,
    );
  });
});

describe('fromCoreValue -- array (§2.7)', () => {
  const listBinding = array<readonly number[], number>({
    element: INT,
    construct: (v) => v,
    read: (h) => h,
  });

  it('reads every element in order', () => {
    const wire: CoreValue = {
      kind: 'array',
      elements: [{ value: dataToken('1') }, { value: dataToken('2') }],
    };
    expect(fromCoreValue(listBinding, wire, intDecoder)).toEqual([1, 2]);
  });

  it('treats {} as the empty array, matching the "absent and empty are the same list" convention', () => {
    expect(fromCoreValue(listBinding, { kind: 'empty-brace' }, intDecoder)).toEqual([]);
  });
});

describe('fromCoreValue -- map (§2.6)', () => {
  const mapBinding = map<ReadonlyMap<string, number>, string, number>({
    key: TEXT,
    value: INT,
    construct: (entries) => new Map(entries),
    read: (h) => [...h.entries()],
  });

  it('reads every entry', () => {
    const wire: CoreValue = {
      kind: 'map',
      entries: [{ key: dataToken('a'), value: { value: dataToken('1') } }],
    };
    const result = fromCoreValue(mapBinding, wire, intDecoder);
    expect([...result.entries()]).toEqual([['a', 1]]);
  });

  it('treats {} as the empty map', () => {
    const result = fromCoreValue(mapBinding, { kind: 'empty-brace' }, intDecoder);
    expect(result.size).toBe(0);
  });
});

describe('fromCoreValue -- bridge', () => {
  const evenBinding = bridge<number, number>(
    INT,
    (n) => n * 2,
    (wire) => wire / 2,
  );

  it('decodes through the wire binding then applies fromWire', () => {
    expect(fromCoreValue(evenBinding, token('10'), intDecoder)).toBe(5);
  });
});

describe('fromCoreValue -- variant and annotated need fromDataValue', () => {
  const memberBinding = record<{ tag: 'a' }>({ fields: [], construct: () => ({ tag: 'a' }) });
  const variantBinding = variant({ a: memberBinding }, 'tag');

  it('rejects a variant read directly through fromCoreValue', () => {
    expect(() => fromCoreValue(variantBinding, { kind: 'empty-brace' }, intDecoder)).toThrow(
      TsonReadError,
    );
  });
});

describe('fromDataValue -- variant dispatch on !type-ref (§3.2)', () => {
  interface A {
    readonly tag: 'a';
    readonly x: number;
  }
  interface B {
    readonly tag: 'b';
    readonly text: string;
  }
  const aBinding: RecordBinding<A> = record<A>({
    fields: [field<A, 'x'>(0, 'x', 'x', INT)],
    construct: ([x]) => ({ tag: 'a', x: x as number }),
  });
  const bBinding: RecordBinding<B> = record<B>({
    fields: [field<B, 'text'>(0, 'text', 'text', TEXT)],
    construct: ([text]) => ({ tag: 'b', text: text as string }),
  });
  const unionBinding = variant<{ a: RecordBinding<A>; b: RecordBinding<B> }>(
    { a: aBinding, b: bBinding },
    'tag',
  );

  it('dispatches to the member named by !type-ref', () => {
    const wire: DataValue = {
      annotations: [],
      typeRef: 'b',
      coreValue: { kind: 'record', fields: [{ name: 'text', value: { value: dataToken('hi') } }] },
    };
    expect(fromDataValue(unionBinding, wire, intDecoder)).toEqual({ tag: 'b', text: 'hi' });
  });

  it('rejects a value with no !type-ref at all', () => {
    const wire: DataValue = { annotations: [], coreValue: { kind: 'empty-brace' } };
    expect(() => fromDataValue(unionBinding, wire, intDecoder)).toThrow(TsonReadError);
  });

  it('rejects a !type-ref naming no member', () => {
    const wire: DataValue = {
      annotations: [],
      typeRef: 'c',
      coreValue: { kind: 'empty-brace' },
    };
    expect(() => fromDataValue(unionBinding, wire, intDecoder)).toThrow(TsonReadError);
  });
});

describe('fromDataValue -- annotated (§3.1)', () => {
  interface Boxed {
    readonly value: number;
    readonly doc?: string;
  }
  const boxBinding: AnnotatedBinding<Boxed> = {
    kind: 'annotated',
    value: INT,
    construct: (value: unknown, annotations: { values: readonly { name: string }[] }): Boxed => {
      const doc = annotations.values.find((a) => a.name === 'doc');
      return doc === undefined
        ? { value: value as number }
        : { value: value as number, doc: 'seen' };
    },
    unwrap: (host: Boxed): unknown => host.value,
    annotationsOf: () => ({ values: [] }),
  } as unknown as AnnotatedBinding<Boxed>;

  it('reads the value and hands the wire annotations to construct', () => {
    const wire: DataValue = {
      annotations: [{ name: 'doc', value: dataToken('note') }],
      coreValue: token('5'),
    };
    expect(fromDataValue(boxBinding, wire, intDecoder)).toEqual({ value: 5, doc: 'seen' });
  });

  it('round-trips toDataValue -> fromDataValue for an annotated value', async () => {
    const { toDataValue } = await import('../src/bind/encode.js');
    const encodeAtom = (_b: AtomBinding<unknown>, v: unknown) => ({
      kind: 'token' as const,
      text: String(v),
      form: 'unquoted' as const,
    });
    const wire = toDataValue(boxBinding, { value: 9 }, encodeAtom);
    expect(fromDataValue(boxBinding, wire, intDecoder)).toEqual({ value: 9 });
  });
});

describe('fromDataValue -- non-variant/annotated bindings ignore their own framing', () => {
  it('a plain record binding ignores a decorative !type-ref (e.g. the monomorphic case)', () => {
    interface Solo {
      readonly x: number;
    }
    const soloBinding: RecordBinding<Solo> = record<Solo>({
      fields: [field<Solo, 'x'>(0, 'x', 'x', INT)],
      construct: ([x]) => ({ x: x as number }),
    });
    const wire: DataValue = {
      annotations: [],
      typeRef: 'record_field', // decoration, not discrimination -- see bundled-schemas-resolve.test.ts's MONOMORPHIC set
      coreValue: { kind: 'record', fields: [{ name: 'x', value: { value: dataToken('1') } }] },
    };
    expect(fromDataValue(soloBinding, wire, intDecoder)).toEqual({ x: 1 });
  });
});
