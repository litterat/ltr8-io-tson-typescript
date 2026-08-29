/**
 * §5.2/§9: `decimal_type`, `float_type` and `rational_type` all declare their `min`/
 * `exclusive_min`/`max`/`exclusive_max`/`multiple_of` bounds as meta-kernel's universal-atom
 * `value` (`spec/m/meta.tn`), not as their own family's atom (`number`/`rational`) -- so the
 * token is settled by [TSON-DATA] §4 base type resolution, never by the constrained family's own
 * atom parser (§5.2). `schema/bindings.ts`'s `decimalBinding`/`rationalBinding` bridge from
 * whatever that position's own decoder currently hands back, which is always plain token text
 * today (`schema/metaReader.ts`'s `metaAtomDecoder` has no case for `'number'`/`'rational'`) --
 * this file is the regression gate for that bridge staying total over every spelling §4 admits,
 * using the real bundled `meta.tn`/`core.tn` (`compiler-schema-fixtures.ts`'s `resolveUserSchema`)
 * the way a real caller would load a schema.
 */
import { describe, expect, it } from 'vitest';
import { resolveUserSchema } from './compiler-schema-fixtures.js';
import { decimalBinding, rationalBinding } from '../src/schema/bindings.js';
import { TsonSchemaValidationError } from '../src/core/errors.js';
import type { DecimalType, FloatType, RationalType } from '../src/schema/meta/atoms-numeric.js';

const HEADER = `!!id:"https://example.com/t.tn"
!!meta:"https://tson.io/2026/34/m/meta.tn"
!!import:"https://tson.io/2026/34/m/core.tn"
`;

function bodyOf(source: string, name = 'q'): unknown {
  const linked = resolveUserSchema(`${HEADER}${source}`);
  const def = linked.entries.get(name);
  if (def === undefined) throw new Error(`declaration '${name}' missing from resolved schema`);
  return def.body;
}

function decimalTypeOf(source: string, name = 'q'): DecimalType {
  const body = bodyOf(source, name);
  if ((body as { readonly kind?: unknown }).kind !== 'decimal_type') {
    throw new Error(`expected a decimal_type body, got ${JSON.stringify(body)}`);
  }
  return body as DecimalType;
}

function floatTypeOf(source: string, name = 'q'): FloatType {
  const body = bodyOf(source, name);
  if ((body as { readonly kind?: unknown }).kind !== 'float_type') {
    throw new Error(`expected a float_type body, got ${JSON.stringify(body)}`);
  }
  return body as FloatType;
}

function rationalTypeOf(source: string, name = 'q'): RationalType {
  const body = bodyOf(source, name);
  if ((body as { readonly kind?: unknown }).kind !== 'rational_type') {
    throw new Error(`expected a rational_type body, got ${JSON.stringify(body)}`);
  }
  return body as RationalType;
}

describe("decimal_type ('!number ^ { ... }') -- min/max no longer NaN out compareDecimal (§5.6, §5.7)", () => {
  it('a plain-integer bound pair resolves to real Decimal values and compiles clean', () => {
    const t = decimalTypeOf('{ q => !number ^ { min: 1  max: 2 } }');
    expect(t.min).toEqual({ unscaledValue: 1n, scale: 0 });
    expect(t.max).toEqual({ unscaledValue: 2n, scale: 0 });
  });

  it('a fractional multiple_of resolves to its exact scale, not a false "is zero" (§7.2)', () => {
    const t = decimalTypeOf('{ q => !number ^ { multiple_of: 0.25 } }');
    expect(t.multipleOf).toEqual({ unscaledValue: 25n, scale: 2 });
  });

  it('every §4.3 numeric spelling narrows to the same exact value', () => {
    expect(decimalTypeOf('{ q => !number ^ { min: 1.0 } }').min).toEqual({
      unscaledValue: 10n,
      scale: 1,
    });
    expect(decimalTypeOf('{ q => !number ^ { min: 0x10 } }').min).toEqual({
      unscaledValue: 16n,
      scale: 0,
    });
    expect(decimalTypeOf('{ q => !number ^ { min: 1e3 } }').min).toEqual({
      unscaledValue: 1n,
      scale: -3,
    });
    expect(decimalTypeOf('{ q => !number ^ { min: -90 } }').min).toEqual({
      unscaledValue: -90n,
      scale: 0,
    });
  });

  it('min: 2 max: 1 is still refused as incoherent (§7.2), not silently accepted', () => {
    expect(() => bodyOf('{ q => !number ^ { min: 2  max: 1 } }')).toThrow(
      TsonSchemaValidationError,
    );
    expect(() => bodyOf('{ q => !number ^ { min: 2  max: 1 } }')).toThrow(/contradict/);
  });

  it('multiple_of: 0 is still refused as dividing nothing (§7.2), not masked by the fix', () => {
    expect(() => bodyOf('{ q => !number ^ { multiple_of: 0 } }')).toThrow(
      /is zero, which divides nothing/,
    );
  });

  it('a coherent bound pair with a compatible multiple_of compiles clean', () => {
    const t = decimalTypeOf('{ q => !number ^ { min: 0  max: 10  multiple_of: 0.5 } }');
    expect(t.min).toEqual({ unscaledValue: 0n, scale: 0 });
    expect(t.max).toEqual({ unscaledValue: 10n, scale: 0 });
    expect(t.multipleOf).toEqual({ unscaledValue: 5n, scale: 1 });
  });
});

describe("float_type ('!float64 ^ { ... }') -- the same value-typed bounds, a different family (§5.6)", () => {
  it('an integer-valued min/max pair resolves and compiles clean', () => {
    const t = floatTypeOf('{ q => !float64 ^ { min: 0  max: 1 } }');
    expect(t.format).toBe('BINARY64');
    expect(t.min).toEqual({ unscaledValue: 0n, scale: 0 });
    expect(t.max).toEqual({ unscaledValue: 1n, scale: 0 });
  });

  it('a fractional bound pair resolves to its exact value', () => {
    const t = floatTypeOf('{ q => !float64 ^ { min: -1.5  max: 1.5 } }');
    expect(t.min).toEqual({ unscaledValue: -15n, scale: 1 });
    expect(t.max).toEqual({ unscaledValue: 15n, scale: 1 });
  });

  it('min: 2 max: 1 is still refused as incoherent', () => {
    expect(() => bodyOf('{ q => !float64 ^ { min: 2  max: 1 } }')).toThrow(/contradict/);
  });
});

describe("rational_type ('!rational ^ { ... }') -- the same defect, masked rather than absent before the fix", () => {
  it('an integer bound narrows to n/1', () => {
    const t = rationalTypeOf('{ q => !rational ^ { min: 1  max: 2 } }');
    expect(t.min).toEqual({ numerator: 1n, denominator: 1n });
    expect(t.max).toEqual({ numerator: 2n, denominator: 1n });
  });

  it('a quoted "a/b" bound (§7.6\'s extended rational form) parses to its own numerator/denominator', () => {
    const t = rationalTypeOf('{ q => !rational ^ { min: "1/2"  max: "3/2" } }');
    expect(t.min).toEqual({ numerator: 1n, denominator: 2n });
    expect(t.max).toEqual({ numerator: 3n, denominator: 2n });
  });

  it('multiple_of: 0 is refused, no longer silently treated as a no-op comparison', () => {
    expect(() => bodyOf('{ q => !rational ^ { multiple_of: 0 } }')).toThrow(
      /is zero, which divides nothing/,
    );
  });

  it('min: 2 max: 1 is refused as incoherent -- before the fix, both were undefined `numerator`s and every comparison silently read as equal', () => {
    expect(() => bodyOf('{ q => !rational ^ { min: 2  max: 1 } }')).toThrow(/contradict/);
  });
});

describe('a chained refinement re-encodes an already-bound Decimal/Rational bound (§5.6, §5.7)', () => {
  it("decimalBinding's write direction is untouched by the fix -- still the real 'number' atom's own formatting", () => {
    if (decimalBinding.kind !== 'bridge') throw new Error('expected a bridge');
    expect(decimalBinding.toWire({ unscaledValue: 25n, scale: 2 })).toEqual({
      unscaled: 25n,
      exponent: -2,
    });
  });

  it("rationalBinding's write direction is untouched by the fix -- still numerator/denominator verbatim", () => {
    if (rationalBinding.kind !== 'bridge') throw new Error('expected a bridge');
    expect(rationalBinding.toWire({ numerator: 3n, denominator: 2n })).toEqual({
      numerator: 3n,
      denominator: 2n,
    });
  });
});

describe("decimalBinding/rationalBinding read direction is total, per this file's own top doc", () => {
  it('decimalBinding.fromWire accepts a bigint (the shape an integer §4 bound could narrow to), raw token text, and an already-shaped TsonDecimal', () => {
    if (decimalBinding.kind !== 'bridge') throw new Error('expected a bridge');
    expect(decimalBinding.fromWire(5n)).toEqual({ unscaledValue: 5n, scale: 0 });
    expect(decimalBinding.fromWire('1.25')).toEqual({ unscaledValue: 125n, scale: 2 });
    expect(decimalBinding.fromWire('0x10')).toEqual({ unscaledValue: 16n, scale: 0 });
    expect(decimalBinding.fromWire({ unscaled: 3n, exponent: -1 })).toEqual({
      unscaledValue: 3n,
      scale: 1,
    });
  });

  it("decimalBinding.fromWire rejects text that isn't a number at all, rather than silently producing NaN", () => {
    const binding = decimalBinding;
    if (binding.kind !== 'bridge') throw new Error('expected a bridge');
    expect(() => binding.fromWire('not-a-number')).toThrow();
  });

  it('rationalBinding.fromWire accepts a bigint, a quoted "a/b" form, and an already-shaped Rational', () => {
    if (rationalBinding.kind !== 'bridge') throw new Error('expected a bridge');
    expect(rationalBinding.fromWire(5n)).toEqual({ numerator: 5n, denominator: 1n });
    expect(rationalBinding.fromWire('2/3')).toEqual({ numerator: 2n, denominator: 3n });
    expect(rationalBinding.fromWire({ numerator: 1n, denominator: 4n })).toEqual({
      numerator: 1n,
      denominator: 4n,
    });
  });

  it('rationalBinding.fromWire rejects text that is neither a rational nor an integer', () => {
    const binding = rationalBinding;
    if (binding.kind !== 'bridge') throw new Error('expected a bridge');
    expect(() => binding.fromWire('not-a-rational')).toThrow();
  });
});
