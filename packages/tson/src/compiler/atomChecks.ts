/**
 * `definitionResolver.ts`'s own §5.5/§5.7 questions about an atom body: does a refinement
 * *tighten* its source rather than loosen it ({@link checkAtomNarrows}, consulted by
 * `checkNarrows`), and does a body's own constraint fields *contradict* each other
 * ({@link checkAtomCoherence}, consulted by `checkCoherent`)?
 *
 * A direct port of the reference implementation's per-family `Atom#constraintsCheck`/
 * `#coherenceCheck` overrides (`tson-schema/.../meta/*Type.java`) — each family there is a
 * `record` overriding two `default` interface methods; `schema/meta`'s own port deliberately
 * drops both (`typedef.ts`'s own doc: "this package ports only the *shape* of each family...
 * never the narrowing/coherence rules... those are resolver logic for a later work package"),
 * so they land here instead, as one dispatch per question rather than twenty small overrides —
 * idiomatic for a closed union switched on `kind`, where Java needed one class per case to hang
 * an override off of.
 *
 * Both functions are total over `Atom`'s own members: a family with no orderable facet at all
 * (`Unit`, and every pure-selector family — `ComplexType`, `UuidType`, `Ipv4Type`, `Ipv6Type`,
 * `MacType`) or one whose bounds are unparsed text (`DurationType`, deliberately left ordered by
 * nothing — see its own doc) returns no violations, matching each Java override's own default or
 * explicit no-op.
 */
import type { Atom, Top } from '../schema/meta/typedef.js';
import type {
  DecimalType,
  FloatType,
  IntegerSize,
  IntegerType,
  RationalType,
} from '../schema/meta/atoms-numeric.js';
import type { BinaryType } from '../schema/meta/atoms-text.js';
import type { DateTimeType, DateType, TimeType } from '../schema/meta/atoms-temporal.js';
import type { Cidr4Type, Cidr6Type } from '../schema/meta/atoms-network.js';
import type { EnumBody } from '../schema/meta/bodies.js';
import type { Decimal, Rational } from '../schema/meta/algebra.js';
import {
  type Bound,
  bound,
  checkAtLeast,
  checkAtMost,
  checkLower,
  checkOnlyWithdraws,
  checkSubset,
  checkUpper,
  tighterLower,
  tighterUpper,
} from './atomNarrowing.js';
import {
  checkNonNegative,
  checkOrdered,
  checkPositiveStep,
  checkRange,
  checkWithin,
} from './atomCoherence.js';
import {
  compareBigint,
  compareCalendarDate,
  compareDecimal,
  compareNumber,
  compareOffsetDateTime,
  compareOffsetTime,
  compareRational,
} from './atomComparators.js';

// ── integer_type ─────────────────────────────────────────────────────────────────────────────

/** The widest `IntegerSize.bits` a derived range is materialised for — matching the Java original's own `MAX_DERIVED_BITS`, above which an implied range would allocate an arbitrarily large bound from one schema declaration. */
const MAX_DERIVED_BITS = 4096n;

function derivedBits(size: IntegerSize | undefined): number | undefined {
  if (size === undefined || size.bits <= 0n || size.bits > MAX_DERIVED_BITS) return undefined;
  return Number(size.bits);
}

function sizeLower(size: IntegerSize | undefined): Bound<bigint> | undefined {
  const bits = derivedBits(size);
  if (bits === undefined || size === undefined) return undefined;
  return { value: size.signed ? -(1n << BigInt(bits - 1)) : 0n, inclusive: true, facet: 'size' };
}

function sizeUpper(size: IntegerSize | undefined): Bound<bigint> | undefined {
  const bits = derivedBits(size);
  if (bits === undefined || size === undefined) return undefined;
  const ceiling = (1n << BigInt(size.signed ? bits - 1 : bits)) - 1n;
  return { value: ceiling, inclusive: true, facet: 'size' };
}

function integerEffectiveLower(t: IntegerType): Bound<bigint> | undefined {
  return tighterLower(
    sizeLower(t.size),
    bound(t.min, t.exclusiveMin, 'min', 'exclusive_min'),
    compareBigint,
  );
}

function integerEffectiveUpper(t: IntegerType): Bound<bigint> | undefined {
  return tighterUpper(
    sizeUpper(t.size),
    bound(t.max, t.exclusiveMax, 'max', 'exclusive_max'),
    compareBigint,
  );
}

function integerNarrows(source: IntegerType, refined: IntegerType): string[] {
  const out: string[] = [];
  checkLower(out, integerEffectiveLower(source), integerEffectiveLower(refined), compareBigint);
  checkUpper(out, integerEffectiveUpper(source), integerEffectiveUpper(refined), compareBigint);
  checkLower(out, sizeLower(source.size), sizeLower(refined.size), compareBigint);
  checkUpper(out, sizeUpper(source.size), sizeUpper(refined.size), compareBigint);
  if (
    source.multipleOf !== undefined &&
    refined.multipleOf !== undefined &&
    refined.multipleOf % source.multipleOf !== 0n
  ) {
    out.push(
      `multiple_of ${String(refined.multipleOf)} is not itself a multiple of the source's own ${String(source.multipleOf)}`,
    );
  }
  return out;
}

function integerSignum(v: bigint): number {
  return v > 0n ? 1 : v < 0n ? -1 : 0;
}

/**
 * Judged on the *effective* range (folding `size` in), unlike {@link integerNarrows}'s
 * source-vs-refined comparison: there is no second body to compare against here, and an implied
 * bound constrains as firmly as a written one — `{ size: { bits: 8 signed: false } min: 300 }` is
 * caught by the same comparison that catches `min: 10 max: 3`.
 */
function integerCoherence(t: IntegerType): string[] {
  const out: string[] = [];
  checkRange(out, integerEffectiveLower(t), integerEffectiveUpper(t), compareBigint);
  checkPositiveStep(out, 'multiple_of', t.multipleOf, integerSignum);
  return out;
}

// ── float_type ───────────────────────────────────────────────────────────────────────────────

function floatNarrows(source: FloatType, refined: FloatType): string[] {
  const out: string[] = [];
  checkLower(
    out,
    bound(source.min, source.exclusiveMin, 'min', 'exclusive_min'),
    bound(refined.min, refined.exclusiveMin, 'min', 'exclusive_min'),
    compareDecimal,
  );
  checkUpper(
    out,
    bound(source.max, source.exclusiveMax, 'max', 'exclusive_max'),
    bound(refined.max, refined.exclusiveMax, 'max', 'exclusive_max'),
    compareDecimal,
  );
  checkOnlyWithdraws(out, 'allow_nan', source.allowNan, refined.allowNan);
  checkOnlyWithdraws(out, 'allow_infinity', source.allowInfinity, refined.allowInfinity);
  checkOnlyWithdraws(out, 'allow_subnormal', source.allowSubnormal, refined.allowSubnormal);
  checkOnlyWithdraws(
    out,
    'allow_negative_zero',
    source.allowNegativeZero,
    refined.allowNegativeZero,
  );
  return out;
}

function floatCoherence(t: FloatType): string[] {
  const out: string[] = [];
  checkRange(
    out,
    bound(t.min, t.exclusiveMin, 'min', 'exclusive_min'),
    bound(t.max, t.exclusiveMax, 'max', 'exclusive_max'),
    compareDecimal,
  );
  return out;
}

// ── decimal_type ─────────────────────────────────────────────────────────────────────────────

/** `x` is an exact multiple of `y` (both `Decimal`s) — scale both to a common exponent and divide as integers, which preserves the "multiple of" relation exactly. */
function decimalIsMultiple(x: Decimal, y: Decimal): boolean {
  const scale = Math.max(x.scale, y.scale);
  const xv = x.unscaledValue * 10n ** BigInt(scale - x.scale);
  const yv = y.unscaledValue * 10n ** BigInt(scale - y.scale);
  return yv !== 0n && xv % yv === 0n;
}

function decimalSignum(d: Decimal): number {
  return d.unscaledValue > 0n ? 1 : d.unscaledValue < 0n ? -1 : 0;
}

function decimalNarrows(source: DecimalType, refined: DecimalType): string[] {
  const out: string[] = [];
  checkLower(
    out,
    bound(source.min, source.exclusiveMin, 'min', 'exclusive_min'),
    bound(refined.min, refined.exclusiveMin, 'min', 'exclusive_min'),
    compareDecimal,
  );
  checkUpper(
    out,
    bound(source.max, source.exclusiveMax, 'max', 'exclusive_max'),
    bound(refined.max, refined.exclusiveMax, 'max', 'exclusive_max'),
    compareDecimal,
  );
  checkAtMost(out, 'total_digits', source.totalDigits, refined.totalDigits, compareNumber);
  checkAtMost(out, 'fraction_digits', source.fractionDigits, refined.fractionDigits, compareNumber);
  if (
    source.multipleOf !== undefined &&
    refined.multipleOf !== undefined &&
    decimalSignum(source.multipleOf) !== 0 &&
    !decimalIsMultiple(refined.multipleOf, source.multipleOf)
  ) {
    out.push(
      `multiple_of ${String(refined.multipleOf.unscaledValue)}e${String(-refined.multipleOf.scale)} is not itself a multiple of the source's own ${String(source.multipleOf.unscaledValue)}e${String(-source.multipleOf.scale)}`,
    );
  }
  return out;
}

function decimalCoherence(t: DecimalType): string[] {
  const out: string[] = [];
  checkRange(
    out,
    bound(t.min, t.exclusiveMin, 'min', 'exclusive_min'),
    bound(t.max, t.exclusiveMax, 'max', 'exclusive_max'),
    compareDecimal,
  );
  checkPositiveStep(out, 'multiple_of', t.multipleOf, decimalSignum);
  checkNonNegative(out, 'total_digits', t.totalDigits);
  checkNonNegative(out, 'fraction_digits', t.fractionDigits);
  checkOrdered(
    out,
    'fraction_digits',
    t.fractionDigits,
    'total_digits',
    t.totalDigits,
    compareNumber,
  );
  return out;
}

// ── rational_type ────────────────────────────────────────────────────────────────────────────

/** Whether `step` divides evenly into `of` — a zero `of` admits nothing to check against. */
function isIntegerMultiple(step: Rational, of: Rational): boolean {
  if (of.numerator === 0n) return true;
  const dividend = step.numerator * of.denominator;
  const divisor = step.denominator * of.numerator;
  return dividend % divisor === 0n;
}

function rationalSignum(r: Rational): number {
  return r.numerator > 0n ? 1 : r.numerator < 0n ? -1 : 0;
}

function rationalNarrows(source: RationalType, refined: RationalType): string[] {
  const out: string[] = [];
  checkLower(
    out,
    bound(source.min, source.exclusiveMin, 'min', 'exclusive_min'),
    bound(refined.min, refined.exclusiveMin, 'min', 'exclusive_min'),
    compareRational,
  );
  checkUpper(
    out,
    bound(source.max, source.exclusiveMax, 'max', 'exclusive_max'),
    bound(refined.max, refined.exclusiveMax, 'max', 'exclusive_max'),
    compareRational,
  );
  if (
    source.multipleOf !== undefined &&
    refined.multipleOf !== undefined &&
    !isIntegerMultiple(refined.multipleOf, source.multipleOf)
  ) {
    out.push(
      `multiple_of ${String(refined.multipleOf.numerator)}/${String(refined.multipleOf.denominator)} is not itself a multiple of the source's own ${String(source.multipleOf.numerator)}/${String(source.multipleOf.denominator)}`,
    );
  }
  return out;
}

function rationalCoherence(t: RationalType): string[] {
  const out: string[] = [];
  checkRange(
    out,
    bound(t.min, t.exclusiveMin, 'min', 'exclusive_min'),
    bound(t.max, t.exclusiveMax, 'max', 'exclusive_max'),
    compareRational,
  );
  checkPositiveStep(out, 'multiple_of', t.multipleOf, rationalSignum);
  return out;
}

// ── text-shaped families: text_type, binary, regex_type, uri_type, email_type ──────────────────

interface TextConstraints {
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly length?: number;
}

function effectiveMinLength(t: TextConstraints): number | undefined {
  return t.minLength ?? t.length;
}

function effectiveMaxLength(t: TextConstraints): number | undefined {
  return t.maxLength ?? t.length;
}

/** `text_type`'s own narrowing rule — reused verbatim by `regex_type`/`uri_type`/`email_type`, which compose `text_type`'s length facets flat (§5.7). */
function textNarrows(source: TextConstraints, refined: TextConstraints): string[] {
  const out: string[] = [];
  checkAtLeast(out, 'min_length', effectiveMinLength(source), refined.minLength, compareNumber);
  checkAtLeast(out, 'length', effectiveMinLength(source), refined.length, compareNumber);
  checkAtMost(out, 'max_length', effectiveMaxLength(source), refined.maxLength, compareNumber);
  checkAtMost(out, 'length', effectiveMaxLength(source), refined.length, compareNumber);
  return out;
}

/** `pattern` is left unchecked here, the same undecidable-facet gap the Java original states: deciding a pattern narrows another needs regular-language containment, which this module has no dependency (`tson-regex`) to reach for. */
function textCoherence(t: TextConstraints): string[] {
  const out: string[] = [];
  checkNonNegative(out, 'min_length', t.minLength);
  checkNonNegative(out, 'max_length', t.maxLength);
  checkNonNegative(out, 'length', t.length);
  checkOrdered(out, 'min_length', t.minLength, 'max_length', t.maxLength, compareNumber);
  checkOrdered(out, 'min_length', t.minLength, 'length', t.length, compareNumber);
  checkOrdered(out, 'length', t.length, 'max_length', t.maxLength, compareNumber);
  return out;
}

function binaryNarrows(source: BinaryType, refined: BinaryType): string[] {
  const out: string[] = [];
  checkAtLeast(out, 'min_length', source.minLength, refined.minLength, compareNumber);
  checkAtMost(out, 'max_length', source.maxLength, refined.maxLength, compareNumber);
  return out;
}

function binaryCoherence(t: BinaryType): string[] {
  const out: string[] = [];
  checkNonNegative(out, 'min_length', t.minLength);
  checkNonNegative(out, 'max_length', t.maxLength);
  checkOrdered(out, 'min_length', t.minLength, 'max_length', t.maxLength, compareNumber);
  return out;
}

// ── date_type / time_type / datetime_type ───────────────────────────────────────────────────

function dateNarrows(source: DateType, refined: DateType): string[] {
  const out: string[] = [];
  checkAtLeast(out, 'min', source.min, refined.min, compareCalendarDate);
  checkAtMost(out, 'max', source.max, refined.max, compareCalendarDate);
  return out;
}

function dateCoherence(t: DateType): string[] {
  const out: string[] = [];
  checkOrdered(out, 'min', t.min, 'max', t.max, compareCalendarDate);
  return out;
}

function timeNarrows(source: TimeType, refined: TimeType): string[] {
  const out: string[] = [];
  checkAtLeast(out, 'min', source.min, refined.min, compareOffsetTime);
  checkAtMost(out, 'max', source.max, refined.max, compareOffsetTime);
  // `precision` is an upper bound on written fractional-second digits (§5.5), so it refines the
  // way every other upper bound does: a refinement may lower it, never raise it.
  checkAtMost(out, 'precision', source.precision, refined.precision, compareBigint);
  return out;
}

function timeCoherence(t: TimeType): string[] {
  const out: string[] = [];
  checkOrdered(out, 'min', t.min, 'max', t.max, compareOffsetTime);
  return out;
}

function dateTimeNarrows(source: DateTimeType, refined: DateTimeType): string[] {
  const out: string[] = [];
  checkAtLeast(out, 'min', source.min, refined.min, compareOffsetDateTime);
  checkAtMost(out, 'max', source.max, refined.max, compareOffsetDateTime);
  // As for `time`: an upper bound on written digits refines downward only (§5.5).
  checkAtMost(out, 'precision', source.precision, refined.precision, compareBigint);
  return out;
}

function dateTimeCoherence(t: DateTimeType): string[] {
  const out: string[] = [];
  checkOrdered(out, 'min', t.min, 'max', t.max, compareOffsetDateTime);
  return out;
}

// ── cidr4_type / cidr6_type ──────────────────────────────────────────────────────────────────

function cidrNarrows(source: Cidr4Type | Cidr6Type, refined: Cidr4Type | Cidr6Type): string[] {
  const out: string[] = [];
  checkAtLeast(out, 'min_prefix', source.minPrefix, refined.minPrefix, compareNumber);
  checkAtMost(out, 'max_prefix', source.maxPrefix, refined.maxPrefix, compareNumber);
  checkSubset(out, 'within', source.within, refined.within);
  return out;
}

function cidrCoherence(t: Cidr4Type | Cidr6Type, prefixBits: number): string[] {
  const out: string[] = [];
  checkWithin(out, 'min_prefix', t.minPrefix, 0, prefixBits);
  checkWithin(out, 'max_prefix', t.maxPrefix, 0, prefixBits);
  checkOrdered(out, 'min_prefix', t.minPrefix, 'max_prefix', t.maxPrefix, compareNumber);
  return out;
}

// ── enum ─────────────────────────────────────────────────────────────────────────────────────

/**
 * An enum states at least one member (§9). `enum.members` is typed `enum_set`, whose `min_items`
 * is `1`, so `!enum []` describes no value at all and is refused at schema load rather than
 * left to fail against every document.
 */
function enumCoherence(t: EnumBody): string[] {
  return t.members.length === 0
    ? ["'members' is empty, so the enum admits no value -- an enum states at least one member"]
    : [];
}

function enumNarrows(source: EnumBody, refined: EnumBody): string[] {
  const out: string[] = [];
  checkSubset(out, 'members', source.members, refined.members);
  return out;
}

// ── Dispatch ─────────────────────────────────────────────────────────────────────────────────

/**
 * How `refined` fails to narrow `source`'s own constraints — an empty list means it is a valid
 * refinement (§5.7: a refinement tightens, it never loosens). `refined` MUST be the fully merged
 * result of applying a refinement body to `source` (`definitionResolver.ts`'s own
 * `mergeWithSource`), not the refinement body alone, so a facet the body never mentioned still
 * holds `source`'s own value and tightens vacuously.
 *
 * A mismatched pair (comparing an `integer_type` refinement against a `text_type` source, which
 * cannot happen through `resolveAtomRefinement`'s own dispatch — both bodies bind through the
 * same source constructor) reports a single violation naming the mismatch rather than throwing,
 * mirroring each Java override's own `if (!(refined instanceof X other))` guard.
 */
export function checkAtomNarrows(source: Atom, refined: Atom): readonly string[] {
  switch (source.kind) {
    case 'integer_type':
      return refined.kind === 'integer_type'
        ? integerNarrows(source, refined)
        : mismatch('an integer', refined);
    case 'float_type':
      return refined.kind === 'float_type'
        ? floatNarrows(source, refined)
        : mismatch('a float', refined);
    case 'decimal_type':
      return refined.kind === 'decimal_type'
        ? decimalNarrows(source, refined)
        : mismatch('a decimal', refined);
    case 'rational_type':
      return refined.kind === 'rational_type'
        ? rationalNarrows(source, refined)
        : mismatch('a rational', refined);
    case 'text_type':
      return refined.kind === 'text_type'
        ? textNarrows(source, refined)
        : mismatch('text', refined);
    case 'binary':
      return refined.kind === 'binary'
        ? binaryNarrows(source, refined)
        : mismatch('binary', refined);
    case 'regex_type':
      return refined.kind === 'regex_type'
        ? textNarrows(source, refined)
        : mismatch('a regex', refined);
    case 'uri_type':
      return refined.kind === 'uri_type'
        ? textNarrows(source, refined)
        : mismatch('a uri', refined);
    case 'email_type':
      return refined.kind === 'email_type'
        ? textNarrows(source, refined)
        : mismatch('an email', refined);
    case 'date_type':
      return refined.kind === 'date_type'
        ? dateNarrows(source, refined)
        : mismatch('a date', refined);
    case 'time_type':
      return refined.kind === 'time_type'
        ? timeNarrows(source, refined)
        : mismatch('a time', refined);
    case 'datetime_type':
      return refined.kind === 'datetime_type'
        ? dateTimeNarrows(source, refined)
        : mismatch('a datetime', refined);
    case 'cidr4_type':
      return refined.kind === 'cidr4_type'
        ? cidrNarrows(source, refined)
        : mismatch('a cidr4', refined);
    case 'cidr6_type':
      return refined.kind === 'cidr6_type'
        ? cidrNarrows(source, refined)
        : mismatch('a cidr6', refined);
    case 'enum':
      return refined.kind === 'enum' ? enumNarrows(source, refined) : mismatch('an enum', refined);
    // No orderable facet at all: unit, uuid_type, complex_type (a pure selector), uuid/ipv4/ipv6/
    // mac (selector- or spec-only), duration_type (unparsed-text bounds, left ordered by nothing
    // for the reason `atoms-temporal.ts`'s own `DurationType` doc gives).
    case 'unit':
    case 'uuid_type':
    case 'complex_type':
    case 'ipv4_type':
    case 'ipv6_type':
    case 'mac_type':
    case 'duration_type':
      return [];
  }
}

function mismatch(sourceLabel: string, refined: Atom): readonly string[] {
  return [`refines ${sourceLabel} with a ${refined.kind}`];
}

/** Every `Atom` union member's own `kind` literal — used by {@link isAtom} to tell an atom body from every other `Top` shape without importing each family's type just to name it. */
const ATOM_KINDS: ReadonlySet<string> = new Set([
  'unit',
  'enum',
  'integer_type',
  'text_type',
  'uri_type',
  'regex_type',
  'decimal_type',
  'float_type',
  'rational_type',
  'uuid_type',
  'binary',
  'date_type',
  'time_type',
  'datetime_type',
  'duration_type',
  'cidr4_type',
  'cidr6_type',
  'email_type',
  'mac_type',
  'ipv4_type',
  'ipv6_type',
  'complex_type',
]);

/**
 * Whether a resolved body is an `Atom` — the one question `definitionResolver.ts`'s own
 * `checkNarrows`/`checkCoherent` need before consulting {@link checkAtomNarrows}/
 * {@link checkAtomCoherence}, since every other `Top` shape (a container, a sum, a reference, the
 * open `Data` extension point, a held template body) has no constraint facets to narrow or
 * contradict.
 */
export function isAtom(body: Top): body is Atom {
  const kind = (body as { readonly kind?: unknown }).kind;
  return typeof kind === 'string' && ATOM_KINDS.has(kind);
}

/**
 * How a single atom body's own constraint fields contradict each other — an empty list means the
 * body is internally coherent. Nothing but `definitionResolver.ts`'s own `checkCoherent` asks
 * this: a facet pair admitting no value at all otherwise resolves, links and compiles clean, and
 * the mistake would surface (if ever) at a read that rejects every value for reasons the author
 * never sees stated.
 */
export function checkAtomCoherence(atom: Atom): readonly string[] {
  switch (atom.kind) {
    case 'integer_type':
      return integerCoherence(atom);
    case 'float_type':
      return floatCoherence(atom);
    case 'decimal_type':
      return decimalCoherence(atom);
    case 'rational_type':
      return rationalCoherence(atom);
    case 'text_type':
      return textCoherence(atom);
    case 'binary':
      return binaryCoherence(atom);
    case 'regex_type':
      return textCoherence(atom);
    case 'uri_type':
      return textCoherence(atom);
    case 'email_type':
      return textCoherence(atom);
    case 'date_type':
      return dateCoherence(atom);
    case 'time_type':
      return timeCoherence(atom);
    case 'datetime_type':
      return dateTimeCoherence(atom);
    case 'cidr4_type':
      return cidrCoherence(atom, 32);
    case 'cidr6_type':
      return cidrCoherence(atom, 128);
    case 'enum':
      return enumCoherence(atom);
    case 'unit':
    case 'uuid_type':
    case 'complex_type':
    case 'ipv4_type':
    case 'ipv6_type':
    case 'mac_type':
    case 'duration_type':
      return [];
  }
}
