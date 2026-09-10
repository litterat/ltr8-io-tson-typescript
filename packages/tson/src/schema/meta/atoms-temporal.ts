/**
 * The temporal atom families' resolved constraint vocabularies (§9): `date`, `time`,
 * `datetime` (all RFC 3339), `duration` (RFC 3339 Appendix A, seconds), and `period` (RFC 3339
 * Appendix A, months).
 */

/**
 * A calendar date with no time-of-day or offset, mirroring `java.time.LocalDate`'s own
 * fields (`getYear`/`getMonthValue`/`getDayOfMonth`) — used by {@link DateType}'s bounds.
 * Kept as this plain structural triple rather than a richer date class, for the same reason
 * {@link Rational}/{@link Decimal} (`./algebra.js`) are plain structural shapes: this
 * package depends on nothing outside itself and `core/`, and a richer, arithmetic-capable
 * date type belongs to a host-value module downstream of this one.
 */
export interface CalendarDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** A time-of-day with no date or offset, mirroring `java.time.LocalTime`'s own fields. */
export interface LocalTime {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly nanosecond: number;
}

/**
 * A time-of-day with a fixed UTC offset, mirroring `java.time.OffsetTime` — used by
 * {@link TimeType}'s bounds. Bounds compare on this shape's own ordering rule (own contract,
 * not enforced here): normalise to the instant on a shared day before comparing, so a bound
 * written in one offset is comparable with one written in another.
 */
export interface OffsetTime {
  readonly time: LocalTime;
  readonly offsetSeconds: number;
}

/**
 * A calendar date and time-of-day with a fixed UTC offset, mirroring
 * `java.time.OffsetDateTime` — used by {@link DateTimeType}'s bounds. Bounds compare by
 * instant first (own contract, not enforced here), so two bounds written in different
 * offsets remain comparable.
 */
export interface OffsetDateTime {
  readonly date: CalendarDate;
  readonly time: LocalTime;
  readonly offsetSeconds: number;
}

/**
 * The meta-kernel's `date_type` constructor (§5.4's `date` atom, RFC 3339 `full-date`).
 * Both bounds are inclusive — this family has no exclusive facet.
 *
 * Also an {@link Atom} variant: `date => !date_type {}` is a constructor-application
 * instance (§5.5) whose resolved body is this shape with both bounds absent.
 */
export interface DateType {
  readonly kind: 'date_type';
  readonly min?: CalendarDate;
  readonly max?: CalendarDate;
}

/**
 * The meta-kernel's `time_type` constructor (§5.4's `time` atom, RFC 3339 `full-time`).
 *
 * **No timezone facet.** RFC 3339 `full-time`, which this atom's `spec` pins, already makes
 * the offset mandatory — a facet requiring it would be vacuous and one relaxing it would
 * widen the atom against its own pin, so the constructor declares none (§5.5).
 *
 * **`precision` bounds the fractional-second digits, judged on the written token** — `N`
 * admits at most `N` digits (`12:00:00.100` has three, whatever instant it denotes), as a
 * validation constraint, never a truncation instruction: the atom is exact and a value is
 * preserved as written. `precision: 0` admits no fractional part. Stated as an upper bound,
 * the facet is an ordered bound under §5.7 and refines like every other one (§5.5).
 * `precision` is `bigint` because the kernel's own field is typed `non_negative_integer`.
 *
 * Also an {@link Atom} variant: `time => !time_type {}` is a constructor-application
 * instance (§5.5) whose resolved body is this shape with every field absent.
 */
export interface TimeType {
  readonly kind: 'time_type';
  readonly min?: OffsetTime;
  readonly max?: OffsetTime;
  readonly precision?: bigint;
}

/**
 * The meta-kernel's `datetime_type` constructor (§5.4's `datetime` atom, RFC 3339
 * `date-time`). Carries the same `precision` facet as {@link TimeType}, for the same reason,
 * and the same absence of a timezone facet.
 *
 * Also an {@link Atom} variant: `datetime => !datetime_type {}` is a
 * constructor-application instance (§5.5) whose resolved body is this shape with every
 * field absent.
 */
export interface DateTimeType {
  readonly kind: 'datetime_type';
  readonly min?: OffsetDateTime;
  readonly max?: OffsetDateTime;
  readonly precision?: bigint;
}

/**
 * The meta-kernel's `duration_type` constructor (§5.5's `duration` atom, RFC 3339 Appendix A,
 * restricted to no `Y`/month-`M` component). Elapsed time — a signed exact count of seconds,
 * bounded at both ends by a signed 64-bit count of nanoseconds (about 292 years); `!period`
 * (`PeriodType`) carries the calendar half this family no longer does, which is what makes
 * `duration` totally ordered and this family's bounds enforceable at all.
 *
 * **Every numeric field holds the *value*, not the token.** `min`/`exclusiveMin`,
 * `max`/`exclusiveMax` and `multipleOf` are the kernel's own `value` escape hatch —
 * `duration`'s own value space, in nanoseconds — read by the resolver once the atom is in
 * scope and stored here as the result (§5.2, §7.4): `PT90M`, `PT1H30M` and `P0DT5400S` are one
 * value and so one `bigint`, whatever the source token spelled. `min`/`exclusiveMin` and
 * `max`/`exclusiveMax` are mutually exclusive pairs, the same unenforced invariant
 * {@link IntegerType} (`./atoms-numeric.js`) carries.
 *
 * `precision` bounds the fractional-second digits exactly as {@link TimeType}'s does — a
 * whole number of 10⁻ᴺ seconds, `bigint` because the kernel types it `non_negative_integer`,
 * and it may not exceed nine, there being no tenth digit the value space carries.
 *
 * No `spec` field: this family composes with `atom_specification` and pins `spec` to RFC 3339
 * Appendix A, but — like {@link DateType}/{@link TimeType}/{@link DateTimeType} — a fixed spec
 * pin common to every instance of the constructor carries no per-instance information, so this
 * package does not model it (matching the reference implementation's own choice).
 *
 * Also an {@link Atom} variant: `duration => !duration_type {}` is a
 * constructor-application instance (§5.5) whose resolved body is this shape with every field
 * absent.
 */
export interface DurationType {
  readonly kind: 'duration_type';
  readonly min?: bigint;
  readonly exclusiveMin?: bigint;
  readonly max?: bigint;
  readonly exclusiveMax?: bigint;
  readonly precision?: bigint;
  readonly multipleOf?: bigint;
}

/**
 * The meta-kernel's `period_type` constructor (§5.5's `period` atom, RFC 3339 Appendix A,
 * restricted to a `Y` component, an `M` component, or both — no fraction, no `W`/`D` component,
 * no `T` part). Calendar span — a signed integer count of months, so `P1Y` and `P12M` are one
 * value. The calendar half of what one duration used to carry, and the reason `!duration`
 * (`DurationType`) can be totally ordered: a month has no fixed length, so months and seconds
 * are two value spaces rather than one partially ordered one.
 *
 * **Every numeric field holds the *value*, not the token** — the same `value`-escape-hatch
 * convention {@link DurationType}'s own doc states in full, `period`'s value space (signed
 * months) in place of `duration`'s (signed nanoseconds). No `precision` facet: a month count
 * has no fractional part to bound.
 *
 * No `spec` field, on {@link DurationType}'s own terms.
 *
 * Also an {@link Atom} variant: `period => !period_type {}` is a constructor-application
 * instance (§5.5) whose resolved body is this shape with every field absent.
 */
export interface PeriodType {
  readonly kind: 'period_type';
  readonly min?: bigint;
  readonly exclusiveMin?: bigint;
  readonly max?: bigint;
  readonly exclusiveMax?: bigint;
  readonly multipleOf?: bigint;
}
