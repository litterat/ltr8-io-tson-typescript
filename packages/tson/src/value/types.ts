/**
 * The host value types the built-in atom vocabulary produces (§5, "Built-in Type Vocabulary") when a
 * token is read with no schema in scope. JavaScript has no `BigDecimal`, `LocalDate`, `InetAddress`,
 * `UUID`, or `Duration` — every one of the shapes below is authored here rather than borrowed from a
 * host library, the way the Java implementation borrows from the JDK.
 *
 * **Interfaces only.** Nothing here parses a token, performs arithmetic, or validates a range — that is
 * later work (`atom/`, Wave 1 of `ORCHESTRATION.md`). This file exists so every atom reader targets one
 * shared, frozen shape from the start, per §5.2's requirement that "implementations MUST preserve the
 * parsed value's information content" — the representations below are chosen specifically so that
 * requirement is satisfiable without a host type that would silently round or truncate.
 */

// ---------------------------------------------------------------------------------------------
// Exact numeric types
// ---------------------------------------------------------------------------------------------

/**
 * Arbitrary-precision exact decimal — the host value for `!number` (§5.6), the exact tier that
 * `decimal_type` builds on ([TSON-SCHEMA] §9).
 *
 * Modelled the way `java.math.BigDecimal` is: value = `unscaled * 10^exponent`. A plain JS `number`
 * cannot serve here for two independent reasons the spec calls out directly: an integer past 2^53
 * silently loses precision, and `!number` is exact while `number`'s binary floating point cannot
 * represent most decimal fractions exactly at all (`0.1` has no exact binary form). `unscaled` as a
 * `bigint` and `exponent` as a plain `number` (a decimal's exponent is never astronomically large in
 * practice, and `bigint` there would only complicate arithmetic for no preservation benefit) together
 * give `!number` unbounded, exact round-tripping regardless of how many significant digits or how large
 * an exponent a document writes.
 */
export interface TsonDecimal {
  /** The significant digits, sign included, with no implied decimal point. */
  readonly unscaled: bigint;
  /** The base-10 exponent: `value = unscaled * 10^exponent`. */
  readonly exponent: number;
}

/**
 * An exact numerator/denominator pair — the host value for `!rational` (§5.6). The denominator is
 * nonzero by the grammar itself (§5.6: "denominator nonzero (by grammar)"), never by a check here.
 *
 * **Not canonical.** The reduced form is *not* required, and the reference conformance suite pins the
 * opposite: `rational-negative-and-unreduced.tn` writes `!rational "-2/4"`, and its sidecar's own
 * description states the vector exists precisely to check "that a conforming implementation compares
 * `-2/4` and `-1/2` as equal, not that it silently reduces the written form" — asserting the *value*
 * `-1/2` without asserting the stored representation was rewritten. So `numerator`/`denominator` here
 * preserve exactly what was parsed; a later work package's equality/comparison logic (not this file)
 * is what compares two rationals by reduced value rather than by stored fields.
 *
 * Verified against:
 * `.references/ltr8-io-tson-test-suite/tests/vocabulary/valid/rational-plain-expected.tn` and
 * `.../rational-negative-and-unreduced-expected.tn`.
 */
export interface Rational {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

/**
 * A complex number — the host value for `!complex` (§5.6): "components per type". Each component uses
 * {@link TsonDecimal} rather than `number`, since `!complex`'s grammar accepts the same `integer`/`float`
 * forms `!number` does and the same exactness requirement applies to each part independently — a purely
 * imaginary value (`-2.5j`) still has an exact, preserved real part (`0`).
 *
 * Verified against:
 * `.references/ltr8-io-tson-test-suite/tests/vocabulary/valid/complex-two-part-expected.tn` (`{ real:
 * "3", imaginary: "4" }`) and `.../complex-imaginary-only-expected.tn` (`{ real: "0", imaginary: "-2.5"
 * }`, the real part implicitly zero for the `[sign] magnitude imag-unit` grammar alternative, §7.6).
 */
export interface Complex {
  readonly real: TsonDecimal;
  readonly imaginary: TsonDecimal;
}

// ---------------------------------------------------------------------------------------------
// Temporal types
// ---------------------------------------------------------------------------------------------

/**
 * A calendar date with no time-of-day or offset component — the host value for `!date` (§5.4, RFC 3339
 * `full-date`). Mirrors `java.time.LocalDate`'s information content.
 *
 * Verified against
 * `.references/ltr8-io-tson-test-suite/tests/vocabulary/valid/date-plain-expected.tn` and
 * `.../date-leap-day-expected.tn`.
 */
export interface PlainDate {
  readonly year: number;
  /** 1–12. */
  readonly month: number;
  /** 1–31, calendar-valid for `year`/`month`. */
  readonly day: number;
}

/**
 * A fixed offset from UTC, in whole minutes. `0` represents both `Z` and `+00:00` — RFC 3339 treats the
 * two spellings as the same offset, and the reference conformance suite's own sidecar for
 * `datetime-lowercase-t-and-z` normalizes a lowercase `z` to canonical uppercase `Z` in its asserted
 * `value`, confirming that only the *numeric* offset is information content, never the source spelling.
 */
export interface UtcOffset {
  /** Range −1080..1080 (a full RFC 3339 `time-numoffset` is bounded to ±18:00). */
  readonly totalMinutes: number;
}

/**
 * A time-of-day with a mandatory UTC offset — the host value for `!time` (§5.4, RFC 3339 `full-time`).
 *
 * **Named `PlainTime` (matching this file's requested export), but unlike TC39 `Temporal.PlainTime` it
 * always carries an {@link offset}.** `full-time`'s `time-offset` production is not optional — every
 * `!time` token contains one (`Z` or a signed numeric offset) — and §5.2 requires the parsed value's
 * information content to be preserved, so dropping the offset to match `Temporal.PlainTime`'s zoneless
 * shape would silently lose part of the token. The nearest JDK equivalent, confirmed by
 * `CONFORMANCE.md`, is `java.time.OffsetTime`, not `LocalTime`.
 *
 * A leap second (`time-second` of `60`, which RFC 3339 permits) is the one documented gap this vocabulary
 * cannot represent — see `CONFORMANCE.md`, "One accepted, unfixable gap": `java.time` has no leap-second
 * concept, so the reference implementation rejects a leap-second token as a parse error rather than
 * accepting it into any host shape, and this interface follows the same limit (`second` is 0–59).
 *
 * Verified against
 * `.references/ltr8-io-tson-test-suite/tests/vocabulary/valid/time-utc-expected.tn` and
 * `.../time-lowercase-and-offset-expected.tn`.
 */
export interface PlainTime {
  /** 0–23. */
  readonly hour: number;
  /** 0–59. */
  readonly minute: number;
  /** 0–59 — a spec-legal leap second (60) is rejected at parse time; see this type's own TSDoc. */
  readonly second: number;
  /** 0–999,999,999, the sub-second fraction. */
  readonly nanosecond: number;
  readonly offset: UtcOffset;
}

/**
 * A calendar date combined with a time-of-day and offset — the host value for `!datetime` (§5.4, RFC
 * 3339 `date-time` = `full-date "T" full-time`). Mirrors `java.time.OffsetDateTime`'s information
 * content; composed from {@link PlainDate} and {@link PlainTime} rather than flattened, since every
 * field the combined form needs already exists on one or the other.
 *
 * Verified against
 * `.references/ltr8-io-tson-test-suite/tests/vocabulary/valid/datetime-utc-expected.tn` and
 * `.../datetime-lowercase-t-and-z-expected.tn`.
 */
export interface PlainDateTime {
  readonly date: PlainDate;
  readonly time: PlainTime;
}

/**
 * A duration — the host value for `!duration` (§5.4): elapsed time, a signed exact count of
 * nanoseconds. A month has no fixed length beside a second that has one, so `!duration` admits no
 * `Y` or month-`M` component at all — a calendar span is `!period` ({@link TsonPeriod}) instead —
 * which is what makes this value space totally ordered and a single `bigint` sufficient to hold
 * it exactly: the format's own fraction is confined to the seconds component and capped at nine
 * digits (§5.4), so every legal duration is already a whole number of nanoseconds, and the format
 * bounds the magnitude to at most 2^63−1 of them (about 292 years) — comfortably inside `bigint`'s
 * unbounded precision, so nothing here can silently round or overflow the way a fixed-width host
 * duration type would.
 *
 * `PT90M`, `PT1H30M` and `P0DT5400S` are one value (`5400` seconds, i.e. `5_400_000_000_000n`
 * nanoseconds) — the written spelling (weeks, days, or an `H`/`M`/`S` breakdown) carries no
 * information beyond the count itself, so nothing here preserves it.
 *
 * Verified against
 * `.references/ltr8-io-tson-test-suite/tests/class1/vocabulary/valid/duration-clock-only-expected.tn`
 * (`PT1H30M`, 5400 s) and `.../duration-widest-magnitude-expected.tn`
 * (`PT9223372036.854775807S`, exactly 2^63−1 ns).
 */
export interface TsonDuration {
  /** Signed nanoseconds elapsed; magnitude at most 2^63−1 (§5.4). */
  readonly nanoseconds: bigint;
}

/**
 * A period — the host value for `!period` (§5.4): a calendar span, a signed integer count of
 * months. `P1Y` is exactly twelve months by definition (not an approximation the way a month
 * measured in seconds would be), so `P1Y` and `P12M` are one value and there is no fixed-length
 * question here the way there is for `!duration`.
 *
 * `months` is a `bigint` rather than a bounded integer: unlike `!duration`, §5.4 states no
 * magnitude ceiling for a period, so this value space is left as unbounded as the grammar itself
 * (`1*DIGIT` admits arbitrarily many digits on the `Y`/`M` components).
 *
 * Verified against
 * `.references/ltr8-io-tson-test-suite/tests/class1/vocabulary/valid/period-years-and-months-expected.tn`
 * (`P1Y6M`, 18 months) and `.../period-negative-expected.tn` (`-P3M`, −3 months).
 */
export interface TsonPeriod {
  /** Signed months. */
  readonly months: bigint;
}

// ---------------------------------------------------------------------------------------------
// Network types
// ---------------------------------------------------------------------------------------------

/**
 * An IPv4 address — the host value for `!ipv4` (§5.5, RFC 3986 `IPv4address`).
 *
 * `octets` holds the four address bytes directly, mirroring how `CONFORMANCE.md` describes the
 * reference parser building its result: `Ipv4Parser` "extracts the four octets directly from the regex
 * match, and constructs the address from raw bytes via `InetAddress.getByAddress(byte[])` — a pure
 * bytes-to-object call, never handing the original text to any JDK parser." Storing bytes rather than a
 * `number`/string keeps this type's information content identical to that constructor's, with no
 * dependency on any host network API (JavaScript has none to lean on regardless — see `CONFORMANCE.md`'s
 * discussion of why `!ipv4`/`!ipv6` cannot delegate text parsing to a lenient host parser at all).
 */
export interface Ipv4Address {
  readonly kind: 'ipv4';
  /** Exactly 4 bytes, most significant octet first. */
  readonly octets: Uint8Array;
}

/**
 * An IPv6 address — the host value for `!ipv6` (§5.5, RFC 4291 §2.2 text representation).
 *
 * As with {@link Ipv4Address}, `octets` holds the raw address bytes rather than a re-derived string, per
 * `CONFORMANCE.md`'s account of `Ipv6Parser` building the result from bytes (via
 * `Inet6Address.getByAddress(String, byte[], int)` with no scope id) so that the same 16 bytes always
 * produce the same kind of address, regardless of whether they happen to fall in the IPv4-mapped range —
 * a JDK quirk (`InetAddress.getByAddress` silently returning `Inet4Address` for such bytes) that
 * `CONFORMANCE.md` documents as a second, unrelated reason the reference parser avoids the generic JDK
 * factory. IPv6 zone identifiers (`fe80::1%eth0`, RFC 4007) are explicitly out of scope for `!ipv6`
 * (§5.5) and have no field here.
 */
export interface Ipv6Address {
  readonly kind: 'ipv6';
  /** Exactly 16 bytes, most significant octet first. */
  readonly octets: Uint8Array;
}

/**
 * A CIDR network — the host value for `!cidr4`/`!cidr6` (§5.5, RFC 4632 and its IPv6 analogue).
 *
 * **A network value, not retained text**: `address` and `prefixLength` are the decoded pair
 * ([TSON-SCHEMA] §5.5's "network value"), host bits already zeroed, which is what lets
 * `cidr4.ts`/`cidr6.ts` judge `within`/`excluding`/`max_prefix` against the value itself rather
 * than re-parsing a string every time a facet needs an answer.
 *
 * `addressText` carries the address portion exactly as authored, ahead of `write`'s own
 * `${addressText}/${prefixLength}`. This is not redundant with `address`: IPv4's `dec-octet`
 * grammar admits exactly one spelling per octet, so `address` alone would round-trip it, but RFC
 * 4291 §2.2 admits several spellings of one IPv6 address (`::` compression, a hex group's leading
 * zeros), and only the text an author chose distinguishes "2001:db8::/32" from
 * "2001:0db8:0000:0000:0000:0000:0000:0000/32" on the way back out — both decode to the same
 * 16-byte network. `formatIpv4`/`formatIpv6` deliberately don't own `write` here for that reason.
 *
 * Verified against
 * `.references/ltr8-io-tson-test-suite/tests/class1/vocabulary/valid/cidr4-plain-expected.tn`
 * (`value: { text: "192.0.2.0/24" }`) and `.../cidr6-compressed-expected.tn` (`value: { text:
 * "2001:db8::/32" }`, compression intact).
 */
export interface Cidr {
  readonly kind: 'cidr4' | 'cidr6';
  /** The address portion exactly as authored, before the `/`. */
  readonly addressText: string;
  /** The decoded network address, host bits zeroed: 4 bytes for `cidr4`, 16 for `cidr6`. */
  readonly address: Uint8Array;
  /** The prefix length after `/`, already checked against the family's own 0–32/0–128 range. */
  readonly prefixLength: number;
}

/**
 * A UUID — the host value for `!uuid` (§5.5, RFC 9562).
 *
 * `bytes` holds the full 128 bits directly, so any of the RFC's versions/variants round-trips
 * losslessly without this type needing to interpret version or variant bits at all.
 */
export interface Uuid {
  /** Exactly 16 bytes — the UUID's 128 bits, big-endian per RFC 9562's field layout. */
  readonly bytes: Uint8Array;
}

/**
 * An EUI-48 MAC address — the host value for `!mac` (§5.5, RFC 9542), accepted in both colon- and
 * hyphen-separated hex-octet spellings.
 */
export interface MacAddress {
  /** Exactly 6 bytes, in transmission order. */
  readonly octets: Uint8Array;
}

// ---------------------------------------------------------------------------------------------
// Binary types
// ---------------------------------------------------------------------------------------------

/**
 * The host value for `!bytes` (§5.3), Part 1's one binary annotation and one binary value space:
 * the plain decoded octet sequence. Base64 (RFC 4648 §4) is the only spelling a schemaless
 * document can carry — an alphabet is a spelling of an octet sequence, not a kind of value, and
 * there is no schema in scope to carry a selector — so, unlike the numeric or temporal families,
 * `!bytes` has no sibling annotations to distinguish. A schema can name another RFC 4648 alphabet
 * via `bytes_type.encoding`, but that is a schema-layer refinement of the one `bytes` type, not a
 * different Part 1 tag.
 */
export type TsonBinary = Uint8Array;

// ---------------------------------------------------------------------------------------------
// Integer families
// ---------------------------------------------------------------------------------------------

/**
 * The fixed-width and sign-bounded integer families of §5.6, and the host type each maps to.
 *
 * **`int8`..`int32` and `uint8`..`uint32` map to a plain `number`.** Their full range (±2^31, 0..2^32−1)
 * sits well inside `number`'s exact integer range (±2^53), so no precision is at risk and the ordinary
 * arithmetic operators work directly.
 *
 * **`int64`..`int256`, `uint64`..`uint256`, and the four sign-bounded, unbounded-precision refinements
 * (`positive_integer`, `non_negative_integer`, `negative_integer`, `non_positive_integer`) map to
 * `bigint`.** This is the trap a port must not walk into: `int64`'s range alone already exceeds 2^53, so
 * a value like `9007199254740993n` would silently narrow to `9007199254740992` if read into a `number` —
 * no exception, no visible sign anything went wrong. `bigint` is exact at any width, which is the only
 * property that matters here, and the unbounded refinements have no fixed width to begin with, so
 * `bigint` is their only sound representation as well.
 *
 * These are documentation aliases, not branded/nominal types — nothing at this layer distinguishes
 * `Int8` from `Int16` beyond the name, since the range check that would separate them is validation
 * (§5.2), not shape.
 */
export type Int8 = number;
/** @see Int8 */
export type Int16 = number;
/** @see Int8 */
export type Int32 = number;
/** @see Int8 */
export type Uint8 = number;
/** @see Int8 */
export type Uint16 = number;
/** @see Int8 */
export type Uint32 = number;

/** @see Int8 */
export type Int64 = bigint;
/** @see Int8 */
export type Int128 = bigint;
/** @see Int8 */
export type Int256 = bigint;
/** @see Int8 */
export type Uint64 = bigint;
/** @see Int8 */
export type Uint128 = bigint;
/** @see Int8 */
export type Uint256 = bigint;

/**
 * `!positive_integer` / `!non_negative_integer` / `!negative_integer` / `!non_positive_integer` (§5.6):
 * a sign-bounded but otherwise unbounded-precision integer. See {@link Int8} for why this is `bigint`.
 */
export type UnboundedInteger = bigint;

// ---------------------------------------------------------------------------------------------
// Optional Temporal adapter (feature-detected, not implemented here)
// ---------------------------------------------------------------------------------------------

/**
 * The shape an optional `Temporal`-backed view would expose, converting between this file's own plain
 * interfaces and the TC39 `Temporal` global.
 *
 * **Declared, not implemented — and feature-detected, not assumed.** Per `PORT-PLAN.md`'s decision ("Own
 * zero-dep immutable value types plus a feature-detected `Temporal` adapter"), `Temporal` is absent on
 * Node 24 as of this writing (and not yet universal across target browsers), so every temporal atom
 * reader must work against {@link PlainDate}/{@link PlainTime}/{@link PlainDateTime}/{@link TsonDuration}/
 * {@link TsonPeriod} on their own; an adapter satisfying this interface is an optional convenience layered
 * on top, built by
 * a later work package only after checking `typeof Temporal !== 'undefined'` at runtime.
 *
 * The conversion methods are typed `unknown` on the `Temporal`-facing side deliberately: importing an
 * actual `Temporal.PlainDate` (etc.) type here would make an otherwise-absent global a compile-time
 * dependency of this module, which is exactly what feature detection at runtime is meant to avoid at
 * the type level too. A concrete implementation narrows `unknown` to the real `Temporal` types itself,
 * behind its own feature-detection guard.
 */
export interface TemporalAdapter {
  /** `PlainDate` to a host `Temporal.PlainDate`, when available. */
  toPlainDate(value: PlainDate): unknown;
  /** A host `Temporal.PlainDate` back to {@link PlainDate}. */
  fromPlainDate(value: unknown): PlainDate;
  /** `PlainTime` to a host `Temporal`-backed offset time value, when available. */
  toPlainTime(value: PlainTime): unknown;
  /** A host `Temporal`-backed offset time value back to {@link PlainTime}. */
  fromPlainTime(value: unknown): PlainTime;
  /** `PlainDateTime` to a host `Temporal`-backed offset date-time value, when available. */
  toPlainDateTime(value: PlainDateTime): unknown;
  /** A host `Temporal`-backed offset date-time value back to {@link PlainDateTime}. */
  fromPlainDateTime(value: unknown): PlainDateTime;
  /** `TsonDuration` to a host `Temporal.Duration`, when available. */
  toDuration(value: TsonDuration): unknown;
  /** A host `Temporal.Duration` back to {@link TsonDuration}. */
  fromDuration(value: unknown): TsonDuration;
  /** `TsonPeriod` to a host `Temporal.Duration` carrying only calendar fields, when available. */
  toPeriod(value: TsonPeriod): unknown;
  /** A host `Temporal.Duration`'s calendar fields back to {@link TsonPeriod}. */
  fromPeriod(value: unknown): TsonPeriod;
}
