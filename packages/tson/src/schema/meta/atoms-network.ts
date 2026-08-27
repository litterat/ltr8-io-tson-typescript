/**
 * The network atom families' resolved constraint vocabularies (§9): IPv4/IPv6 addresses,
 * their CIDR-network counterparts, and EUI-48 MAC addresses.
 */

/**
 * meta.tn's `ipv4_type` constructor (IPv4 address constraint vocabulary, RFC 3986's
 * `IPv4address` production): CIDR-text network allow/deny lists.
 *
 * `spec` is a bare string, not a richer URI type, matching every other
 * externally-cited-document field in this package. `within`/`excluding` are the kernel's
 * own `[value]?` — **absent and empty are the same list**; a resolver MUST normalise an
 * absent value to `[]`, the convention {@link TypeDefinition}'s own note states in full —
 * each entry is CIDR text, carried exactly as written and uninterpreted by this shape.
 *
 * Same shape as {@link Cidr4Type} minus `minPrefix`/`maxPrefix` — an address, not a network,
 * has no prefix length.
 *
 * Also an {@link Atom} variant: `ipv4 => !ipv4_type {}` is a constructor-application
 * instance (§5.5) whose resolved body is this shape with `spec` pinned and both lists empty.
 */
export interface Ipv4Type {
  readonly kind: 'ipv4_type';
  readonly spec: string;
  readonly within: readonly string[];
  readonly excluding: readonly string[];
}

/**
 * meta.tn's `ipv6_type` constructor (IPv6 address constraint vocabulary, RFC 4291) —
 * {@link Ipv4Type}'s exact IPv6 counterpart, same shape and same absent-equals-empty
 * convention on `within`/`excluding`, different RFC citation.
 *
 * Also an {@link Atom} variant: `ipv6 => !ipv6_type {}` is a constructor-application
 * instance (§5.5) whose resolved body is this shape with `spec` pinned and both lists empty.
 */
export interface Ipv6Type {
  readonly kind: 'ipv6_type';
  readonly spec: string;
  readonly within: readonly string[];
  readonly excluding: readonly string[];
}

/**
 * meta.tn's `cidr4_type` constructor (IPv4-network constraint vocabulary, RFC 4632):
 * prefix-length bounds (0-32, meta.tn's own `@doc` names this the family's range) plus
 * CIDR-text network lists.
 *
 * `spec` is a bare string, not a richer URI type, for the reason {@link Ipv4Type}'s own note
 * gives. `within`/`excluding` are **absent-equals-empty**, the same convention {@link
 * TypeDefinition} states in full; a resolver MUST normalise an absent value to `[]`.
 *
 * Also an {@link Atom} variant: `cidr4 => !cidr4_type {}` is a constructor-application
 * instance (§5.5) whose resolved body is this shape with `spec` pinned, both prefix bounds
 * absent, and both lists empty.
 */
export interface Cidr4Type {
  readonly kind: 'cidr4_type';
  readonly spec: string;
  readonly minPrefix?: number;
  readonly maxPrefix?: number;
  readonly within: readonly string[];
  readonly excluding: readonly string[];
}

/**
 * meta.tn's `cidr6_type` constructor (IPv6-network constraint vocabulary, RFC 4291) —
 * {@link Cidr4Type}'s exact IPv6 counterpart, same shape, different RFC citation and
 * prefix-length family range (0-128 instead of 0-32, not enforced by this value model
 * either way).
 *
 * Also an {@link Atom} variant: `cidr6 => !cidr6_type {}` is a constructor-application
 * instance (§5.5) whose resolved body is this shape with `spec` pinned, both prefix bounds
 * absent, and both lists empty.
 */
export interface Cidr6Type {
  readonly kind: 'cidr6_type';
  readonly spec: string;
  readonly minPrefix?: number;
  readonly maxPrefix?: number;
  readonly within: readonly string[];
  readonly excluding: readonly string[];
}

/**
 * meta.tn's `mac_type` constructor (EUI-48 MAC address, RFC 9542) — deliberately bare
 * beyond the RFC pin (I/G-/U/L-bit predicates and OUI vendor prefixes were considered and
 * rejected as niche by the reference implementation's own schema doc comment).
 *
 * `spec` is a bare string, not a richer URI type, for the reason {@link Ipv4Type}'s own note
 * gives.
 *
 * Also an {@link Atom} variant: `mac => !mac_type {}` is a constructor-application instance
 * (§5.5) whose resolved body is this shape with `spec` pinned.
 */
export interface MacType {
  readonly kind: 'mac_type';
  readonly spec: string;
}
