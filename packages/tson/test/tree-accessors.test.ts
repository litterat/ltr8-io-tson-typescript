import { describe, expect, it } from 'vitest';
import {
  ABSENT,
  arrayNode,
  atomNode,
  mapNode,
  missingNode,
  recordNode,
  tupleNode,
  type Value,
} from '../src/tree/nodes.js';
import {
  as,
  asDecimal,
  asDouble,
  asInt,
  asLong,
  asString,
  at,
  get,
} from '../src/tree/accessors.js';

/**
 * `tree/accessors.ts` — navigation and typed access over the `Value` tree. Ported from
 * `TsonValueTest` (`tson-tree`), rewritten against the spec sections that govern each node kind
 * (§2.5 record, §2.6 map, §2.7 array; [TSON-SCHEMA] gives tuples) and against `tree/nodes.ts`'s own
 * TSDoc, which is the governing contract for navigation and the two accessor families — RFC 6901
 * pointer walking and the cast/convert split are a tree-model addition the base spec doesn't state.
 */

// A small person-ish tree: { name: "Ada"  age: !int32 30  skills: ["a" "b"]  address: { city: "London" } }
function sample(): Value {
  const fields = new Map<string, Value>([
    ['name', atomNode('Ada')],
    ['age', atomNode(30n, 'int32')],
    ['skills', arrayNode([atomNode('a'), atomNode('b')])],
    ['address', recordNode(new Map([['city', atomNode('London')]]))],
  ]);
  return recordNode(fields);
}

describe('get navigates one step and never throws (§2.5 record, §2.7 array)', () => {
  it('looks up a record field by name', () => {
    const person = sample();
    expect(asString(get(person, 'name'))).toBe('Ada');
    expect(get(person, 'nope').kind).toBe('missing');
  });

  it('is bounds-safe over an array', () => {
    const skills = get(sample(), 'skills');
    expect(asString(get(skills, 1))).toBe('b');
    expect(get(skills, 99).kind).toBe('missing');
    expect(get(skills, -1).kind).toBe('missing');
  });

  it('is bounds-safe over a tuple, distinctly from array (§5.4 [TSON-SCHEMA])', () => {
    const tuple = tupleNode([atomNode('a'), atomNode('b')]);
    expect(asString(get(tuple, 0))).toBe('a');
    expect(get(tuple, 5).kind).toBe('missing');
  });

  it('a deep chain through a missing step stays missing rather than throwing', () => {
    const person = sample();
    expect(get(get(get(person, 'nope'), 'deeper'), 0).kind).toBe('missing');
  });
});

describe('map get matches an entry whose key is a string atom equal to the name (§2.6)', () => {
  it('finds an entry by its typed key', () => {
    const map = mapNode([
      { key: atomNode('one'), value: atomNode(1n) },
      { key: atomNode('two'), value: atomNode(2n) },
    ]);
    expect(asLong(get(map, 'two'))).toBe(2n);
    expect(get(map, 'three').kind).toBe('missing');
  });

  it('a non-string key never matches a name lookup', () => {
    const map = mapNode([{ key: atomNode(true), value: atomNode('yes') }]);
    expect(get(map, 'true').kind).toBe('missing');
  });
});

describe('at resolves RFC 6901 pointers relative to the receiving node', () => {
  it('the empty pointer is the node itself', () => {
    const person = sample();
    expect(at(person, '')).toBe(person);
  });

  it('walks nested fields and indices', () => {
    const person = sample();
    expect(asString(at(person, '/name'))).toBe('Ada');
    expect(asString(at(person, '/skills/1'))).toBe('b');
    expect(asString(at(person, '/address/city'))).toBe('London');
  });

  it('a failed step is missing, and a non-integer token against an array fails at that token', () => {
    const person = sample();
    expect(at(person, '/skills/99').kind).toBe('missing');
    expect(at(person, '/no/such/path').kind).toBe('missing');
    expect(at(person, '/skills/first').kind).toBe('missing');
  });

  it('unescapes ~1 to / and ~0 to ~, in that order, so ~01 decodes to ~1', () => {
    const fields = new Map<string, Value>([
      ['a/b', atomNode('slash')],
      ['m~n', atomNode('tilde')],
      ['~1', atomNode('literal-tilde-one')],
    ]);
    const node = recordNode(fields);
    expect(asString(at(node, '/a~1b'))).toBe('slash');
    expect(asString(at(node, '/m~0n'))).toBe('tilde');
    expect(asString(at(node, '/~01'))).toBe('literal-tilde-one');
  });

  it('a malformed pointer never throws; it comes back missing at the whole string', () => {
    // Deliberate divergence from the Java (which throws IllegalArgumentException here) — see
    // accessors.ts's own TSDoc: every accessor in this port is total.
    const missing = at(sample(), 'name');
    expect(missing.kind).toBe('missing');
    expect(missing.kind === 'missing' && missing.path).toBe('name');
  });
});

describe('a missing node carries the pointer of the step that failed, and it sticks', () => {
  it('reports the failing step, not the whole pointer asked for', () => {
    const person = sample();
    const missing = at(person, '/address/city2/nope');
    expect(missing.kind === 'missing' && missing.path).toBe('/address/city2');
  });

  it('a bare get is relative to its own receiver, the only frame a node has', () => {
    const missing = get(get(sample(), 'address'), 'city2');
    expect(missing.kind === 'missing' && missing.path).toBe('/city2');
  });

  it('further navigation past a missing node neither extends nor replaces its path', () => {
    const missing = at(sample(), '/nope');
    const further = at(get(get(missing, 'deeper'), 0), '/further');
    expect(further.kind === 'missing' && further.path).toBe('/nope');
  });

  it('escapes a field name containing pointer metacharacters into a well-formed pointer', () => {
    const node = recordNode(new Map([['a', atomNode('x')]]));
    const missing = get(node, 'a/b~c');
    expect(missing.kind === 'missing' && missing.path).toBe('/a~1b~0c');
  });
});

describe('absent and missing are distinct kinds (§2.9)', () => {
  it('absent is a written sentinel; missing is a navigation artifact', () => {
    expect(ABSENT.kind).toBe('absent');
    expect(missingNode('/x').kind).toBe('missing');
  });

  it('an absent element still occupies its positional slot in an array', () => {
    const array = arrayNode([atomNode(1n), ABSENT, atomNode(3n)]);
    expect(get(array, 1).kind).toBe('absent');
    expect(asLong(get(array, 2))).toBe(3n);
  });
});

describe('as/asString/asBoolean/asDecimal cast, never convert', () => {
  it('as() casts via the supplied guard and never coerces', () => {
    const node = atomNode(true);
    const asStringGuard = (value: unknown): value is string => typeof value === 'string';
    expect(as(node, asStringGuard)).toBeUndefined();
    const asBooleanGuard = (value: unknown): value is boolean => typeof value === 'boolean';
    expect(as(node, asBooleanGuard)).toBe(true);
  });

  it('a non-atom yields undefined for every cast rather than throwing', () => {
    const person = sample();
    expect(asString(person)).toBeUndefined();
    expect(asString(get(person, 'nope'))).toBeUndefined();
  });

  it('an int32 atom casts as its own host type, never as a decimal', () => {
    // §5.6: int8..int32 narrow to `number`; only asString/asBoolean/asDecimal are casts, and none
    // of them match a `number`-valued atom.
    const node = atomNode(7, 'int32');
    expect(asDecimal(node)).toBeUndefined();
    expect(asString(node)).toBeUndefined();
  });

  it('casts the exact-decimal host type for !number atoms (§5.6)', () => {
    const decimal = { unscaled: 5n, exponent: -1 };
    const node = atomNode(decimal, 'number');
    expect(asDecimal(node)).toEqual(decimal);
  });
});

describe('asInt/asLong/asDouble convert exactly or give up', () => {
  it('an integral fractional part converts; a real one does not', () => {
    expect(asInt(atomNode({ unscaled: 1230n, exponent: -1 }))).toBe(123); // 123.0
    expect(asInt(atomNode({ unscaled: 23456n, exponent: 0 }))).toBe(23456); // 234.56E2
    expect(asInt(atomNode({ unscaled: 3456n, exponent: -1 }))).toBeUndefined(); // 345.6
  });

  it('a bigint atom converts to int/long directly, no fractional part to check', () => {
    // int64 (§5.6) narrows to bigint; asInt still succeeds when the magnitude fits int32.
    expect(asInt(atomNode(30n, 'int64'))).toBe(30);
    expect(asLong(atomNode(30n, 'int64'))).toBe(30n);
    expect(asDouble(atomNode(30n, 'int64'))).toBe(30);
  });

  it('a magnitude outside int32 range fails asInt but not asLong', () => {
    const big = atomNode(9007199254740993n);
    expect(asInt(big)).toBeUndefined();
    expect(asLong(big)).toBe(9007199254740993n);
  });

  it('asLong has no width limit beyond exactness, unlike Java asLong()', () => {
    // Deliberate divergence stated in tree/nodes.ts's own TSDoc for AsLong: bigint has no upper
    // bound, so only exactness is checked, not a 64-bit long range.
    const beyondInt64 = 2n ** 80n;
    expect(asLong(atomNode(beyondInt64))).toBe(beyondInt64);
  });

  it('text is never parsed back into a number (§4.4)', () => {
    expect(asInt(atomNode('42'))).toBeUndefined();
    expect(asDouble(atomNode('42'))).toBeUndefined();
    expect(asInt(atomNode(true))).toBeUndefined();
  });

  it('a non-atom, and a missing node, convert to undefined rather than throwing', () => {
    expect(asInt(sample())).toBeUndefined();
    expect(asLong(get(sample(), 'nope'))).toBeUndefined();
    expect(asDouble(ABSENT)).toBeUndefined();
  });

  it('rounds a decimal to the nearest double, printed-form exact for 0.1', () => {
    // 0.1 has no exact binary form; the accessor still reads it as the double 0.1 prints as,
    // matching what an author wrote (see decimalOfNumberPrintedForm's own TSDoc).
    expect(asDouble(atomNode({ unscaled: 1n, exponent: -1 }))).toBe(0.1);
  });

  it('a magnitude too large to be finite yields undefined, never Infinity', () => {
    const huge = atomNode({ unscaled: 1n, exponent: 400 });
    expect(asDouble(huge)).toBeUndefined();
  });

  it('a number-valued atom (already-narrowed float) converts through its printed form', () => {
    expect(asDouble(atomNode(0.1, 'float64'))).toBe(0.1);
    expect(asInt(atomNode(3.0, 'float64'))).toBe(3);
    expect(asInt(atomNode(0.1, 'float64'))).toBeUndefined();
  });

  it('rationals and complexes have no numeric reading, matching the Java asNumber() boundary', () => {
    expect(asInt(atomNode({ numerator: 1n, denominator: 2n }))).toBeUndefined();
    expect(
      asDouble(
        atomNode({
          real: { unscaled: 3n, exponent: 0 },
          imaginary: { unscaled: 4n, exponent: 0 },
        }),
      ),
    ).toBeUndefined();
  });
});
