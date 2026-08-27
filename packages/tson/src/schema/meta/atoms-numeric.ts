/**
 * The numeric atom families' resolved constraint vocabularies (§5.6, §9): `integer`,
 * `number` (exact decimal), `float32`/`float64`, `rational`, and `complex`.
 */
import type { Decimal, Rational } from './algebra.js';

/**
 * The meta-kernel's `integer_size` record (§8.1, §9): a fixed-width integer representation,
 * bit width paired with two's-complement signedness — {@link IntegerType.size}'s own field
 * type. `bits` is `bigint` because the kernel's own `bits` field is typed `integer`, the
 * kernel's arbitrary-precision integer, even though every built-in width in practice (8..256)
 * fits comfortably in a plain number.
 */
export interface IntegerSize {
  readonly bits: bigint;
  readonly signed: boolean;
}

/**
 * The meta-kernel's `integer_type` constructor (§5.6, §9): the integer family's atom
 * constraint vocabulary — bit width/signedness (via {@link IntegerSize}), bounds, and a
 * multiple-of constraint.
 *
 * `min`/`exclusiveMin` are mutually exclusive, as are `max`/`exclusiveMax` — the Java
 * original's compact constructor rejects a value carrying both of either pair. This type
 * cannot enforce that exclusion structurally; a resolver MUST never populate both members of
 * either pair on one value.
 *
 * Also an {@link Atom} variant: `integer => !integer_type {}` is a constructor-application
 * instance (§5.5) whose resolved body is this shape with every field absent.
 */
export interface IntegerType {
  readonly kind: 'integer_type';
  readonly size?: IntegerSize;
  readonly min?: bigint;
  readonly exclusiveMin?: bigint;
  readonly max?: bigint;
  readonly exclusiveMax?: bigint;
  readonly multipleOf?: bigint;
}

/**
 * `float_type`'s `ieee_format` selector (§5.6) — `binary32`/`binary64`, IEEE 754-2019's two
 * built-in-annotated formats. meta.tn also defines `BINARY16`/`128`/`256` and the
 * decimal128-family formats; those remain unreached until a schema refines `float_type` with
 * one of them, so this union carries only the two the reference implementation's built-in
 * annotations (`float32`/`float64`) actually produce.
 */
export type FloatFormat = 'BINARY32' | 'BINARY64';

/**
 * The meta-kernel's `float_type` constructor (§5.6's `float32`/`float64` atoms — SQL's
 * approximate tier, IEEE 754-2019).
 *
 * The four `allow*` flags are permissions (may a value be NaN, infinite, subnormal, or
 * negative zero), independent of the `min`/`max` bounds and of each other. `min`/
 * `exclusiveMin` and `max`/`exclusiveMax` are mutually exclusive pairs, the same unenforced
 * invariant {@link IntegerType} carries.
 *
 * Also an {@link Atom} variant: `float32 => !float_type { format: BINARY32 }` and `float64`
 * are constructor-application instances (§5.5) whose resolved bodies are this shape with
 * every `allow*` flag `true` and no bounds.
 */
export interface FloatType {
  readonly kind: 'float_type';
  readonly format: FloatFormat;
  readonly min?: Decimal;
  readonly exclusiveMin?: Decimal;
  readonly max?: Decimal;
  readonly exclusiveMax?: Decimal;
  readonly allowNan: boolean;
  readonly allowInfinity: boolean;
  readonly allowSubnormal: boolean;
  readonly allowNegativeZero: boolean;
}

/**
 * The meta-kernel's `decimal_type` constructor (§5.6's `number` atom — SQL's exact tier,
 * ISO/IEC 11404 `scaled`).
 *
 * `totalDigits`/`fractionDigits` are SQL's own `DECIMAL(precision, scale)` pair: the total
 * significant digits permitted, and how many of them fall after the point. `min`/
 * `exclusiveMin` and `max`/`exclusiveMax` are mutually exclusive pairs, the same unenforced
 * invariant {@link IntegerType} carries.
 *
 * Also an {@link Atom} variant: `number => !decimal_type {}` is a constructor-application
 * instance (§5.5) whose resolved body is this shape with every field absent.
 */
export interface DecimalType {
  readonly kind: 'decimal_type';
  readonly min?: Decimal;
  readonly exclusiveMin?: Decimal;
  readonly max?: Decimal;
  readonly exclusiveMax?: Decimal;
  readonly multipleOf?: Decimal;
  readonly totalDigits?: number;
  readonly fractionDigits?: number;
}

/**
 * The meta-kernel's `rational_type` constructor (§5.6's `rational` atom): bounds and a
 * multiple-of constraint over exact fractions.
 *
 * `min`/`exclusiveMin` and `max`/`exclusiveMax` are mutually exclusive pairs, the same
 * unenforced invariant {@link IntegerType} carries; bounds compare by {@link Rational}'s own
 * cross-multiplication value equality, not by field equality (`2/4` restates `1/2`).
 *
 * Also an {@link Atom} variant: `rational => !rational_type {}` is a constructor-application
 * instance (§5.5) whose resolved body is this shape with every field absent.
 */
export interface RationalType {
  readonly kind: 'rational_type';
  readonly min?: Rational;
  readonly exclusiveMin?: Rational;
  readonly max?: Rational;
  readonly exclusiveMax?: Rational;
  readonly multipleOf?: Rational;
}

/**
 * `complex_type`'s `complex_component` selector (§9) — which numeric family backs a
 * complex value's real and imaginary parts, mirroring meta.tn's own five-member `!enum
 * [INTEGER NUMBER RATIONAL FLOAT32 FLOAT64]`.
 */
export type ComplexComponent = 'INTEGER' | 'NUMBER' | 'RATIONAL' | 'FLOAT32' | 'FLOAT64';

/**
 * meta.tn's `complex_type` constructor (`complex_type => ~atom & { component:
 * complex_component ~ NUMBER }`): `component` narrows the numeric family used for the
 * real/imaginary parts, defaulting to `NUMBER` (the exact-decimal tier) at the schema level
 * — this type carries no default of its own, since defaulting is a schema-load concern, not
 * part of the resolved value's own shape.
 *
 * Also an {@link Atom} variant: `complex => !complex_type {}` is a constructor-application
 * instance (§5.5) whose resolved body is this shape with `component: 'NUMBER'`.
 */
export interface ComplexType {
  readonly kind: 'complex_type';
  readonly component: ComplexComponent;
}
