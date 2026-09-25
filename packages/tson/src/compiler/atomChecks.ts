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
 * Both functions are total over `Atom`'s own members: a family with no orderable facet and no
 * selector at all (`Unit`, `UuidType`, `MacType`) returns no violations for both questions, and
 * `ComplexType` (a pure selector, `component`) returns no *coherence* violations — a single
 * field has nothing else to contradict — but does narrow, along `component`'s own partial order
 * (§5.7). The four network families (`Ipv4Type`, `Ipv6Type`, `Cidr4Type`, `Cidr6Type`) all narrow
 * their shared `within`/`excluding` pair the same way ({@link networkNarrows}) — `cidr4_type`/
 * `cidr6_type` add their own prefix-bound narrowing on top — and all four carry a *coherence*
 * obligation: §5.5's `within`/`excluding` pair, plus a network family's own prefix bounds, MUST
 * between them admit a value ({@link networkCoherence}).
 */
import type { Atom, Top } from '../schema/meta/typedef.js';
import type {
  ComplexComponent,
  ComplexType,
  DecimalType,
  FloatFormat,
  FloatType,
  IntegerSize,
  IntegerType,
  RationalType,
} from '../schema/meta/atoms-numeric.js';
import type { BytesType } from '../schema/meta/atoms-bytes.js';
import type {
  DateTimeType,
  DateType,
  DurationType,
  PeriodType,
  TimeType,
} from '../schema/meta/atoms-temporal.js';
import type { Cidr4Type, Cidr6Type, Ipv4Type, Ipv6Type } from '../schema/meta/atoms-network.js';
import type { EnumBody } from '../schema/meta/bodies.js';
import type { Decimal, Rational } from '../schema/meta/algebra.js';
import type { EmailType, UriType } from '../schema/meta/atoms-text.js';
import { parseNetworkBlock, whyNoValue } from '../atom/network/cidrParsing.js';
import { parseIpv4Octets } from '../atom/network/ipv4.js';
import { parseIpv6Bytes } from '../atom/network/ipv6.js';
import { createUriParser } from '../atom/network/uri.js';
import { createEmailParser } from '../atom/network/email.js';
import {
  admitsLower,
  admitsUpper,
  type Bound,
  bound,
  checkAtLeast,
  checkAtMost,
  checkLower,
  checkMemberSubset,
  checkOnlyWithdraws,
  checkSettableOnce,
  checkSubset,
  checkSuperset,
  checkUpper,
  renderBoundValue,
  tighterLower,
  tighterUpper,
} from './atomNarrowing.js';
import { isIdentifierText } from '../unicode/identifier-profile.js';
import { toNfc } from '../unicode/nfc.js';
import { parseRegex } from '../regex/index.js';
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
  compareOffsetDateTime,
  compareOffsetTime,
  compareRational,
} from './atomComparators.js';
import { decimalFractionDigits, decimalOf, decimalPrecision } from '../atom/numeric/decimalMath.js';

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
  checkMemberSubset(out, 'members', source.members, refined.members, (a, b) => a === b);
  return out;
}

function integerSignum(v: bigint): number {
  return v > 0n ? 1 : v < 0n ? -1 : 0;
}

/**
 * §7.4's coherence rule over `integer_type.members`, in the three parts the set's own type states.
 *
 * `members` is typed `integer_member_set => !set_type { element_type: integer }`, and the kernel's
 * `@doc` on it says what that buys: "uniqueness comes from `set`'s own contract, non-emptiness
 * from `min_items` (an empty member set is a body admitting no value at all), and member identity
 * is [TSON-DATA] §4.3's, so `80` and `0x50` are one member and a duplicate rather than two." So:
 *
 * 1. **Non-empty**, inherited from `set_type`'s `min_items ~ 1` — an empty set is §7.4's "a body's
 *    facets MUST between them admit a value" failing outright, the same shape `enumCoherence`
 *    already refuses for `!enum []`.
 * 2. **Unique by VALUE**, not by spelling: the members arrive already `value`-read under the
 *    constrained atom (§5.2), which is the whole reason that reading exists, so `[80 0x50]` is one
 *    member written twice and `[1 1]` likewise.
 * 3. **Each member satisfies the body's other facets** — the bounds and the step, folding an
 *    implied `size` range in exactly as {@link integerCoherence}'s own range check does.
 */
function integerMemberCoherence(t: IntegerType): string[] {
  const out: string[] = [];
  if (t.members === undefined) return out;
  if (t.members.length === 0) {
    return ["'members' is empty, so the body admits no value -- a member set states at least one"];
  }
  const seen = new Set<bigint>();
  for (const member of t.members) {
    if (seen.has(member)) {
      out.push(
        `members states ${renderBoundValue(member)} more than once -- members are compared by value, ` +
          'so two spellings of one number are one member',
      );
    }
    seen.add(member);
  }
  const lower = integerEffectiveLower(t);
  const upper = integerEffectiveUpper(t);
  for (const member of t.members) {
    if (!admitsLower(lower, member, compareBigint) || !admitsUpper(upper, member, compareBigint)) {
      out.push(
        `members includes ${renderBoundValue(member)}, which the body's own bounds do not admit`,
      );
    } else if (t.multipleOf !== undefined && member % t.multipleOf !== 0n) {
      out.push(
        `members includes ${renderBoundValue(member)}, not itself a multiple of ${String(t.multipleOf)}`,
      );
    }
  }
  return out;
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
  out.push(...integerMemberCoherence(t));
  return out;
}

// ── float_type ───────────────────────────────────────────────────────────────────────────────

/**
 * `float_type.format`'s own narrowing relation (§5.5, §5.7, §9): two chains, ranked separately by
 * width -- the binary radix (`BINARY16 ⊂ BINARY32 ⊂ BINARY64 ⊂ BINARY128 ⊂ BINARY256`) and the
 * decimal radix (`DECIMAL32 ⊂ DECIMAL64 ⊂ DECIMAL128`) -- since a narrower format's every value is
 * exactly representable in a wider one *of the same radix*, and the two radices are incomparable:
 * decimal32's grid (base 10) shares no containment either way with any binary format's (base 2).
 * Mirrors {@link EXACT_COMPONENT_RANK}/{@link APPROXIMATE_COMPONENT_RANK}'s own two-chain shape:
 * a refinement may move to a lower rank in the *same* chain only.
 *
 * Keyed by `string`, not {@link FloatFormat} -- `ieee_format` (`spec/m/meta.tn`) declares all
 * eight members this table lists, but `FloatFormat` itself names only the two a built-in
 * annotation (`float32`/`float64`) produces (that type's own doc), so a refinement naming one of
 * the other six reaches this function as a value outside its own declared TypeScript type. Both
 * tables are `Partial`, and a member absent from both -- unreachable today, since this table is
 * total over `ieee_format`'s own members, but a future ninth member would land here -- fails
 * rather than silently narrowing, the same fail-closed reading {@link complexNarrows} gives an
 * unrecognised {@link ComplexComponent}.
 */
const BINARY_FORMAT_RANK: Readonly<Partial<Record<string, number>>> = {
  BINARY16: 0,
  BINARY32: 1,
  BINARY64: 2,
  BINARY128: 3,
  BINARY256: 4,
};
const DECIMAL_FORMAT_RANK: Readonly<Partial<Record<string, number>>> = {
  DECIMAL32: 0,
  DECIMAL64: 1,
  DECIMAL128: 2,
};

function floatFormatNarrows(source: FloatFormat, refined: FloatFormat): boolean {
  if (source === refined) return true;
  const sourceRank = BINARY_FORMAT_RANK[source] ?? DECIMAL_FORMAT_RANK[source];
  const refinedRank = BINARY_FORMAT_RANK[refined] ?? DECIMAL_FORMAT_RANK[refined];
  const sameRadix = source in BINARY_FORMAT_RANK === refined in BINARY_FORMAT_RANK;
  return (
    sameRadix && sourceRank !== undefined && refinedRank !== undefined && refinedRank <= sourceRank
  );
}

function floatNarrows(source: FloatType, refined: FloatType): string[] {
  const out: string[] = [];
  if (!floatFormatNarrows(source.format, refined.format)) {
    out.push(
      `format ${refined.format} does not narrow the source's own ${source.format} -- a refinement may only ` +
        'move to a narrower width within the same radix (§5.7)',
    );
  }
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
  checkAtMost(out, 'total_digits', source.totalDigits, refined.totalDigits, compareBigint);
  checkAtMost(out, 'fraction_digits', source.fractionDigits, refined.fractionDigits, compareBigint);
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
  checkMemberSubset(
    out,
    'members',
    source.members,
    refined.members,
    (a, b) => compareDecimal(a, b) === 0,
  );
  return out;
}

/**
 * {@link integerMemberCoherence}'s twin, over the same three parts: non-empty, unique by value, and
 * every member satisfying the body's own bounds, step and digit-count facets.
 *
 * Uniqueness is where the two differ in mechanism and not in rule. §5.5 makes the exact numeric
 * tiers values with no scale — "`1`, `1.0` and `1.00` are one value" — so `[1 1.0]` is a duplicate,
 * and the check has to compare through {@link compareDecimal} rather than through a host `Set`,
 * which would key on the scale the spelling happened to carry.
 */
function decimalMemberCoherence(t: DecimalType): string[] {
  const out: string[] = [];
  if (t.members === undefined) return out;
  if (t.members.length === 0) {
    return ["'members' is empty, so the body admits no value -- a member set states at least one"];
  }
  t.members.forEach((member, index) => {
    if (t.members?.slice(0, index).some((earlier) => compareDecimal(earlier, member) === 0)) {
      out.push(
        `members states ${renderBoundValue(member)} more than once -- members are compared by value, ` +
          'so 1 and 1.0 are one member (§5.5)',
      );
    }
  });
  const lower = bound(t.min, t.exclusiveMin, 'min', 'exclusive_min');
  const upper = bound(t.max, t.exclusiveMax, 'max', 'exclusive_max');
  for (const member of t.members) {
    if (
      !admitsLower(lower, member, compareDecimal) ||
      !admitsUpper(upper, member, compareDecimal)
    ) {
      out.push(
        `members includes ${renderBoundValue(member)}, which the body's own bounds do not admit`,
      );
      continue;
    }
    if (
      t.multipleOf !== undefined &&
      decimalSignum(t.multipleOf) !== 0 &&
      !decimalIsMultiple(member, t.multipleOf)
    ) {
      out.push(
        `members includes ${renderBoundValue(member)}, not itself a multiple of the body's own multiple_of`,
      );
      continue;
    }
    const asExact = decimalOf(member);
    if (t.totalDigits !== undefined && BigInt(decimalPrecision(asExact.unscaled)) > t.totalDigits) {
      out.push(
        `members includes ${renderBoundValue(member)}, with more than the body's own total_digits`,
      );
    }
    if (
      t.fractionDigits !== undefined &&
      BigInt(decimalFractionDigits(asExact)) > t.fractionDigits
    ) {
      out.push(
        `members includes ${renderBoundValue(member)}, with more than the body's own fraction_digits`,
      );
    }
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
    compareBigint,
  );
  out.push(...decimalMemberCoherence(t));
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

// ── text-shaped families: text_type, bytes_type, regex_type, uri_type, email_type ──────────────

interface TextConstraints {
  readonly minLength?: bigint;
  readonly maxLength?: bigint;
  readonly length?: bigint;
  readonly pattern?: string;
  readonly members?: readonly string[];
}

function effectiveMinLength(t: TextConstraints): bigint | undefined {
  return t.minLength ?? t.length;
}

function effectiveMaxLength(t: TextConstraints): bigint | undefined {
  return t.maxLength ?? t.length;
}

/**
 * Set equality by NFC-compared value, for {@link checkSettableOnce}'s own `members` call — a
 * settable-once facet compares what the list admits, not its written order: §7.5 gives set
 * element order no meaning, `text_member_set` (§7.4) is `set_type`'s unordered, unique refinement
 * of `array`, and members compare as text, NFC (§7.4), matching identifier equality's own rule
 * (§7.7) and {@link textUniqueMembers}'s own comparison.
 */
function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const normalized = new Set(a.map(toNfc));
  return b.every((value) => normalized.has(toNfc(value)));
}

/**
 * `text_type`'s own narrowing rule — reused verbatim by `regex_type`/`uri_type`/`email_type`,
 * which compose `text_type`'s length facets flat (§5.7).
 *
 * `pattern` and `members` are each **settable once** (§5.7's facet-kind table, #22): a
 * refinement may set either where the source left it unset, restate the source's own verbatim, or
 * leave it alone, but never change it. `pattern`'s reason is that the narrowing question is
 * undecided in general (regular-language containment); `members`' reason is that the pair shares
 * one logical position — "what does this text admit" — and giving them two rules would make the
 * relation an artifact of which spelling an author reached for, even though `members` alone is
 * decidably narrowable (a member set could otherwise shrink like the numeric tiers' own).
 */
function textNarrows(source: TextConstraints, refined: TextConstraints): string[] {
  const out: string[] = [];
  checkAtLeast(out, 'min_length', effectiveMinLength(source), refined.minLength, compareBigint);
  checkAtLeast(out, 'length', effectiveMinLength(source), refined.length, compareBigint);
  checkAtMost(out, 'max_length', effectiveMaxLength(source), refined.maxLength, compareBigint);
  checkAtMost(out, 'length', effectiveMaxLength(source), refined.length, compareBigint);
  checkSettableOnce(out, 'pattern', source.pattern, refined.pattern);
  checkSettableOnce(
    out,
    'members',
    source.members,
    refined.members,
    sameMembers,
    'members and pattern share one position and pattern cannot be narrowed',
  );
  return out;
}

/**
 * `text_member_set`'s own non-emptiness and uniqueness, folded in here the same way
 * {@link integerMemberCoherence} folds `integer_member_set`'s: `text_member_set => !set_type {
 * element_type: text }` (§7.4) carries `min_items ~ 1` and a pinned `unique_items: true`, and
 * nothing below the schema's own field-vocabulary binding re-checks a `set_type` instance's shape
 * against its own facets, so this atom family states the obligation for itself, as every member
 * set family in this module does. **Members compare as text, NFC** (§7.4, matching identifier
 * equality's own rule, §7.7), so two members that are one NFC-normalised string are one member
 * stated twice, not two.
 */
function textUniqueMembers(members: readonly string[]): string[] {
  const out: string[] = [];
  if (members.length === 0) {
    return ["'members' is empty, so the body admits no value -- a member set states at least one"];
  }
  const seen = new Set<string>();
  for (const member of members) {
    const normalized = toNfc(member);
    if (seen.has(normalized)) {
      out.push(
        `members states '${member}' more than once -- members are compared as text, NFC, so two ` +
          'spellings of one string are one member',
      );
    }
    seen.add(normalized);
  }
  return out;
}

/**
 * §7.4's uniform members rule, over the text tier: every member of `members` MUST satisfy the
 * body's other facets, `pattern` included — one rule, checked once here and reused by
 * `regex_type`/`uri_type`/`email_type` alike. Lengths are counted in Unicode code points, matching
 * the kernel's own `text_type.members` doc ("Lengths count code points") — `Array.from` iterates a
 * string by code point, not by UTF-16 code unit. `pattern` arrives already parsed (`undefined`
 * when unset, or when it failed to parse and {@link textCoherence} has already reported that) so
 * this function never re-parses it and never reports a pattern-syntax problem twice.
 *
 * **`uri_type`/`email_type`'s own family-specific facets (`scheme`, and email's own address
 * grammar) are not asked of a member here** — `text_type`'s length/pattern facets are the only
 * ones this shared function owns. Each family's own obligation runs alongside this one instead
 * ({@link regexMemberSyntaxCoherence} for `regex_type`, {@link uriMemberCoherence}/
 * {@link emailMemberCoherence} for `uri_type`/`email_type`), every one of them a member of
 * `checkAtomCoherence`'s own per-family list rather than folded into this shared function, since
 * this one function's whole point is to be the part every text-shaped family owns identically.
 */
function textMemberCoherence(
  t: TextConstraints,
  pattern: ReturnType<typeof parseRegex> | undefined,
): string[] {
  const out: string[] = [];
  if (t.members === undefined) return out;
  out.push(...textUniqueMembers(t.members));
  const fixedLength = t.length;
  const minLength = effectiveMinLength(t);
  const maxLength = effectiveMaxLength(t);
  for (const member of t.members) {
    const codePoints = BigInt(Array.from(member).length);
    if (fixedLength !== undefined && codePoints !== fixedLength) {
      out.push(
        `members includes '${member}', ${codePoints.toString()} characters, and length is ${fixedLength.toString()}`,
      );
      continue;
    }
    if (minLength !== undefined && codePoints < minLength) {
      out.push(
        `members includes '${member}', ${codePoints.toString()} characters, under min_length ${minLength.toString()}`,
      );
      continue;
    }
    if (maxLength !== undefined && codePoints > maxLength) {
      out.push(
        `members includes '${member}', ${codePoints.toString()} characters, over max_length ${maxLength.toString()}`,
      );
      continue;
    }
    if (pattern !== undefined && !pattern.matches(member)) {
      out.push(`members includes '${member}', which does not match pattern ${t.pattern ?? ''}`);
    }
  }
  return out;
}

/**
 * §5.7's length-family coherence, shared by `text_type`, `regex_type`, `uri_type` and
 * `email_type` alike (§9): the floor may not exceed the ceiling, no count may be negative, and
 * `length` — pinning both ends at once — must itself fall inside whatever range the other two
 * leave. `pattern` is parsed here, once, against RFC 9485's I-Regexp grammar (`regex/`): a
 * pattern that fails to parse is itself a coherence violation, naming why, rather than a silent
 * pass that leaves {@link textMemberCoherence}'s own member-vs-pattern rule unable to run.
 */
function textCoherence(t: TextConstraints): string[] {
  const out: string[] = [];
  checkNonNegative(out, 'min_length', t.minLength);
  checkNonNegative(out, 'max_length', t.maxLength);
  checkNonNegative(out, 'length', t.length);
  checkOrdered(out, 'min_length', t.minLength, 'max_length', t.maxLength, compareBigint);
  checkOrdered(out, 'min_length', t.minLength, 'length', t.length, compareBigint);
  checkOrdered(out, 'length', t.length, 'max_length', t.maxLength, compareBigint);
  let pattern: ReturnType<typeof parseRegex> | undefined;
  if (t.pattern !== undefined) {
    try {
      pattern = parseRegex(t.pattern);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      out.push(`pattern '${t.pattern}' is not a valid I-Regexp pattern (RFC 9485): ${why}`);
    }
  }
  out.push(...textMemberCoherence(t, pattern));
  return out;
}

/**
 * `regex_type`'s own family-specific member obligation, beyond {@link textCoherence}'s shared
 * length/pattern rule: a `regex_type` value's own parsing contract is "a valid I-Regexp pattern"
 * (§5.7, RFC 9485), and §7.4's "the family's own parsing contract still applies" to a member set
 * reaches that too — a member that does not itself parse as I-Regexp is not a value `regex_type`
 * could ever read, member set or not.
 */
function regexMemberSyntaxCoherence(members: readonly string[] | undefined): string[] {
  if (members === undefined) return [];
  const out: string[] = [];
  for (const member of members) {
    try {
      parseRegex(member);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      out.push(
        `members includes '${member}', which is not a valid I-Regexp pattern (RFC 9485): ${why}`,
      );
    }
  }
  return out;
}

/**
 * §7.4's "every member satisfies the body's other facets", for the two families
 * {@link textMemberCoherence} deliberately leaves alone: a `uri_type`/`email_type` member is
 * checked against the family's OWN obligation -- `scheme` and RFC 3986's grammar for a URI,
 * RFC 5322's dot-atom grammar for an email address -- by running it through the family's own
 * compiled parser ({@link createUriParser}/{@link createEmailParser}), the single source of
 * truth `compiler/atomBuilder.ts` reads at data-read time too, rather than a second, drifting
 * copy of either grammar here. The parser's own length/pattern checks fire identically for a
 * member that also violates one of those (already reported by {@link textMemberCoherence}) --
 * accepted as one violation surfacing under two messages, rather than teaching this function to
 * suppress a family check because a shared one already ran.
 */
function uriMemberCoherence(atom: UriType): string[] {
  if (atom.members === undefined) return [];
  const parser = createUriParser('uri', atom);
  const out: string[] = [];
  for (const member of atom.members) {
    try {
      parser.read(memberToken(member));
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      out.push(
        `members includes '${member}', which does not satisfy uri_type's own facets: ${why}`,
      );
    }
  }
  return out;
}

/** {@link uriMemberCoherence}'s own twin for `email_type`. */
function emailMemberCoherence(atom: EmailType): string[] {
  if (atom.members === undefined) return [];
  const parser = createEmailParser('email', atom);
  const out: string[] = [];
  for (const member of atom.members) {
    try {
      parser.read(memberToken(member));
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      out.push(
        `members includes '${member}', which does not satisfy email_type's own facets: ${why}`,
      );
    }
  }
  return out;
}

/** A member string as the `AtomToken` a family's own parser reads -- `form` is never consulted by `createUriParser`/`createEmailParser`, so any well-formed choice is exact. */
function memberToken(text: string): { readonly text: string; readonly form: 'single-line' } {
  return { text, form: 'single-line' };
}

/** `bytes_type.encoding` carries no narrowing relation at all (§5.5, §5.7): a refinement may neither set nor change it, so the only legal comparison is equality -- an alphabet is a spelling, and another one is a fresh instance, never a tightening of this one. */
function bytesNarrows(source: BytesType, refined: BytesType): string[] {
  const out: string[] = [];
  if (source.encoding !== refined.encoding) {
    out.push(
      `encoding ${refined.encoding} carries no narrowing relation to the source's own ${source.encoding} (§5.5) -- another alphabet is a fresh instance, never a refinement`,
    );
  }
  checkAtLeast(out, 'min_length', source.minLength, refined.minLength, compareBigint);
  checkAtMost(out, 'max_length', source.maxLength, refined.maxLength, compareBigint);
  return out;
}

function bytesCoherence(t: BytesType): string[] {
  const out: string[] = [];
  checkNonNegative(out, 'min_length', t.minLength);
  checkNonNegative(out, 'max_length', t.maxLength);
  checkOrdered(out, 'min_length', t.minLength, 'max_length', t.maxLength, compareBigint);
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
  // `precision` is an upper bound on the value's own fractional-second grid (§5.5: "a
  // constraint on the value, not on a spelling"), so it refines the way every other upper bound
  // does: a refinement may lower it (a coarser grid), never raise it.
  checkAtMost(out, 'precision', source.precision, refined.precision, compareBigint);
  return out;
}

function timeCoherence(t: TimeType): string[] {
  const out: string[] = [];
  checkOrdered(out, 'min', t.min, 'max', t.max, compareOffsetTime);
  checkWithin(out, 'precision', t.precision, 0n, 9n);
  return out;
}

function dateTimeNarrows(source: DateTimeType, refined: DateTimeType): string[] {
  const out: string[] = [];
  checkAtLeast(out, 'min', source.min, refined.min, compareOffsetDateTime);
  checkAtMost(out, 'max', source.max, refined.max, compareOffsetDateTime);
  // As for `time`: an upper bound on the value's own grid refines downward only (§5.5).
  checkAtMost(out, 'precision', source.precision, refined.precision, compareBigint);
  return out;
}

function dateTimeCoherence(t: DateTimeType): string[] {
  const out: string[] = [];
  checkOrdered(out, 'min', t.min, 'max', t.max, compareOffsetDateTime);
  checkWithin(out, 'precision', t.precision, 0n, 9n);
  return out;
}

// ── duration_type / period_type ─────────────────────────────────────────────────────────────

/**
 * `duration`'s bounds, step and `precision` are all bigint (nanoseconds, §5.5), so this reuses
 * {@link compareBigint} and {@link integerSignum} directly rather than a family-specific
 * comparator -- the same value space {@link IntegerType}'s own facets share, only the unit
 * differs.
 */
function durationNarrows(source: DurationType, refined: DurationType): string[] {
  const out: string[] = [];
  checkLower(
    out,
    bound(source.min, source.exclusiveMin, 'min', 'exclusive_min'),
    bound(refined.min, refined.exclusiveMin, 'min', 'exclusive_min'),
    compareBigint,
  );
  checkUpper(
    out,
    bound(source.max, source.exclusiveMax, 'max', 'exclusive_max'),
    bound(refined.max, refined.exclusiveMax, 'max', 'exclusive_max'),
    compareBigint,
  );
  checkAtMost(out, 'precision', source.precision, refined.precision, compareBigint);
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

function durationCoherence(t: DurationType): string[] {
  const out: string[] = [];
  checkRange(
    out,
    bound(t.min, t.exclusiveMin, 'min', 'exclusive_min'),
    bound(t.max, t.exclusiveMax, 'max', 'exclusive_max'),
    compareBigint,
  );
  checkPositiveStep(out, 'multiple_of', t.multipleOf, integerSignum);
  checkWithin(out, 'precision', t.precision, 0n, 9n);
  return out;
}

/** `period`'s bounds and step are bigint months (§5.5); no `precision` facet -- a month count has no fractional part. */
function periodNarrows(source: PeriodType, refined: PeriodType): string[] {
  const out: string[] = [];
  checkLower(
    out,
    bound(source.min, source.exclusiveMin, 'min', 'exclusive_min'),
    bound(refined.min, refined.exclusiveMin, 'min', 'exclusive_min'),
    compareBigint,
  );
  checkUpper(
    out,
    bound(source.max, source.exclusiveMax, 'max', 'exclusive_max'),
    bound(refined.max, refined.exclusiveMax, 'max', 'exclusive_max'),
    compareBigint,
  );
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

function periodCoherence(t: PeriodType): string[] {
  const out: string[] = [];
  checkRange(
    out,
    bound(t.min, t.exclusiveMin, 'min', 'exclusive_min'),
    bound(t.max, t.exclusiveMax, 'max', 'exclusive_max'),
    compareBigint,
  );
  checkPositiveStep(out, 'multiple_of', t.multipleOf, integerSignum);
  return out;
}

// ── complex_type ─────────────────────────────────────────────────────────────────────────────

/**
 * `complex_type.component`'s own narrowing relation (§5.7, §9): two chains, ranked separately --
 * the exact tiers (`INTEGER ⊂ NUMBER ⊂ RATIONAL`) and the approximate ones (`FLOAT32 ⊂
 * FLOAT64`), incomparable across chains since binary64 carries `±inf`/`NaN` no exact decimal
 * represents. A refinement may move to a lower rank in the *same* chain only; the identical
 * value is always a (vacuous) narrowing regardless of chain.
 */
const EXACT_COMPONENT_RANK: Readonly<Partial<Record<ComplexComponent, number>>> = {
  INTEGER: 0,
  NUMBER: 1,
  RATIONAL: 2,
};
const APPROXIMATE_COMPONENT_RANK: Readonly<Partial<Record<ComplexComponent, number>>> = {
  FLOAT32: 0,
  FLOAT64: 1,
};

function complexNarrows(source: ComplexType, refined: ComplexType): string[] {
  if (source.component === refined.component) return [];
  const sourceRank =
    EXACT_COMPONENT_RANK[source.component] ?? APPROXIMATE_COMPONENT_RANK[source.component];
  const refinedRank =
    EXACT_COMPONENT_RANK[refined.component] ?? APPROXIMATE_COMPONENT_RANK[refined.component];
  const sameChain =
    source.component in EXACT_COMPONENT_RANK === refined.component in EXACT_COMPONENT_RANK;
  if (
    !sameChain ||
    sourceRank === undefined ||
    refinedRank === undefined ||
    refinedRank > sourceRank
  ) {
    return [
      `component ${refined.component} does not narrow the source's own ${source.component} (§5.7)`,
    ];
  }
  return [];
}

// ── ipv4_type / ipv6_type / cidr4_type / cidr6_type ─────────────────────────────────────────────

/**
 * §5.5's schema-load network obligation, common to all four families: `within` and `excluding`
 * MUST between them admit at least one value, decided exactly rather than pairwise
 * (`cidrParsing.ts`'s own `admitsSomeValue` walks a prefix tree rather than comparing each
 * pair in isolation, for the reason its own doc states). A `within`/`excluding` entry that isn't
 * itself a valid network in the family's own CIDR notation is reported and stops the question
 * there — admission can't be judged over an entry that couldn't be parsed as a network at all.
 *
 * `lowPrefix`/`highPrefix` bound the candidate's own prefix length: an address family calls this
 * with both equal to `addressBits` (an address is a single-point block, §5.5's ADDRESS rule), a
 * network family with its own `min_prefix`/`max_prefix` (defaulted to `0`/`addressBits`), since
 * "for a network family the prefix bounds participate" in the same question.
 */
function networkCoherence(
  out: string[],
  within: readonly string[],
  excluding: readonly string[],
  parseAddress: (text: string) => Uint8Array | undefined,
  addressBits: number,
  lowPrefix: number,
  highPrefix: number,
): void {
  const before = out.length;
  const withinBlocks = [];
  for (const text of within) {
    const block = parseNetworkBlock(text, parseAddress);
    if (block === undefined) {
      out.push(`'within' entry '${text}' is not a valid network in CIDR notation (§5.5)`);
    } else {
      withinBlocks.push(block);
    }
  }
  const excludingBlocks = [];
  for (const text of excluding) {
    const block = parseNetworkBlock(text, parseAddress);
    if (block === undefined) {
      out.push(`'excluding' entry '${text}' is not a valid network in CIDR notation (§5.5)`);
    } else {
      excludingBlocks.push(block);
    }
  }
  if (out.length > before) return;
  // §5.5 asks the diagnostic to name which of the two causes it found, "since the two want
  // different edits": widening `excluding` is one repair and loosening the prefix bounds is
  // another, and a message offering both alternatives tells an author neither.
  const cause = whyNoValue(withinBlocks, excludingBlocks, lowPrefix, highPrefix, addressBits);
  if (cause === 'excluded') {
    out.push(
      "'within' and 'excluding' admit no value between them (§5.5): 'excluding' covers every " +
        "'within' network entirely",
    );
  } else if (cause === 'prefix-bounds') {
    out.push(
      "'within' and 'excluding' admit no value between them (§5.5): what 'excluding' leaves " +
        `uncovered is narrower than the prefix bounds [${String(lowPrefix)}, ${String(highPrefix)}] allow`,
    );
  }
}

function ipv4Coherence(t: Ipv4Type): string[] {
  const out: string[] = [];
  networkCoherence(out, t.within, t.excluding, parseIpv4Octets, 32, 32, 32);
  return out;
}

function ipv6Coherence(t: Ipv6Type): string[] {
  const out: string[] = [];
  networkCoherence(out, t.within, t.excluding, parseIpv6Bytes, 128, 128, 128);
  return out;
}

/**
 * `within`/`excluding`'s own narrowing relation (§5.5, §5.7), shared by all four network
 * families: `within` admits addresses, so a refinement narrows it by *shrinking* ({@link
 * checkSubset}); `excluding` removes them, so a refinement narrows it by *growing* ({@link
 * checkSuperset}) -- the mirror-image pair `checkSuperset`'s own doc states. `ipv4_type`/
 * `ipv6_type` (the address families) and `cidr4_type`/`cidr6_type` (the network families, which
 * add their own prefix-bound check on top, in {@link cidrNarrows}) apply exactly this one rule to
 * the pair: neither family gets a pass, and the two agree.
 */
function networkNarrows(
  out: string[],
  source: { readonly within: readonly string[]; readonly excluding: readonly string[] },
  refined: { readonly within: readonly string[]; readonly excluding: readonly string[] },
): void {
  checkSubset(out, 'within', source.within, refined.within);
  checkSuperset(out, 'excluding', source.excluding, refined.excluding);
}

function ipv4Narrows(source: Ipv4Type, refined: Ipv4Type): string[] {
  const out: string[] = [];
  networkNarrows(out, source, refined);
  return out;
}

function ipv6Narrows(source: Ipv6Type, refined: Ipv6Type): string[] {
  const out: string[] = [];
  networkNarrows(out, source, refined);
  return out;
}

function cidrNarrows(source: Cidr4Type | Cidr6Type, refined: Cidr4Type | Cidr6Type): string[] {
  const out: string[] = [];
  checkAtLeast(out, 'min_prefix', source.minPrefix, refined.minPrefix, compareBigint);
  checkAtMost(out, 'max_prefix', source.maxPrefix, refined.maxPrefix, compareBigint);
  networkNarrows(out, source, refined);
  return out;
}

function cidrCoherence(t: Cidr4Type | Cidr6Type, prefixBits: bigint): string[] {
  const out: string[] = [];
  checkWithin(out, 'min_prefix', t.minPrefix, 0n, prefixBits);
  checkWithin(out, 'max_prefix', t.maxPrefix, 0n, prefixBits);
  checkOrdered(out, 'min_prefix', t.minPrefix, 'max_prefix', t.maxPrefix, compareBigint);
  // The admits-a-value question needs a coherent, in-range prefix bound pair to mean anything --
  // asking it against a bound already reported above would only produce a second, redundant
  // complaint about the same mistake.
  if (out.length === 0) {
    const addressBits = Number(prefixBits);
    const parseAddress = addressBits === 32 ? parseIpv4Octets : parseIpv6Bytes;
    const lowPrefix = t.minPrefix === undefined ? 0 : Number(t.minPrefix);
    const highPrefix = t.maxPrefix === undefined ? addressBits : Number(t.maxPrefix);
    networkCoherence(out, t.within, t.excluding, parseAddress, addressBits, lowPrefix, highPrefix);
  }
  return out;
}

// ── enum ─────────────────────────────────────────────────────────────────────────────────────

/**
 * An enum states at least one member, each stated once (§9). `enum.members` is typed `enum_set`
 * (`!set_type { element_type: text }`), whose `min_items` is `1` and whose `unique_items` is
 * pinned `true`, so `!enum []` and `!enum [OPEN OPEN]` both describe a body contradicting its own
 * declared shape and are refused at schema load rather than left to fail against every document —
 * {@link textUniqueMembers} states the same obligation for `text_member_set` and is reused here
 * rather than restated, since the two sets share one contract.
 *
 * **Under `IDENTIFIER` (the default), every member MUST match [TSON-DATA] §7.7's identifier
 * grammar** (§7.4, #21) — `enum_set`'s element type is `text`, not `identifier`, so nothing below
 * this check makes a member a name; a member that is not one is the body contradicting its own
 * declaration, in the family of coherence errors §7.2 makes a schema-load concern rather than data
 * validation. Under `TEXT` a member is any text and this rule does not apply.
 */
function enumCoherence(t: EnumBody): string[] {
  const out = [...textUniqueMembers(t.members)];
  if (t.profile !== 'IDENTIFIER') return out;
  for (const member of t.members) {
    if (!isIdentifierText(member)) {
      out.push(
        `member '${member}' is not a well-formed identifier ([TSON-DATA] §7.7) -- an enum whose ` +
          "members are not names declares 'profile: TEXT'",
      );
    }
  }
  return out;
}

/**
 * An enum's value set is written out in full, so narrowing is plain subset containment (`members`
 * may drop members but never introduce one the source does not admit). `profile` is §5.7's
 * settable-once facet-kind table's own third example, over its one-step chain `IDENTIFIER` inside
 * `TEXT`: `IDENTIFIER` is the narrower position, so restating either profile verbatim tightens
 * vacuously and narrowing from `TEXT` to `IDENTIFIER` sets what the source left at its wider
 * default, while the reverse would grant back latitude a refinement may only withdraw -- the same
 * pair of outcomes {@link checkSettableOnce}'s generic equality check gives a facet with a true
 * "unset" state, reached here by comparing along the chain's one order instead, since `profile`
 * always carries a value and has no unset state of its own to leave.
 */
function enumNarrows(source: EnumBody, refined: EnumBody): string[] {
  const out: string[] = [];
  checkSubset(out, 'members', source.members, refined.members);
  if (source.profile === 'IDENTIFIER' && refined.profile === 'TEXT') {
    out.push(
      "profile TEXT widens the source's own IDENTIFIER -- a refinement may withdraw the latitude " +
        'of TEXT but never grant it',
    );
  }
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
    case 'bytes_type':
      return refined.kind === 'bytes_type'
        ? bytesNarrows(source, refined)
        : mismatch('bytes', refined);
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
    case 'duration_type':
      return refined.kind === 'duration_type'
        ? durationNarrows(source, refined)
        : mismatch('a duration', refined);
    case 'period_type':
      return refined.kind === 'period_type'
        ? periodNarrows(source, refined)
        : mismatch('a period', refined);
    case 'complex_type':
      return refined.kind === 'complex_type'
        ? complexNarrows(source, refined)
        : mismatch('a complex', refined);
    case 'ipv4_type':
      return refined.kind === 'ipv4_type'
        ? ipv4Narrows(source, refined)
        : mismatch('an ipv4', refined);
    case 'ipv6_type':
      return refined.kind === 'ipv6_type'
        ? ipv6Narrows(source, refined)
        : mismatch('an ipv6', refined);
    // No orderable facet and no selector at all: `unit` (opaque, no schema-shape signal), the
    // identifier-only `uuid_type`, and `mac_type` (spec-pinned, no facet of its own to compare).
    case 'unit':
    case 'uuid_type':
    case 'mac_type':
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
  'bytes_type',
  'date_type',
  'time_type',
  'datetime_type',
  'duration_type',
  'period_type',
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
    case 'bytes_type':
      return bytesCoherence(atom);
    case 'regex_type':
      return [...textCoherence(atom), ...regexMemberSyntaxCoherence(atom.members)];
    case 'uri_type':
      return [...textCoherence(atom), ...uriMemberCoherence(atom)];
    case 'email_type':
      return [...textCoherence(atom), ...emailMemberCoherence(atom)];
    case 'date_type':
      return dateCoherence(atom);
    case 'time_type':
      return timeCoherence(atom);
    case 'datetime_type':
      return dateTimeCoherence(atom);
    case 'cidr4_type':
      return cidrCoherence(atom, 32n);
    case 'cidr6_type':
      return cidrCoherence(atom, 128n);
    case 'ipv4_type':
      return ipv4Coherence(atom);
    case 'ipv6_type':
      return ipv6Coherence(atom);
    case 'enum':
      return enumCoherence(atom);
    case 'duration_type':
      return durationCoherence(atom);
    case 'period_type':
      return periodCoherence(atom);
    // `component` is `complex_type`'s only field: a single selector has nothing else to
    // contradict.
    case 'unit':
    case 'uuid_type':
    case 'complex_type':
    case 'mac_type':
      return [];
  }
}
