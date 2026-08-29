/**
 * The temporal atom families' resolved constraint vocabularies (§5.4, §9): `date`, `time`,
 * `datetime` (all RFC 3339), and `duration` (ISO 8601).
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
 * `precision` is `bigint` because the kernel's own field is typed `integer`.
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
 * The meta-kernel's `duration_type` constructor (§5.4's `duration` atom, ISO 8601's
 * `PnYnMnDTnHnMnS`).
 *
 * `min`/`max` are the raw ISO 8601 duration text, not the parsed {@link IsoDuration}
 * (`./algebra.js`) shape — deliberately: ordering `"P1M"` against `"P30D"` requires parsing,
 * and this family's narrowing/coherence questions are left to a later work package's atom
 * reader rather than answered by this value model. A plain string also needs no dependency
 * on a richer duration type.
 *
 * Also an {@link Atom} variant: `duration => !duration_type {}` is a
 * constructor-application instance (§5.5) whose resolved body is this shape with both
 * bounds absent.
 */
export interface DurationType {
  readonly kind: 'duration_type';
  readonly min?: string;
  readonly max?: string;
}
