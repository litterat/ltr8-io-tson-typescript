import { describe, expect, it } from 'vitest';
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
import { toCoreValue, toDataValue } from '../src/bind/encode.js';
import { annotations } from '../src/annotations/index.js';
import { TsonWriteError } from '../src/core/errors.js';
import type { AtomBinding, Binding, RecordBinding } from '../src/bind/binding.js';
import type { AnnotatedBinding } from '../src/bind/binding.js';

/**
 * `bind/encode.ts` -- `toCoreValue`/`toDataValue` convert a bound host value straight to the
 * structural AST (`ast/value.ts`), depending on nothing but `ast/` and `bind/` (CLAUDE.md's
 * bind/compiler layering; the module's own top comment). Tested against [TSON-DATA] §2.3's
 * `data-value = *annotation [type-ref] core-value` split -- exactly the framing `toDataValue`
 * carries that `toCoreValue` cannot -- and against the record/array/map shapes §2.5-§2.7 define.
 */

function atomBinding<T>(wireType: string): Binding<T> {
  return { kind: 'atom', wireType } as unknown as AtomBinding<T>;
}

const INT: Binding<number> = atomBinding('int32');
const TEXT: Binding<string> = atomBinding('text');

describe('toCoreValue -- atom leaves (§5)', () => {
  it('uses the default encoder (String(value), unquoted) with no encoder supplied', () => {
    const core = toCoreValue(INT, 42);
    expect(core).toEqual({ kind: 'token', text: '42', form: 'unquoted' });
  });

  it('delegates to a supplied AtomEncoder', () => {
    const core = toCoreValue(INT, 42, () => ({
      kind: 'token',
      text: 'forty-two',
      form: 'unquoted',
    }));
    expect(core).toEqual({ kind: 'token', text: 'forty-two', form: 'unquoted' });
  });
});

describe('toCoreValue -- record (§2.5)', () => {
  interface Point {
    readonly x: number;
    readonly y?: number;
  }
  const pointBinding: RecordBinding<Point> = record<Point>({
    fields: [field<Point, 'x'>(0, 'x', 'x', INT), optional<Point, 'y'>(1, 'y', 'y', INT)],
    construct: ([x, y]) =>
      y === undefined ? { x: x as number } : { x: x as number, y: y as number },
  });

  it('writes a field for every present slot, in field order', () => {
    const core = toCoreValue(pointBinding, { x: 1, y: 2 });
    expect(core).toEqual({
      kind: 'record',
      fields: [
        {
          name: 'x',
          value: {
            value: { annotations: [], coreValue: { kind: 'token', text: '1', form: 'unquoted' } },
          },
        },
        {
          name: 'y',
          value: {
            value: { annotations: [], coreValue: { kind: 'token', text: '2', form: 'unquoted' } },
          },
        },
      ],
    });
  });

  it('omits an absent optional field entirely, never writing a null placeholder', () => {
    const core = toCoreValue(pointBinding, { x: 1 });
    expect(core).toEqual({
      kind: 'record',
      fields: [
        {
          name: 'x',
          value: {
            value: { annotations: [], coreValue: { kind: 'token', text: '1', form: 'unquoted' } },
          },
        },
      ],
    });
  });

  it('excludes an unbound slot (e.g. an annotations carrier) from the written fields', () => {
    interface Carrier {
      readonly x: number;
      readonly meta: unknown;
    }
    const carrierSlot = { ...field<Carrier, 'meta'>(1, 'meta', 'meta', INT), unbound: true };
    const binding = record<Carrier>({
      fields: [field<Carrier, 'x'>(0, 'x', 'x', INT), carrierSlot],
      construct: ([x, meta]) => ({ x: x as number, meta }),
    });
    const core = toCoreValue(binding, { x: 1, meta: 'ignored' });
    expect(core).toEqual({
      kind: 'record',
      fields: [
        {
          name: 'x',
          value: {
            value: { annotations: [], coreValue: { kind: 'token', text: '1', form: 'unquoted' } },
          },
        },
      ],
    });
  });
});

describe('toCoreValue -- tuple (§5.3), as an array core-value', () => {
  it('writes positional elements as an array', () => {
    const binding = tuple([INT, TEXT]);
    const core = toCoreValue(binding, [1, 'one']);
    expect(core.kind).toBe('array');
    if (core.kind === 'array') {
      expect(core.elements).toHaveLength(2);
      expect(core.elements[0]?.value.coreValue).toEqual({
        kind: 'token',
        text: '1',
        form: 'unquoted',
      });
      expect(core.elements[1]?.value.coreValue).toEqual({
        kind: 'token',
        text: 'one',
        form: 'unquoted',
      });
    }
  });
});

describe('toCoreValue -- array (§2.7)', () => {
  it('writes every element read() yields, in order', () => {
    const binding = array<readonly number[], number>({
      element: INT,
      construct: (v) => v,
      read: (host) => host,
    });
    const core = toCoreValue(binding, [1, 2, 3]);
    expect(core).toEqual({
      kind: 'array',
      elements: [
        { value: { annotations: [], coreValue: { kind: 'token', text: '1', form: 'unquoted' } } },
        { value: { annotations: [], coreValue: { kind: 'token', text: '2', form: 'unquoted' } } },
        { value: { annotations: [], coreValue: { kind: 'token', text: '3', form: 'unquoted' } } },
      ],
    });
  });
});

describe('toCoreValue -- map (§2.6)', () => {
  it('writes every entry read() yields, key as a DataValue and value as a ScopedValue', () => {
    const binding = map<Map<string, number>, string, number>({
      key: TEXT,
      value: INT,
      construct: (entries) => new Map(entries),
      read: (host) => host.entries(),
    });
    const host = new Map([['a', 1]]);
    const core = toCoreValue(binding, host);
    expect(core).toEqual({
      kind: 'map',
      entries: [
        {
          key: { annotations: [], coreValue: { kind: 'token', text: 'a', form: 'unquoted' } },
          value: {
            value: { annotations: [], coreValue: { kind: 'token', text: '1', form: 'unquoted' } },
          },
        },
      ],
    });
  });
});

describe('toCoreValue -- bridge (host/wire conversion)', () => {
  it('converts through toWire before encoding the wire-shaped binding', () => {
    const binding = bridge<Date, string>(
      TEXT,
      (d) => d.toISOString(),
      (t) => new Date(t),
    );
    const core = toCoreValue(binding, new Date('2020-01-01T00:00:00.000Z'));
    expect(core).toEqual({ kind: 'token', text: '2020-01-01T00:00:00.000Z', form: 'unquoted' });
  });
});

describe('toCoreValue -- lazy is resolved transparently', () => {
  it('resolves a lazy binding before dispatching on kind', () => {
    const core = toCoreValue(
      lazy(() => INT),
      7,
    );
    expect(core).toEqual({ kind: 'token', text: '7', form: 'unquoted' });
  });
});

describe('toCoreValue -- variant loses its discriminating type-ref at the top (documented)', () => {
  interface Circle {
    readonly kind: 'circle';
    readonly radius: number;
  }
  const circleBinding: RecordBinding<Circle> = record<Circle>({
    fields: [field<Circle, 'radius'>(0, 'radius', 'radius', INT)],
    construct: ([radius]) => ({ kind: 'circle', radius: radius as number }),
  });
  const variantBinding = variant({ circle: circleBinding }, 'kind');

  it('recurses into the matched member, with no type-ref at this level', () => {
    const core = toCoreValue(variantBinding, { kind: 'circle', radius: 3 });
    expect(core.kind).toBe('record');
  });

  it('throws TsonWriteError when the value matches no member', () => {
    expect(() => toCoreValue(variantBinding, { kind: 'triangle' } as unknown as Circle)).toThrow(
      TsonWriteError,
    );
  });
});

describe("toDataValue -- variant attaches the chosen member's wireName as typeRef (§3.2)", () => {
  interface Circle {
    readonly kind: 'circle';
    readonly radius: number;
  }
  const circleBinding: RecordBinding<Circle> = record<Circle>({
    fields: [field<Circle, 'radius'>(0, 'radius', 'radius', INT)],
    construct: ([radius]) => ({ kind: 'circle', radius: radius as number }),
  });
  const variantBinding = variant({ circle: circleBinding }, 'kind');

  it('carries the member wireName as the DataValue typeRef', () => {
    const dataValue = toDataValue(variantBinding, { kind: 'circle', radius: 3 });
    expect(dataValue.typeRef).toBe('circle');
    expect(dataValue.coreValue.kind).toBe('record');
  });

  it("a nested field bound to a variant carries its typeRef at that field's own position", () => {
    interface Holder {
      readonly shape: Circle;
    }
    const holderBinding: RecordBinding<Holder> = record<Holder>({
      fields: [field<Holder, 'shape'>(0, 'shape', 'shape', variantBinding)],
      construct: ([shape]) => ({ shape: shape as Circle }),
    });
    const core = toCoreValue(holderBinding, { shape: { kind: 'circle', radius: 1 } });
    expect(core.kind).toBe('record');
    if (core.kind === 'record') {
      expect(core.fields[0]?.value.value.typeRef).toBe('circle');
    }
  });
});

describe('toDataValue -- annotated carries wire-format annotations (§3.1)', () => {
  interface Boxed<T> {
    readonly value: T;
  }

  function annotatedBinding<T>(inner: Binding<T>): AnnotatedBinding<Boxed<T>> {
    return {
      kind: 'annotated',
      value: inner,
      construct: (value: unknown, ann: ReturnType<typeof annotations>) =>
        ({ value: value as T, __ann: ann }) as unknown as Boxed<T>,
      unwrap: (host: Boxed<T>) => host.value,
      annotationsOf: (host: Boxed<T>) =>
        (host as unknown as { __ann: ReturnType<typeof annotations> }).__ann,
    } as unknown as AnnotatedBinding<Boxed<T>>;
  }

  it('attaches annotationsOf(host) at the DataValue level', () => {
    const ann = annotations([{ name: 'deprecated' }]);
    const binding = annotatedBinding<number>(INT);
    const host = { value: 42, __ann: ann } as unknown as Boxed<number>;
    const dataValue = toDataValue(binding, host);
    expect(dataValue.annotations).toEqual([{ name: 'deprecated' }]);
    expect(dataValue.coreValue).toEqual({ kind: 'token', text: '42', form: 'unquoted' });
  });

  it('toCoreValue on the same binding drops the annotations (documented: use toDataValue)', () => {
    const ann = annotations([{ name: 'deprecated' }]);
    const binding = annotatedBinding<number>(INT);
    const host = { value: 42, __ann: ann } as unknown as Boxed<number>;
    const core = toCoreValue(binding, host);
    expect(core).toEqual({ kind: 'token', text: '42', form: 'unquoted' });
  });
});
