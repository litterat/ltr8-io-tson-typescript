/**
 * The CIDR mechanics `cidr4.ts` and `cidr6.ts` share -- the port of `atom/CidrParsing.java`:
 * prefix-length grammar, the family-range and host-bits rules, and the `minPrefix`/`maxPrefix`
 * facets. Neither family owns them -- unlike `ipv4.ts`'s `parseIpv4Octets`, which `ipv6.ts`
 * genuinely reaches into because RFC 4291 §2.2 embeds the IPv4 grammar -- so they sit here
 * rather than on one of the two parsers with the other reaching across for them.
 *
 * **The split between a parse failure and a validation failure is §5.5's own, not a choice made
 * here**: "A token that does not match the named format is a resolver error; a CIDR prefix
 * length outside the address family's range is a validation error, as is an address whose host
 * bits are nonzero under the stated prefix length." So a malformed prefix is a
 * {@link TsonAtomParseError} (thrown by `cidr4.ts`/`cidr6.ts` themselves, not here) and an
 * out-of-range one is a {@link TsonAtomValidationError} (thrown by {@link validateNetwork}),
 * even though both concern the same handful of characters.
 *
 * **`within`/`excluding` share one algebra across both questions [TSON-SCHEMA] §5.5 asks of
 * them**, per value and at schema load:
 *
 * - *Per value* ({@link checkNetworkAdmitted}, consulted by
 *   `ipv4.ts`/`ipv6.ts`/`cidr4.ts`/`cidr6.ts`'s own `read`): does this one address or network
 *   satisfy the declared pair?
 * - *Per schema* ({@link admitsSomeValue}, consulted by `../../compiler/atomChecks.ts`): do the
 *   declared `within`/`excluding` lists -- and, for a network family, the prefix bounds -- between
 *   them admit *any* value at all? §5.5 requires this decided exactly, never pairwise: CIDR
 *   blocks nest or are disjoint and never partly overlap, so {@link admitsSomeValue} walks a
 *   prefix tree, pruning a subtree the moment some `excluding` block swallows it whole, rather
 *   than comparing each `within`/`excluding` pair in isolation -- the tiling case ([TSON-SCHEMA]
 *   §5.5's own `10.0.0.0/9` + `10.128.0.0/9` covering `10.0.0.0/8`) is exactly what a pairwise
 *   check misses and this one does not, since neither half is checked against the whole.
 *
 * Both questions turn on the same containment/overlap primitives ({@link isSubnetOf},
 * {@link overlaps}), so a `within`/`excluding` entry is parsed once, into a {@link NetworkBlock},
 * and every question after that is bit arithmetic over `bigint` rather than a second pass over
 * text.
 */

import { TsonAtomValidationError } from '../../core/errors.js';

const ASCII_ZERO = 0x30;
const ASCII_NINE = 0x39;

/**
 * The largest prefix length any family admits is 128, so a prefix is one to three digits. A
 * longer run is a shape failure rather than an out-of-range value -- the line has to fall
 * somewhere, and putting it at the widest spelling either family can use keeps every plausible
 * authoring slip (`/33` on IPv4, `/129` on IPv6) inside §5.5's validation category, where the
 * spec puts it.
 */
const MAX_PREFIX_DIGITS = 3;

/**
 * The decimal prefix length after the `/`, or `undefined` if `text` is not one. A leading zero is
 * rejected for the same reason `ipv4.ts`'s `dec-octet` rejects it: `/8` and `/08` would otherwise
 * be two spellings of one network, the confusable-input class strictness exists to shut down.
 */
export function tryParsePrefixLength(text: string): number | undefined {
  if (text.length === 0 || text.length > MAX_PREFIX_DIGITS) return undefined;
  if (text.length > 1 && text.charCodeAt(0) === ASCII_ZERO) return undefined;
  let value = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < ASCII_ZERO || code > ASCII_NINE) return undefined;
    value = value * 10 + (code - ASCII_ZERO);
  }
  return value;
}

/** Bit-at-a-time rather than byte-masked: at most 128 iterations, and no boundary case to get wrong. */
function hostBitsAreZero(address: Uint8Array, prefixLength: number): boolean {
  const totalBits = address.length * 8;
  for (let bit = prefixLength; bit < totalBits; bit++) {
    // `bit / 8` is always a valid index into `address` (bit < totalBits = address.length * 8), so
    // a genuinely out-of-range read never happens; `?? 0` only satisfies the type checker.
    const byte = address.at(Math.floor(bit / 8)) ?? 0;
    const mask = 0x80 >> (bit % 8);
    if ((byte & mask) !== 0) return false;
  }
  return true;
}

/**
 * §5.5's two validation rules plus `cidr4_type`/`cidr6_type`'s own prefix facets, in that order:
 * the family range first (a prefix the family cannot express makes the host-bits question
 * meaningless), then host bits, then the schema's own narrowing.
 */
export function validateNetwork(
  typeRef: string,
  text: string,
  address: Uint8Array,
  prefixLength: number,
  minPrefix: number | undefined,
  maxPrefix: number | undefined,
): void {
  const addressBits = address.length * 8;
  if (prefixLength > addressBits) {
    throw new TsonAtomValidationError(
      typeRef,
      `'${text}' has prefix length ${String(prefixLength)}, outside the family range 0-${String(addressBits)}`,
      `>= 0 and <= ${String(addressBits)}`,
    );
  }
  if (!hostBitsAreZero(address, prefixLength)) {
    throw new TsonAtomValidationError(
      typeRef,
      `'${text}' has nonzero host bits under prefix length ${String(prefixLength)} -- the value ` +
        `is a network, so every bit beyond the prefix must be zero`,
      'zero host bits beyond the prefix',
    );
  }
  if (minPrefix !== undefined && prefixLength < minPrefix) {
    throw new TsonAtomValidationError(
      typeRef,
      `'${text}' has prefix length ${String(prefixLength)}, less than the minimum ${String(minPrefix)}`,
      `>= ${String(minPrefix)}`,
    );
  }
  if (maxPrefix !== undefined && prefixLength > maxPrefix) {
    throw new TsonAtomValidationError(
      typeRef,
      `'${text}' has prefix length ${String(prefixLength)}, more than the maximum ${String(maxPrefix)}`,
      `<= ${String(maxPrefix)}`,
    );
  }
}

// ── `within`/`excluding` value space ([TSON-SCHEMA] §5.5) ─────────────────────────────────────

/**
 * A CIDR block reduced to bit arithmetic: `value` holds the address with every bit beyond
 * `prefixLength` already zeroed, so two blocks compare with a shift and a mask rather than a
 * byte-at-a-time walk. `bigint` rather than `Uint8Array` because every question this file answers
 * about a block -- is it a subnet of another, does it overlap another, split it in half -- is
 * arithmetic once the bytes are one number; 128 bits (the IPv6 ceiling) is small for `bigint`.
 */
export interface NetworkBlock {
  readonly value: bigint;
  readonly prefixLength: number;
}

function bytesToBigint(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}

/** `value`'s high `prefixLength` bits, the rest zeroed -- `addressBits` is 32 for `cidr4`/`ipv4`, 128 for `cidr6`/`ipv6`. */
function maskTo(value: bigint, addressBits: number, prefixLength: number): bigint {
  if (prefixLength >= addressBits) return value;
  const shift = BigInt(addressBits - prefixLength);
  return (value >> shift) << shift;
}

/**
 * A network address in CIDR text ("address/prefix"), parsed and validated to the same standard
 * §5.5 holds a `!cidr4`/`!cidr6` *value* to -- the family's own address grammar (`parseAddress`),
 * the prefix within the family's 0-`addressBits` range, and zero host bits beyond it. `undefined`
 * for anything else, which is what lets a `within`/`excluding` entry that isn't itself a valid
 * network surface as a schema-load coherence violation rather than a silent no-op constraint.
 */
export function parseNetworkBlock(
  text: string,
  parseAddress: (text: string) => Uint8Array | undefined,
): NetworkBlock | undefined {
  const slash = text.indexOf('/');
  if (slash < 0 || text.includes('/', slash + 1)) return undefined;
  const address = parseAddress(text.slice(0, slash));
  const prefixLength = tryParsePrefixLength(text.slice(slash + 1));
  if (address === undefined || prefixLength === undefined) return undefined;
  const addressBits = address.length * 8;
  if (prefixLength > addressBits || !hostBitsAreZero(address, prefixLength)) return undefined;
  return { value: bytesToBigint(address), prefixLength };
}

/** The single-address block a decoded `!ipv4`/`!ipv6` value denotes -- prefix length equal to the family's own address width. */
export function addressBlock(address: Uint8Array): NetworkBlock {
  return { value: bytesToBigint(address), prefixLength: address.length * 8 };
}

/** The block a decoded `!cidr4`/`!cidr6` value's own address and prefix length denote. */
export function networkBlock(address: Uint8Array, prefixLength: number): NetworkBlock {
  return { value: maskTo(bytesToBigint(address), address.length * 8, prefixLength), prefixLength };
}

/**
 * Parses every entry of a `within`/`excluding` list into a {@link NetworkBlock}, silently
 * dropping any that don't parse. Safe to drop rather than throw: an entry that isn't itself a
 * valid network is a schema-load coherence violation (`../../compiler/atomChecks.ts`'s own
 * network coherence check parses the same list and reports it there), so a schema an author can
 * actually load never reaches this function with one -- this is the read-time half of that one
 * invariant, not a second enforcement of it.
 */
export function parseNetworkList(
  texts: readonly string[],
  parseAddress: (text: string) => Uint8Array | undefined,
): NetworkBlock[] {
  const blocks: NetworkBlock[] = [];
  for (const text of texts) {
    const block = parseNetworkBlock(text, parseAddress);
    if (block !== undefined) blocks.push(block);
  }
  return blocks;
}

/** Whether `inner` is a subnet of (or equal to) `outer`: at least as specific a prefix, and agreeing with `outer` over `outer`'s own bits. */
export function isSubnetOf(inner: NetworkBlock, outer: NetworkBlock, addressBits: number): boolean {
  return (
    inner.prefixLength >= outer.prefixLength &&
    maskTo(inner.value, addressBits, outer.prefixLength) === outer.value
  );
}

/**
 * Whether `a` and `b` share any address at all. Because CIDR blocks nest or are disjoint and
 * never partly overlap, sharing an address means one contains the other -- there is no partial
 * case to test separately. [TSON-SCHEMA] §5.5 is explicit that this, not containment alone, is
 * the `excluding` test for a NETWORK value: "overlap, not containment, so a wider value cannot
 * smuggle an excluded block through."
 */
export function overlaps(a: NetworkBlock, b: NetworkBlock, addressBits: number): boolean {
  return isSubnetOf(a, b, addressBits) || isSubnetOf(b, a, addressBits);
}

/**
 * §5.5's per-value ADDRESS/NETWORK rule: `candidate` must be inside (address) or a subnet of
 * (network) at least one `within` block when the list is non-empty, and `excludeTest` (address:
 * {@link isSubnetOf}; network: {@link overlaps}) must hold for none of `excluding`. Throws the
 * shared {@link TsonAtomValidationError} shape either family's `read` reports under.
 */
export function checkNetworkAdmitted(
  typeRef: string,
  text: string,
  candidate: NetworkBlock,
  within: readonly NetworkBlock[],
  excluding: readonly NetworkBlock[],
  addressBits: number,
  excludeTest: (candidate: NetworkBlock, exclude: NetworkBlock, addressBits: number) => boolean,
): void {
  if (within.length > 0 && !within.some((block) => isSubnetOf(candidate, block, addressBits))) {
    throw new TsonAtomValidationError(
      typeRef,
      `'${text}' lies inside none of the declared 'within' networks (§5.5)`,
      "inside at least one declared 'within' network",
    );
  }
  if (excluding.some((block) => excludeTest(candidate, block, addressBits))) {
    throw new TsonAtomValidationError(
      typeRef,
      `'${text}' lies inside a declared 'excluding' network (§5.5)`,
      "outside every declared 'excluding' network",
    );
  }
}

function child(block: NetworkBlock, bit: 0 | 1, addressBits: number): NetworkBlock {
  const prefixLength = block.prefixLength + 1;
  if (bit === 0) return { value: block.value, prefixLength };
  return { value: block.value | (1n << BigInt(addressBits - prefixLength)), prefixLength };
}

/**
 * Does `block` -- restricted to the prefix range `[lowPrefix, highPrefix]` -- contain a value not
 * covered by `excluding`? The exact, non-pairwise walk [TSON-SCHEMA] §5.5 requires: `block` is
 * refused outright the moment some `excluding` entry contains it whole (every descendant would
 * inherit that containment), accepted the moment no `excluding` entry reaches inside it at all
 * (nothing left to avoid, so any prefix in range will do), and otherwise split in half and asked
 * again of each half with only the `excluding` entries that still fall inside it -- so a covering
 * pair such as `10.0.0.0/9` + `10.128.0.0/9` is caught by exhausting *both* halves of
 * `10.0.0.0/8`, never by comparing one `excluding` entry against `within` in isolation. Recursion
 * terminates within `addressBits` levels: each split strictly narrows both the block and the
 * `excluding` entries that can still matter to it.
 */
function admitsWithin(
  block: NetworkBlock,
  excluding: readonly NetworkBlock[],
  lowPrefix: number,
  highPrefix: number,
  addressBits: number,
): boolean {
  if (block.prefixLength > highPrefix) return false;
  // Blocks nest or are disjoint and never partly overlap, so an exclusion meeting this block either
  // contains it -- removing it whole -- or lies strictly inside it. Everything else is irrelevant
  // to this block and must be dropped before the emptiness question is asked, or a hole somewhere
  // else in the address space would force a split this block never needed.
  if (excluding.some((exclude) => isSubnetOf(block, exclude, addressBits))) return false;
  const inside = excluding.filter((exclude) => isSubnetOf(exclude, block, addressBits));
  if (inside.length === 0) {
    return Math.max(block.prefixLength, lowPrefix) <= highPrefix;
  }
  // A hole strictly inside means this block is not admissible as a value itself, but one of its
  // halves may be. A single-address block has no halves: `child` would shift by a negative width.
  if (block.prefixLength >= addressBits) return false;
  const left = child(block, 0, addressBits);
  const right = child(block, 1, addressBits);
  return (
    admitsWithin(left, inside, lowPrefix, highPrefix, addressBits) ||
    admitsWithin(right, inside, lowPrefix, highPrefix, addressBits)
  );
}

/**
 * §5.5's schema-load obligation: does the declared `within`/`excluding` pair -- with a candidate's
 * own prefix length bounded to `[lowPrefix, highPrefix]` -- admit at least one value? `within`
 * defaults to the whole address space when empty, mirroring the per-value rule's own "when the
 * field is present" qualifier (an address family calls this with `lowPrefix === highPrefix ===
 * addressBits`, since an address is a single-point block; a network family passes its own
 * `minPrefix`/`maxPrefix`, defaulted to `0`/`addressBits`).
 */
/**
 * Why the pair admits nothing, where it admits nothing -- §5.5 asks for this by name: "The
 * diagnostic SHOULD say which cause it found -- an exclusion covering everything permitted, or the
 * largest block the bounds leave -- since the two want different edits."
 *
 * The two are told apart exactly, by asking the same question twice: with the prefix bounds
 * dropped, an `excluding` list that still covers every `within` block is the exclusion cause, and
 * one that no longer does means the bounds were what closed the space.
 */
export function whyNoValue(
  within: readonly NetworkBlock[],
  excluding: readonly NetworkBlock[],
  lowPrefix: number,
  highPrefix: number,
  addressBits: number,
): 'excluded' | 'prefix-bounds' | undefined {
  if (admitsSomeValue(within, excluding, lowPrefix, highPrefix, addressBits)) return undefined;
  return admitsSomeValue(within, excluding, 0, addressBits, addressBits)
    ? 'prefix-bounds'
    : 'excluded';
}

export function admitsSomeValue(
  within: readonly NetworkBlock[],
  excluding: readonly NetworkBlock[],
  lowPrefix: number,
  highPrefix: number,
  addressBits: number,
): boolean {
  const roots: readonly NetworkBlock[] =
    within.length > 0 ? within : [{ value: 0n, prefixLength: 0 }];
  return roots.some((root) => admitsWithin(root, excluding, lowPrefix, highPrefix, addressBits));
}
