/**
 * The two remaining base-kind unions (`product`, `sum`, §4.1), the `unit` atom constructor,
 * the two product-shape enums implied by (but never carried on) a product body, and the two
 * exact host-value shapes this package's constraint fields are typed with: {@link Rational}
 * and {@link IsoDuration}.
 */
import type { Extern, UnknownType } from './typedef.js';
import type { ArrayBody, ChoiceBody, MapBody, RecordBody, TupleBody } from './bodies.js';

/**
 * The meta-kernel's `product => top & { access_pattern: ...  size_type: ... }` base kind
 * (§4.1) — every PRODUCT-kind {@link Top} variant: exactly `record`/`array`/`set`/`map`/
 * `tuple`, the kernel's own structural-type family ("record, array, set, map, and tuple
 * compose with product, fixing `access_pattern` and `size_type`"). `set` refines `array` and
 * so resolves to an {@link ArrayBody} shape, not a member of its own.
 */
export type Product = RecordBody | ArrayBody | MapBody | TupleBody;

/**
 * The meta-kernel's `sum => top & {}` base kind (§4.1) — every SUM-kind {@link Top}
 * variant: {@link ChoiceBody} (`choice => ~sum & { variants: [type_ref] }`, §5.4),
 * {@link UnknownType} (`unknown_type => ~sum & {}`, "the universe of types"), and
 * {@link Extern} (`extern => ~sum & { schema: uri  types: [type_name]? }`).
 */
export type Sum = ChoiceBody | UnknownType | Extern;

/**
 * The meta-kernel's `product_size_type` enum (§4.1, §8.1) — fixed per product constructor
 * (`record`/`tuple` are `FIXED`; `array`/`map` are `VARIABLE`) and, like {@link
 * ProductAccessType}, implied by which body shape is in play rather than carried as a field
 * on {@link RecordBody}/{@link ArrayBody}/{@link MapBody}/{@link TupleBody} — informative
 * only, no type in this package holds a value of it.
 */
export type ProductSizeType = 'FIXED' | 'VARIABLE';

/**
 * The meta-kernel's `product_access_type` enum (§4.1, §8.1) — `record`'s own
 * `access_pattern` is fixed to `NAMED` and `array`/`map`/`tuple`'s to `INDEX`; neither ever
 * varies per instance, which is why no body shape in this package carries this value as a
 * field — informative only, implied by which shape is in play.
 */
export type ProductAccessType = 'INDEX' | 'NAMED';

/**
 * The meta-kernel's `unit` atom constructor's own vocabulary, resolved (§4.2, §8.1): an
 * empty marker, `!unit {}` — the body of `value`, `token`, and `void` (and core's own
 * `void` sibling), "the atom with no constraint vocabulary" (§4.2).
 */
export interface Unit {
  readonly kind: 'unit';
}

/**
 * The meta-kernel's `rational` host value — an exact fraction, `numerator`/`denominator`,
 * `denominator` always strictly positive (§7.6's grammar never permits a negative or zero
 * denominator; any sign belongs to the numerator). Lives here rather than in a richer
 * host-value module because {@link RationalType}'s own `min`/`max`/`multipleOf` constraint
 * fields are typed as this, and this package depends on nothing outside itself and `core/`.
 *
 * **Not normalised, but compared by value.** meta.tn's own doc for `rational_type` is
 * explicit: "the token is preserved as written and 2/4 round-trips as 2/4... equality and
 * constraints operate on the value (2/4 equals 1/2)." This type states the fields only —
 * `numerator`/`denominator` exactly as written — and leaves cross-multiplication equality
 * and ordering as a contract for whoever compares two of these, the same way {@link
 * TypeRef} leaves its own equality exclusion as a stated contract rather than code: this
 * package declares value shapes, not the operations over them.
 */
export interface Rational {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

/**
 * An exact decimal value, `unscaledValue x 10^-scale` — mirrors `java.math.BigDecimal`'s own
 * two defining fields exactly (`unscaledValue()`, `scale()`). Used wherever this package's
 * constraint fields are typed with the kernel's exact-decimal tier ({@link
 * DecimalType}/{@link FloatType}'s bounds) — kept as this plain structural pair, rather than
 * a richer arbitrary-precision decimal class, for the same reason {@link Rational} is a
 * plain pair and not an arithmetic library: this package depends on nothing outside itself
 * and `core/`, and a richer decimal type belongs to a host-value module downstream of this
 * one.
 */
export interface Decimal {
  readonly unscaledValue: bigint;
  readonly scale: number;
}

/**
 * The meta-kernel's `duration` host value — ISO 8601's `PnYnMnDTnHnMnS`, split into its
 * calendar part (`Y`/`M`/`D`, no fixed length) and its clock part (`H`/`M`/`S`, an exact
 * length), mirroring the two `java.time` types the reference implementation pairs for the
 * same reason no single type covers the grammar: `Period` (calendar) rejects any `T`-time
 * part at all, and `Duration` (clock) rejects any `Y`/`M` outright.
 *
 * Lives here, not in a richer host-value module, because {@link DurationType}'s doc records
 * a deliberate divergence: `min`/`max` on that type are kept as raw ISO 8601 text rather
 * than this parsed shape, precisely to avoid the same host-value dependency this type would
 * otherwise pull in. `IsoDuration` is ported for structural completeness — a later
 * work package's atom parser is the first real consumer.
 *
 * Not modelled as `Comparable`: a calendar-based duration (`P1M`, one calendar month) has no
 * fixed length to compare against a clock-based one (`P1M` may be 28-31 days depending on
 * when it is applied) — ordering is a partial order this shape does not carry.
 */
export interface IsoDuration {
  readonly calendarPart: IsoCalendarPart;
  readonly clockPart: IsoClockPart;
}

/** The calendar-based component of an {@link IsoDuration}, mirroring `java.time.Period`'s fields. */
export interface IsoCalendarPart {
  readonly years: number;
  readonly months: number;
  readonly days: number;
}

/** The clock-based component of an {@link IsoDuration}, mirroring `java.time.Duration`'s fields. */
export interface IsoClockPart {
  readonly seconds: bigint;
  readonly nanoseconds: number;
}
