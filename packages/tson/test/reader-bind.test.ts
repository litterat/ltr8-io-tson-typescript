import { describe, expect, it } from 'vitest';
import { fromString, runSync } from '../src/io/bytes.js';
import { createDataStream } from '../src/stream/dataStream.js';
import { createReadContext } from '../src/reader/context.js';
import type { ReadContext, TypeReader } from '../src/reader/contracts.js';
import { bindReader, defaultAtomReader } from '../src/reader/bind.js';
import { collector, throwing } from '../src/core/diagnostic.js';
import type { Diagnostic, DiagnosticsReceiver } from '../src/core/diagnostic.js';
import {
  array,
  bridge,
  field,
  lazy,
  map,
  optional,
  record,
  tuple,
  variant,
} from '../src/bind/combinators.js';
import type { AnnotatedBinding, AtomBinding, Binding, RecordBinding } from '../src/bind/binding.js';
import { TsonAtomParseError } from '../src/core/errors.js';
import type { AtomToken } from '../src/atom/contract.js';
import type { Annotations } from '../src/annotations/index.js';

/**
 * `reader/bind.ts` -- `bindReader` adapts a `Binding` (`bind/binding.ts`, authored, never
 * derived) into a `TypeReader` that pulls events straight off a live `ReadContext`
 * (`reader/context.ts`), the suspendable counterpart to `bind/decode.ts`'s `fromDataValue`/
 * `fromCoreValue` -- tested the same way, but driving a *real* event stream
 * (`stream/dataStream.ts`) over real document text rather than an already-built `ast` tree, so
 * the framing (`*annotation [type-ref] core-value`, §2.3), the record-closure rule (§7.2), and
 * the all-or-nothing construction policy under a collecting receiver are all exercised for real.
 */

function contextOver(text: string, receiver: DiagnosticsReceiver): ReadContext {
  const source = createDataStream(fromString(text));
  const ctx = createReadContext(source, receiver);
  runSync(ctx.next()); // document-start; TypeReader.read starts at the root value itself.
  return ctx;
}

/** Reads `text` with a fail-fast receiver that throws `Error(CODE: message)`. */
function readWith<T>(reader: TypeReader<T>, text: string): T {
  const ctx = contextOver(
    text,
    throwing((d) => new Error(`${d.code}: ${d.message}`)),
  );
  return runSync(reader.read(ctx));
}

/** Reads `text` with a collecting receiver, returning both the (possibly abandoned) value and every diagnostic. */
function readCollecting<T>(
  reader: TypeReader<T>,
  text: string,
): { readonly value: T; readonly diagnostics: readonly Diagnostic[] } {
  const c = collector();
  const ctx = contextOver(text, c);
  const value = runSync(reader.read(ctx));
  return { value, diagnostics: c.diagnostics };
}

function atomBinding<T>(wireType: string): AtomBinding<T> {
  return { kind: 'atom', wireType } as unknown as AtomBinding<T>;
}

const INT: AtomBinding<number> = atomBinding('int32');
const TEXT: AtomBinding<string> = atomBinding('text');

/** Reads an `int32` token as a JS `number` (throwing `TsonAtomParseError` for a non-integer), and every other atom's token text as-is. */
function intReader(binding: AtomBinding<unknown>, token: AtomToken): unknown {
  if (binding.wireType !== 'int32') return token.text;
  const n = Number(token.text);
  if (!Number.isInteger(n)) {
    throw new TsonAtomParseError('int32', `'${token.text}' is not an integer`, 'a base-10 integer');
  }
  return n;
}

describe('bindReader -- atom leaves (§5)', () => {
  it('uses defaultAtomReader (the token text, unconverted) with no reader supplied', () => {
    expect(readWith(bindReader(TEXT), '"hello"')).toBe('hello');
    expect(defaultAtomReader(TEXT, { text: 'x', form: 'unquoted' })).toBe('x');
  });

  it('delegates to a supplied AtomReader', () => {
    expect(readWith(bindReader(INT, { readAtom: intReader }), '42')).toBe(42);
  });

  it('discards annotations and a leading type-ref uninterpreted (schema-agnostic at this layer)', () => {
    expect(readWith(bindReader(INT, { readAtom: intReader }), '@doc:"n" !int32 42')).toBe(42);
  });

  it('reports TYPE_MISMATCH for a non-token core-value, fail-fast', () => {
    expect(() => readWith(bindReader(INT, { readAtom: intReader }), '{ }')).toThrow(
      /TYPE_MISMATCH/,
    );
  });

  it('reports ATOM_CONSTRAINT_VIOLATION when the AtomReader rejects the token, fail-fast', () => {
    expect(() => readWith(bindReader(INT, { readAtom: intReader }), '"not a number"')).toThrow(
      /ATOM_CONSTRAINT_VIOLATION/,
    );
  });

  it('under a collecting receiver, an atom parse failure reports and reads as the abandoned placeholder', () => {
    const { value, diagnostics } = readCollecting(
      bindReader(INT, { readAtom: intReader }),
      '"nope"',
    );
    expect(value).toBeUndefined();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe('ATOM_CONSTRAINT_VIOLATION');
  });
});

describe('bindReader -- record (§2.5)', () => {
  interface Point {
    readonly x: number;
    readonly y?: number;
  }
  const pointBinding: RecordBinding<Point> = record<Point>({
    fields: [field<Point, 'x'>(0, 'x', 'x', INT), optional<Point, 'y'>(1, 'y', 'y', INT)],
    construct: ([x, y]) =>
      y === undefined ? { x: x as number } : { x: x as number, y: y as number },
  });
  const pointReader = bindReader(pointBinding, { readAtom: intReader });

  it('reads every present field by wire name', () => {
    expect(readWith(pointReader, '{ x: 1, y: 2 }')).toEqual({ x: 1, y: 2 });
  });

  it('leaves an absent OPTIONAL field undefined', () => {
    expect(readWith(pointReader, '{ x: 1 }')).toEqual({ x: 1 });
  });

  it('rejects a missing REQUIRED scalar field, fail-fast', () => {
    expect(() => readWith(pointReader, '{ }')).toThrow(/FIELD_REQUIRED/);
  });

  it('is closed under its type: a stray field reports UNRECOGNIZED_FIELD and abandons construction', () => {
    const { value, diagnostics } = readCollecting(pointReader, '{ x: 1, z: 9 }');
    expect(value).toBeUndefined(); // ConstructionGuard: any report abandons the whole record
    expect(diagnostics.map((d) => d.code)).toEqual(['UNRECOGNIZED_FIELD']);
  });

  it('reports DUPLICATE_FIELD for a repeated field name, keeping the last value for the field it can still use', () => {
    const { diagnostics } = readCollecting(pointReader, '{ x: 1, x: 2 }');
    expect(diagnostics.map((d) => d.code)).toEqual(['DUPLICATE_FIELD']);
  });

  it('treats {} as the empty record (§2.8), applying every field default', () => {
    interface Empty {
      readonly tag: 'empty';
    }
    const emptyBinding: RecordBinding<Empty> = record<Empty>({
      fields: [],
      construct: () => ({ tag: 'empty' }),
    });
    expect(readWith(bindReader(emptyBinding), '{}')).toEqual({ tag: 'empty' });
  });

  it('defaults a missing REQUIRED array-shaped field to empty, not FIELD_REQUIRED (CLAUDE.md: absent and empty are the same list)', () => {
    interface Tags {
      readonly names: readonly string[];
    }
    const tagsBinding: RecordBinding<Tags> = record<Tags>({
      fields: [
        field<Tags, 'names'>(
          0,
          'names',
          'names',
          array<readonly string[], string>({ element: TEXT, construct: (v) => v, read: (h) => h }),
        ),
      ],
      construct: ([names]) => ({ names: names as readonly string[] }),
    });
    expect(readWith(bindReader(tagsBinding), '{}')).toEqual({ names: [] });
  });

  it('§5.6 positional form: a bare value fills the sole REQUIRED, non-unbound field', () => {
    interface Wrapped {
      readonly n: number;
    }
    const wrappedBinding: RecordBinding<Wrapped> = record<Wrapped>({
      fields: [field<Wrapped, 'n'>(0, 'n', 'n', INT)],
      construct: ([n]) => ({ n: n as number }),
    });
    expect(readWith(bindReader(wrappedBinding, { readAtom: intReader }), '42')).toEqual({
      n: 42,
    });
  });

  it('a mutable RecordBinding is built via create()+set(), not construct()', () => {
    class MutablePoint {
      x = 0;
      y = 0;
    }
    const mutableBinding: RecordBinding<MutablePoint> = record<MutablePoint>({
      fields: [
        field<MutablePoint, 'x'>(0, 'x', 'x', INT),
        field<MutablePoint, 'y'>(1, 'y', 'y', INT),
      ],
      mutable: true,
      create: () => new MutablePoint(),
      construct: () => {
        throw new Error('construct() must not be called for a mutable binding');
      },
    });
    const result = readWith(bindReader(mutableBinding, { readAtom: intReader }), '{ x: 3, y: 4 }');
    expect(result).toBeInstanceOf(MutablePoint);
    expect(result).toEqual({ x: 3, y: 4 });
  });
});

describe('bindReader -- tuple (§2.7)', () => {
  const pairBinding = tuple([INT, TEXT] as const);
  const pairReader = bindReader(pairBinding, { readAtom: intReader });

  it('reads elements positionally', () => {
    expect(readWith(pairReader, '[1 "two"]')).toEqual([1, 'two']);
  });

  it('rejects too few elements as WRONG_ARITY', () => {
    expect(() => readWith(pairReader, '[1]')).toThrow(/WRONG_ARITY/);
  });

  it('rejects too many elements as WRONG_ARITY, still consuming the whole array', () => {
    const { diagnostics } = readCollecting(pairReader, '[1 "two" "extra"]');
    expect(diagnostics.map((d) => d.code)).toEqual(['WRONG_ARITY']);
  });

  it('rejects a non-array core-value', () => {
    expect(() => readWith(pairReader, '{}')).toThrow(/TYPE_MISMATCH/);
  });
});

describe('bindReader -- array (§2.7)', () => {
  const listBinding = array<readonly number[], number>({
    element: INT,
    construct: (v) => v,
    read: (h) => h,
  });
  const listReader = bindReader(listBinding, { readAtom: intReader });

  it('reads every element', () => {
    expect(readWith(listReader, '[1 2 3]')).toEqual([1, 2, 3]);
  });

  it('treats {} as the empty array (§2.8)', () => {
    expect(readWith(listReader, '{}')).toEqual([]);
  });

  it('rejects a non-array, non-{} core-value', () => {
    expect(() => readWith(listReader, '"oops"')).toThrow(/TYPE_MISMATCH/);
  });
});

describe('bindReader -- map (§2.6)', () => {
  const mapBinding = map<Map<string, number>, string, number>({
    key: TEXT,
    value: INT,
    construct: (entries) => new Map(entries),
    read: (h) => h.entries(),
  });
  const mapReader = bindReader(mapBinding, { readAtom: intReader });

  it('reads every entry', () => {
    const result = readWith(mapReader, '{ "a" => 1, "b" => 2 }');
    expect(result).toEqual(
      new Map([
        ['a', 1],
        ['b', 2],
      ]),
    );
  });

  it('treats {} as the empty map (§2.8)', () => {
    expect(readWith(mapReader, '{}')).toEqual(new Map());
  });

  it('rejects the absent sentinel in key position (§2.9)', () => {
    expect(() => readWith(mapReader, '{ _ => 1 }')).toThrow(/TYPE_MISMATCH/);
  });

  it('reports DUPLICATE_MAP_KEY for a repeated key, keeping the last value', () => {
    const { value, diagnostics } = readCollecting(mapReader, '{ "a" => 1, "a" => 2 }');
    expect(diagnostics.map((d) => d.code)).toEqual(['DUPLICATE_MAP_KEY']);
    expect(value).toBeUndefined(); // any report abandons construction here too
  });
});

describe('bindReader -- variant (§3.2 !type-ref dispatch)', () => {
  interface A {
    readonly kind: 'a';
    readonly n: number;
  }
  interface B {
    readonly kind: 'b';
    readonly s: string;
  }
  const aBinding: RecordBinding<A> = record<A>({
    fields: [field<A, 'n'>(0, 'n', 'n', INT)],
    construct: ([n]) => ({ kind: 'a', n: n as number }),
  });
  const bBinding: RecordBinding<B> = record<B>({
    fields: [field<B, 's'>(0, 's', 's', TEXT)],
    construct: ([s]) => ({ kind: 'b', s: s as string }),
  });
  const unionBinding = variant<{ a: RecordBinding<A>; b: RecordBinding<B> }>({
    a: aBinding,
    b: bBinding,
  });
  const unionReader = bindReader(unionBinding, { readAtom: intReader });

  it('dispatches on the leading !type-ref to the matching member', () => {
    expect(readWith(unionReader, '!a { n: 1 }')).toEqual({ kind: 'a', n: 1 });
    expect(readWith(unionReader, '!b { s: "hi" }')).toEqual({ kind: 'b', s: 'hi' });
  });

  it('reports UNKNOWN_TYPE_REF when the value carries no !type-ref at all', () => {
    expect(() => readWith(unionReader, '{ n: 1 }')).toThrow(/UNKNOWN_TYPE_REF/);
  });

  it('reports UNKNOWN_TYPE_REF when the !type-ref names no member', () => {
    expect(() => readWith(unionReader, '!c { n: 1 }')).toThrow(/UNKNOWN_TYPE_REF/);
  });

  it('leaves annotations on the dispatched-to value visible to its own reader, not consumed by dispatch', () => {
    // The member's own reader (a record) discards annotations it has nowhere to put -- this just
    // proves dispatch doesn't eat the type-ref/annotations before the member gets a turn to.
    expect(readWith(unionReader, '@note !a { n: 5 }')).toEqual({ kind: 'a', n: 5 });
  });

  it('reads a long annotation run without replaying it, and still finds the type-ref', () => {
    // Dispatch has to reach past the annotations to the `!type-ref`. Where no member would KEEP
    // those annotations -- every reader but `readAnnotated` treats them as framing and discards
    // them -- they are consumed rather than looked ahead over and rewound, so nothing is retained.
    // Whether it retains them or not is not directly observable; that the value still reads
    // correctly through either path is, and that is the property a change here could break.
    const annotations = Array.from({ length: 2000 }, (_, i) => `@n${String(i)}:[1 2 3]`).join(' ');
    expect(readWith(unionReader, `${annotations} !a { n: 7 }`)).toEqual({ kind: 'a', n: 7 });
  });

  it('consumes exactly one value when dispatch fails, so the next one still aligns', () => {
    // The risky half of consuming rather than rewinding: the "no member matched" path must skip
    // what is LEFT of the value (its type-ref and core-value), not a whole data-value whose
    // annotations it has already eaten. Reading an array of them is what catches a miscount --
    // one event too few or too many and the second element is read from the middle of the first.
    const arrayOfUnions = array<readonly unknown[], unknown>({
      element: unionBinding,
      construct: (values) => values,
      read: (host) => host,
    });
    const reader = bindReader(arrayOfUnions as Binding<readonly unknown[]>, {
      readAtom: intReader,
    });
    // Exactly one diagnostic. A miscount here does not throw -- it re-reads the tail of the
    // skipped value as if it were the next element, and the extra reports that produces are the
    // signal. (The array abandons construction once anything is reported, so the elements
    // themselves are not available to inspect; the positive control below covers those.)
    const { diagnostics } = readCollecting(
      reader,
      '[ @x @y !c { n: 1 }, !a { n: 2 }, @z !b { s: "ok" } ]',
    );
    expect(diagnostics.map((d) => d.code)).toEqual(['UNKNOWN_TYPE_REF']);

    // The positive control: the same shape with every element dispatching, read end to end.
    expect(readWith(reader, '[ @x @y !a { n: 1 }, !a { n: 2 }, @z !b { s: "ok" } ]')).toEqual([
      { kind: 'a', n: 1 },
      { kind: 'a', n: 2 },
      { kind: 'b', s: 'ok' },
    ]);
  });

  it('still rewinds when a member would keep the annotations', () => {
    // The other branch: an `annotated` member reads the value's own annotation run, so dispatch
    // must leave it untouched. Consuming it here would silently drop what that member exists for.
    const boxed: AnnotatedBinding<{ readonly n: unknown; readonly tags: readonly string[] }> = {
      kind: 'annotated',
      value: aBinding,
      construct: (value: unknown, annotations: Annotations) => ({
        n: value,
        tags: annotations.values.map((a) => a.name),
      }),
      unwrap: (host: unknown) => (host as { n: unknown }).n,
      annotationsOf: () => ({ values: [] }),
    } as unknown as AnnotatedBinding<{ readonly n: unknown; readonly tags: readonly string[] }>;
    const withAnnotated = variant({ a: boxed, b: bBinding });
    const reader = bindReader(withAnnotated as Binding<unknown>, { readAtom: intReader });
    expect(readWith(reader, '@urgent @owner:"al" !a { n: 3 }')).toEqual({
      n: { kind: 'a', n: 3 },
      tags: ['urgent', 'owner'],
    });
  });
});

describe('bindReader -- annotated (§3.1 boxed as a value)', () => {
  interface Boxed {
    readonly value: string;
    readonly tagNames: readonly string[];
  }
  const boxedBinding: AnnotatedBinding<Boxed> = {
    kind: 'annotated',
    value: TEXT,
    construct: (value: unknown, annotations: Annotations): Boxed => ({
      value: value as string,
      tagNames: annotations.values.map((a) => a.name),
    }),
    unwrap: (host: unknown): unknown => (host as Boxed).value,
    annotationsOf: (host: unknown): Annotations => ({
      values: (host as Boxed).tagNames.map((name) => ({ name })),
    }),
  } as unknown as AnnotatedBinding<Boxed>;

  it("captures the value's own leading annotations alongside the value", () => {
    const result = readWith(bindReader(boxedBinding), '@urgent @owner:"al" "hello"');
    expect(result.value).toBe('hello');
    expect(result.tagNames).toEqual(['urgent', 'owner']);
  });

  it('carries an empty Annotations for an unannotated value', () => {
    const result = readWith(bindReader(boxedBinding), '"plain"');
    expect(result).toEqual({ value: 'plain', tagNames: [] });
  });
});

describe('bindReader -- bridge (host <-> a separately-bound wire type)', () => {
  const doubledBinding = bridge<number, number>(
    INT,
    (value) => value / 2,
    (wire) => wire * 2,
  );

  it('reads through the wire binding and applies fromWire', () => {
    expect(readWith(bindReader(doubledBinding, { readAtom: intReader }), '5')).toBe(10);
  });
});

describe('bindReader -- lazy (a self-referential binding, §binding.ts LazyBinding)', () => {
  interface Node {
    readonly value: number;
    readonly next?: Node;
  }
  // A plain `RecordBinding<Node>` annotation, not an inferred `const`: `lazy(() => nodeBinding)`
  // below refers to `nodeBinding` inside its own initializer, so the binding needs a type fully
  // known before that initializer runs (`bind/combinators.ts`'s own `lazy` doc explains why).
  const nodeBinding: RecordBinding<Node> = record<Node>({
    fields: [
      field<Node, 'value'>(0, 'value', 'value', INT),
      optional<Node, 'next'>(
        1,
        'next',
        'next',
        lazy((): Binding<Node> => nodeBinding),
      ),
    ],
    construct: ([value, next]) =>
      next === undefined
        ? { value: value as number }
        : { value: value as number, next: next as Node },
  });

  it('reads an arbitrarily deep self-referential structure without a construction-time cycle', () => {
    const reader = bindReader(nodeBinding, { readAtom: intReader });
    const result = readWith(reader, '{ value: 1, next: { value: 2, next: { value: 3 } } }');
    expect(result).toEqual({ value: 1, next: { value: 2, next: { value: 3 } } });
  });
});
