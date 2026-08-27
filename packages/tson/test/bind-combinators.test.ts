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
import type { AtomBinding, Binding, RecordBinding } from '../src/bind/binding.js';

/**
 * `bind/combinators.ts` -- the eleven authored-descriptor builders (`bind/binding.ts`'s own top
 * comment; PORT-PLAN.md architectural decision 2). There is no reflection to test against, so
 * these tests state the contract each combinator's own TSDoc promises and the host-side semantics
 * `field`/`optional`/`record`/etc. give a `Binding<T>` graph, citing the schema-model section each
 * shape mirrors ([TSON-SCHEMA] §5.2 records, §5.3 tuples, §4.2 arrays/maps, §5.4 choice/variant).
 */

// No combinator among the eleven builds a leaf `AtomBinding` -- the schema-compiler work package
// that pairs a wire type name with real atom parsing owns that. This stands in for one, using the
// same "assert past the phantom OUT key" pattern `combinators.ts` itself uses, licensed here only
// because it is test scaffolding for a leaf value, never shipped as this package's own API.
function atomBinding<T>(wireType: string): Binding<T> {
  return { kind: 'atom', wireType } as unknown as AtomBinding<T>;
}

const INT: Binding<number> = atomBinding('int32');
const TEXT: Binding<string> = atomBinding('text');

describe('field/optional -- host-side slots for a record binding ([TSON-SCHEMA] §5.2)', () => {
  interface Person {
    readonly name: string;
    readonly nickname?: string;
  }

  it('field() is always required and present', () => {
    const slot = field<Person, 'name'>(0, 'name', 'name', TEXT);
    expect(slot.required).toBe(true);
    expect(slot.unbound).toBe(false);
    expect(slot.isPresent({ name: 'Ada' })).toBe(true);
    expect(slot.get({ name: 'Ada' })).toBe('Ada');
  });

  it('field() writes through set() to the host property', () => {
    const slot = field<Person, 'name'>(0, 'name', 'name', TEXT);
    const host: { name: string } = { name: '' };
    slot.set?.(host, 'Grace');
    expect(host.name).toBe('Grace');
  });

  it('optional() derives presence from the host property being non-null/non-undefined', () => {
    const slot = optional<Person, 'nickname'>(1, 'nickname', 'nickname', TEXT);
    expect(slot.required).toBe(false);
    expect(slot.isPresent({ name: 'Ada' })).toBe(false);
    expect(slot.isPresent({ name: 'Ada', nickname: 'Ace' })).toBe(true);
    expect(slot.get({ name: 'Ada', nickname: 'Ace' })).toBe('Ace');
  });

  it('a rename lets wireName and key diverge', () => {
    interface Wire {
      readonly full_name: string;
    }
    const slot = field<Wire, 'full_name'>(0, 'name', 'full_name', TEXT);
    expect(slot.wireName).toBe('name');
    expect(slot.key).toBe('full_name');
    expect(slot.get({ full_name: 'Ada Lovelace' })).toBe('Ada Lovelace');
  });
});

describe('record() -- product bindings for the record body ([TSON-SCHEMA] §5.2)', () => {
  interface Point {
    readonly x: number;
    readonly y: number;
  }

  function pointBinding(): RecordBinding<Point> {
    return record<Point>({
      fields: [field<Point, 'x'>(0, 'x', 'x', INT), field<Point, 'y'>(1, 'y', 'y', INT)],
      construct: ([x, y]) => ({ x: x as number, y: y as number }),
    });
  }

  it('byWireName indexes fields by their wire name', () => {
    const binding = pointBinding();
    expect(binding.byWireName.get('x')).toBe(binding.fields[0]);
    expect(binding.byWireName.get('y')).toBe(binding.fields[1]);
  });

  it('construct builds the host value from ordered slot values', () => {
    const binding = pointBinding();
    expect(binding.construct([3, 4])).toEqual({ x: 3, y: 4 });
  });

  it('defaults to immutable (mutable: false) with no create()', () => {
    const binding = pointBinding();
    expect(binding.mutable).toBe(false);
    expect('create' in binding).toBe(false);
  });

  it('mutable: true carries the supplied create()', () => {
    interface MutablePoint {
      x: number;
      y: number;
    }
    const binding = record<MutablePoint>({
      fields: [
        field<MutablePoint, 'x'>(0, 'x', 'x', INT),
        field<MutablePoint, 'y'>(1, 'y', 'y', INT),
      ],
      mutable: true,
      create: () => ({ x: 0, y: 0 }),
      construct: () => ({ x: 0, y: 0 }),
    });
    expect(binding.mutable).toBe(true);
    expect(binding.create?.()).toEqual({ x: 0, y: 0 });
  });

  it('an unbound slot (e.g. an annotations carrier) occupies fields but not byWireName', () => {
    interface Carrier {
      readonly x: number;
      readonly meta: unknown;
    }
    const carrierSlot = field<Carrier, 'meta'>(1, 'meta', 'meta', INT);
    const unboundSlot = { ...carrierSlot, unbound: true };
    const binding = record<Carrier>({
      fields: [field<Carrier, 'x'>(0, 'x', 'x', INT), unboundSlot],
      construct: ([x, meta]) => ({ x: x as number, meta }),
    });
    expect(binding.fields).toHaveLength(2);
    expect(binding.byWireName.has('meta')).toBe(false);
    expect(binding.byWireName.has('x')).toBe(true);
  });
});

describe('tuple() -- positional bindings inferring their host type ([TSON-SCHEMA] §5.3)', () => {
  it('infers a readonly tuple type from a positional literal with no `as const`', () => {
    const binding = tuple([INT, TEXT]);
    // Type-level: TupleBinding<readonly [number, string]>. Runtime: two positional slots.
    expect(binding.elements).toHaveLength(2);
    expect(binding.elements[0]?.index).toBe(0);
    expect(binding.elements[1]?.index).toBe(1);
  });

  it('each slot reads its own position off a host array', () => {
    const binding = tuple([INT, TEXT]);
    const host = [7, 'seven'] as const;
    expect(binding.elements[0]?.get(host)).toBe(7);
    expect(binding.elements[1]?.get(host)).toBe('seven');
  });

  it('construct rebuilds the tuple from positional values', () => {
    const binding = tuple([INT, TEXT]);
    expect(binding.construct([1, 'one'])).toEqual([1, 'one']);
  });
});

describe('array() -- sequential homogeneous bindings ([TSON-SCHEMA] §4.2, §5.3)', () => {
  it('construct/read round-trip through the supplied closures', () => {
    const binding = array<readonly number[], number>({
      element: INT,
      construct: (values) => values,
      read: (host) => host,
    });
    const values = [1, 2, 3];
    expect(binding.construct(values)).toEqual(values);
    expect([...binding.read(values)]).toEqual(values);
  });
});

describe('map() -- keyed bindings ([TSON-SCHEMA] §4.2)', () => {
  it('construct/read round-trip entries through the supplied closures', () => {
    const binding = map<Map<string, number>, string, number>({
      key: TEXT,
      value: INT,
      construct: (entries) => new Map(entries),
      read: (host) => host.entries(),
    });
    const host = binding.construct([
      ['a', 1],
      ['b', 2],
    ]);
    expect([...binding.read(host)]).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
  });
});

describe('variant() -- tagged unions ([TSON-SCHEMA] §5.4)', () => {
  interface Circle {
    readonly kind: 'circle';
    readonly radius: number;
  }
  interface Square {
    readonly kind: 'square';
    readonly side: number;
  }

  const circleBinding: RecordBinding<Circle> = record<Circle>({
    fields: [field<Circle, 'radius'>(0, 'radius', 'radius', INT)],
    construct: ([radius]) => ({ kind: 'circle', radius: radius as number }),
  });
  const squareBinding: RecordBinding<Square> = record<Square>({
    fields: [field<Square, 'side'>(0, 'side', 'side', INT)],
    construct: ([side]) => ({ kind: 'square', side: side as number }),
  });

  it('is sealed by default, with no addMember', () => {
    const binding = variant({ circle: circleBinding, square: squareBinding }, 'kind');
    expect(binding.sealed).toBe(true);
    expect('addMember' in binding).toBe(false);
  });

  it('memberFor with a discriminant picks the member by the shared tag', () => {
    const binding = variant({ circle: circleBinding, square: squareBinding }, 'kind');
    expect(binding.memberFor({ kind: 'circle', radius: 1 })?.wireName).toBe('circle');
    expect(binding.memberFor({ kind: 'square', side: 1 })?.wireName).toBe('square');
    expect(binding.memberFor({ kind: 'triangle' })).toBeUndefined();
  });

  it('members carry the wire type name and their own binding', () => {
    const binding = variant({ circle: circleBinding, square: squareBinding }, 'kind');
    const circle = binding.members.find((m) => m.wireName === 'circle');
    expect(circle?.binding).toBe(circleBinding);
  });

  it("without a discriminant, memberFor consults each member's own test", () => {
    const binding = variant({ circle: circleBinding, square: squareBinding });
    expect(binding.discriminant).toBeUndefined();
    // The shape literal alone gives each member no `test` of its own -- a caller wiring up
    // per-member recognition supplies that separately (this combinator only fixes member keys,
    // per its own doc), so with none supplied every value matches no member.
    expect(binding.memberFor({ kind: 'circle', radius: 1 })).toBeUndefined();
  });
});

describe('bridge() -- host/wire conversion ([TSON-SCHEMA] §5.6, meta.tn atom refinement)', () => {
  it('toWire/fromWire round-trip through the supplied conversions', () => {
    const binding = bridge<Date, string>(
      TEXT,
      (date) => date.toISOString(),
      (text) => new Date(text),
    );
    const date = new Date('2020-01-01T00:00:00.000Z');
    expect(binding.toWire(date)).toBe('2020-01-01T00:00:00.000Z');
    expect(binding.fromWire('2020-01-01T00:00:00.000Z')).toEqual(date);
  });

  it('wire carries the binding for the wire-shaped type', () => {
    const binding = bridge<Date, string>(
      TEXT,
      (d) => d.toISOString(),
      (t) => new Date(t),
    );
    expect(binding.wire).toBe(TEXT);
  });
});

describe('lazy() -- closing a declaration-order cycle', () => {
  interface Node {
    readonly value: number;
    readonly next?: Node;
  }

  it('resolves and memoises on first get(), matching Memoized.get()', () => {
    let calls = 0;
    const target: Binding<number> = INT;
    const binding = lazy(() => {
      calls++;
      return target;
    });
    expect(binding.get()).toBe(target);
    expect(binding.get()).toBe(target);
    expect(calls).toBe(1);
  });

  it('peek() never forces resolution', () => {
    const binding = lazy(() => INT);
    expect(binding.peek()).toBeUndefined();
    binding.get();
    expect(binding.peek()).toBe(INT);
  });

  it('closes a self-referential record binding (the ergonomics-cliff example)', () => {
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

    const nextSlot = nodeBinding.fields[1];
    expect(nextSlot).toBeDefined();
    const nextBinding = nextSlot?.binding;
    expect(nextBinding?.kind).toBe('lazy');
    if (nextBinding?.kind === 'lazy') {
      expect(nextBinding.get()).toBe(nodeBinding);
    }
  });
});
