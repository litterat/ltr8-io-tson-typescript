/**
 * The resolver's own output record, `type_definition` (Part 2 §4, §8.1), and the type-system
 * vocabulary it is built from: kinds, references, applications, and the structural root every
 * resolved body composes with.
 *
 * This module, like every other module in `schema/meta`, depends on nothing but itself,
 * sibling modules in this same directory, and `core/` — never a compiler type. Two shapes
 * here are local stand-ins for that reason: {@link Token} mirrors `ast.TokenValue`, and
 * {@link SourcePosition} (declared in `./position.js`) is structurally satisfied by
 * `core/position.ts`'s `Position` with no conversion. {@link Annotation}/{@link Annotations}
 * are a third, minimal stand-in: the real wire-annotation carrier (`src/annotations`) also
 * exposes lookup methods, but only the data shape those methods read is needed here.
 */
import type { SourcePosition } from './position.js';
import type { EnumBody, TemplateBody } from './bodies.js';
import type { Product, Sum, Unit } from './algebra.js';
import type {
  IntegerType,
  FloatType,
  DecimalType,
  RationalType,
  ComplexType,
} from './atoms-numeric.js';
import type {
  TextType,
  UriType,
  RegexType,
  EmailType,
  UuidType,
  BinaryType,
} from './atoms-text.js';
import type { DateType, TimeType, DateTimeType, DurationType } from './atoms-temporal.js';
import type { Cidr4Type, Cidr6Type, Ipv4Type, Ipv6Type, MacType } from './atoms-network.js';

/**
 * One TSON wire-format annotation (`@name` or `@name:value`) attached to a resolved value
 * (§6, §8.1). `value` is `unknown` because its TypeScript shape depends on how the carrying
 * document was read — bound against a governing type when one resolves, kept as a raw
 * structural fragment otherwise — and this package, which never binds anything, cannot name
 * either.
 *
 * A local, data-only stand-in for `src/annotations`' own `Annotation`: the real carrier
 * additionally exposes lookup methods (`get`, `value`, `has`, ...), but `schema/meta`
 * depends on nothing but itself and `core/`, so only the shape those methods read travels
 * here. An absent `value` is the valueless form `@name`, distinct from a `value` holding the
 * absent sentinel `_`.
 */
export interface Annotation {
  readonly name: string;
  readonly value?: unknown;
}

/**
 * Every annotation attached to one resolved value, in source order — §3.1 permits a name to
 * repeat, so this is a list rather than a map. Always an array, never absent, when a value
 * carries none: see {@link TypeDefinition}'s own note on the "absent and empty are the same"
 * convention this package follows for every list-shaped field.
 */
export type Annotations = readonly Annotation[];

/**
 * How a raw token's text was written (§7.1, §9.4): unquoted, or quoted on one or several
 * lines. Mirrors `ast.TokenValue`'s own `TokenForm` enumeration one-for-one.
 */
export type TokenForm = 'UNQUOTED' | 'SINGLE_LINE_QUOTED' | 'MULTI_LINE_QUOTED';

/**
 * A raw, unresolved scalar literal — a field's default/fixed value (§5.2), or a
 * type-argument's literal (§5.10: "a bare token... never annotated, never typed, never a
 * container").
 *
 * A local stand-in for `ast.TokenValue`, declared here rather than imported because
 * `schema/meta` depends on nothing but itself and `core/`. A caller on the compiler side
 * converts its own `TokenValue` into this shape field-by-field; there is deliberately no
 * shared supertype or conversion function here, since either would reintroduce the very
 * dependency this type exists to avoid.
 */
export interface Token {
  readonly text: string;
  readonly form: TokenForm;
}

/**
 * The meta-kernel's `type_kind` (§4.1, §8.1) — the REQUIRED, never-defaulted field every
 * resolved {@link TypeDefinition} carries exactly one of. `DATA` is the non-type kind: an
 * entry describing meta-schema vocabulary rather than a data value (§4.1).
 */
export type TypeKind = 'ATOM' | 'PRODUCT' | 'SUM' | 'REFERENCE' | 'DATA';

/**
 * A resolved reference to a named entry (§8.1). `name` is the only field the kernel's own
 * `type_ref` requires, so an argument-free reference is written as the bare token everywhere
 * the positional-form rule applies (§5.6), never as `!type_ref { name: ... }`.
 *
 * **`arguments` non-empty means "an application"**, and appears in output only inside
 * template bodies and in `source` provenance (§8.1) — a use-site application is always
 * flattened to a bare reference to its materialised entry before it reaches output (§8.2,
 * §8.3). **Absent and empty are the same list**: the kernel's `arguments: [type_argument]?`
 * is OPTIONAL with no default, so a resolver MUST normalise an unstated value to `[]` rather
 * than leaving it unset — the same convention {@link TypeDefinition}'s own note states for
 * its list-shaped fields.
 *
 * `annotations` carries the wire annotations written on the reference **itself**, not the
 * enclosing field's — most notably `@alias:name`, attached here when a use site is
 * flattened past a REFERENCE entry (§8.3: "the alias attaches to the type value, not the
 * `record_field`"). Also absent-equals-empty, normalised to `[]`. The Java original excludes
 * `annotations` from this record's equality (identity is where a reference *points*, an
 * alias records where it *came from*); this package states that as the contract for
 * whoever compares two of these, since a plain TypeScript object has no equality method of
 * its own to carry the exclusion.
 */
export interface TypeRef {
  readonly name: string;
  readonly arguments: readonly TypeArgument[];
  readonly annotations: Annotations;
}

/**
 * One positional argument of a resolved {@link TypeRef} (§8.1, §9): the kernel's own
 * REQUIRED field *group* `{ (name: type_ref | value: value) }` — exactly one of a reference
 * or a literal is ever present (§5.11).
 *
 * Modelled as a discriminated union rather than a record with two optional fields: it is a
 * labelled choice, and a shape with two optional members would not say that exactly one is
 * ever present. `kind` is this package's own discriminant tag for narrowing — the kernel
 * itself distinguishes the two members by which field is present, not by a tag.
 *
 * The `name`-member case ({@link TypeArgumentRef}) holds every *reference* — a type, an
 * entry, or (inside a template body) a parameter of either kind — while the `value`-member
 * case ({@link TypeArgumentValue}) holds concrete literals only, so a token in a reference
 * position can never be mistaken for a value-typed enum-member literal (§8.1).
 */
export type TypeArgument = TypeArgumentRef | TypeArgumentValue;

/** A reference argument — the kernel's own `{ name: type_ref }` member. */
export interface TypeArgumentRef {
  readonly kind: 'ref';
  readonly ref: TypeRef;
}

/** A literal argument — the kernel's own `{ value: value }` member. */
export interface TypeArgumentValue {
  readonly kind: 'value';
  readonly value: Token;
}

/**
 * The meta-kernel's `reference` constructor's own vocabulary, resolved (§4.1, §8.1): a
 * `kind: REFERENCE` entry's body, `!reference { target: E }` — used directly by
 * `type_name`/`field_name`/`param_name` (aliasing `token`), the annotation markers
 * (`annotation`/`documentation`/`doc`/`alias`), and materialised template instantiations
 * (§5.10, §8.2). For a simple alias, `target` equals the entry's own `source`.
 *
 * `target` is a full {@link TypeRef}, so an alias to a still-open application states its
 * own arguments — §5.10's partial application, `uuid_pair => <B> pair<uuid, B>`, is an
 * alias whose target carries an argument list. **A closed alias never carries arguments**:
 * materialisation rewrites a fully-bound target to name the entry it minted, so an
 * argument-bearing `target` appears only where an application is still open, inside a
 * template (§8.3: the reference-flattening walk stops at an argument-bearing target rather
 * than treating it as a further hop).
 */
export interface Reference {
  readonly kind: 'reference';
  readonly target: TypeRef;
}

/**
 * meta.tn's `extern` constructor (`extern => ~sum & { schema: uri  types: [type_name]? }`)
 * — a reference to a type, or a whole vocabulary, declared in a separate,
 * externally-governed schema and named by its own `!!id` rather than resolved through the
 * current schema's own namespace.
 *
 * `schema` is kept as a plain URI string rather than a richer URL/URI type, matching every
 * other externally-cited-document field in this package (`RegexType.spec`, `UriType.spec`,
 * ...): the value arrives untyped off the wire, and a richer type would need a dependency
 * this package does not carry.
 *
 * `types` is the kernel's own `[type_name]?` — **absent and empty are the same list**; a
 * resolver MUST normalise an absent value to `[]`, the same convention {@link
 * TypeDefinition}'s own note states for its own list-shaped fields.
 *
 * Pure constraint shape: no compiled reader exists for this constructor (a documented gap in
 * the reference implementation), so this type carries no parsing or resolution behaviour —
 * a later work package's concern, not this value model's.
 */
export interface Extern {
  readonly kind: 'extern';
  readonly schema: string;
  readonly types: readonly string[];
}

/**
 * meta.tn's `unknown_type` constructor (`unknown_type => ~sum & {}`) — an empty SUM-kind
 * marker whose instance, `unknown` (core.tn), accepts any well-formed value of any type:
 * "the universe of types," distinct from both the absent sentinel and the unit type (§4.2).
 */
export interface UnknownType {
  readonly kind: 'unknown_type';
}

/**
 * A body describing **something other than a data value** (§4.1's fourth base kind,
 * `data => top & {}`) — vocabulary a meta-schema introduces beyond the kernel's own (an
 * `operation` describing an HTTP endpoint, say), whose instances ride along in a schema map
 * without being types.
 *
 * The one deliberately open member of {@link Top}: every other branch mirrors one kernel
 * constructor over a fixed, closed set of shapes, but the constructors reaching this one are
 * declared by meta-schemas this package has never seen. `kind` is a bare `string` here
 * rather than a literal union for the same reason — it is the constructor's own name
 * (`operation`), which this model cannot enumerate in advance.
 *
 * `references` names every type this body itself mentions, for a linker to resolve like any
 * other reference (§9: "a slot holding a type reference MUST be typed `type_ref`," which is
 * what lets it participate in flattening and identity). Declared rather than discovered — a
 * payload's shape alone says nothing about which of its components are references — and
 * optional here because a body naming none is the ordinary case; omitting the method entirely
 * means "none", mirroring the Java original's own empty-list default.
 *
 * **A method that is present must never return `null`/`undefined` — return `[]` for a body
 * that names no types.** The case to watch is an implementation returning an OPTIONAL bound
 * component directly: a binder hands an omitted field to the constructor as `undefined` and
 * does not normalise it to an empty array, so `references()` inherits that `undefined`.
 * `link/referenceValidation.ts` reports a body that breaks this as `TsonBindMismatchError`
 * naming the entry, since it is the reading application's mistake rather than anything about
 * the schema.
 *
 * An entry whose body is a `Data` is not a type: naming one where a type is expected is a
 * resolver error checked at schema load (§4.1) — a fact about how this shape is *used*, not
 * something this type itself enforces.
 */
export interface Data {
  readonly kind: string;
  references?(): readonly TypeRef[];
}

/**
 * The meta-kernel's `atom => top & {}` base kind (§4.1) — every ATOM-kind {@link Top}
 * variant. {@link Unit} backs `value`/`token`/`void` (the atom with no constraint
 * vocabulary, §4.2); {@link EnumBody} backs `boolean` and the kernel's other internal
 * enumerations; every other member is an atom constraint-vocabulary family, one per
 * `*_type` constructor (§9).
 *
 * This package ports only the *shape* of each family — its constraint fields — never the
 * narrowing/coherence rules the Java original attaches to them (`Atom.constraintsCheck`,
 * `Atom.coherenceCheck`, `AtomNarrowing`, `AtomCoherence`): those are resolver logic for a
 * later work package, not part of this value model.
 */
export type Atom =
  | Unit
  | EnumBody
  | IntegerType
  | TextType
  | UriType
  | RegexType
  | DecimalType
  | FloatType
  | RationalType
  | UuidType
  | BinaryType
  | DateType
  | TimeType
  | DateTimeType
  | DurationType
  | Cidr4Type
  | Cidr6Type
  | EmailType
  | MacType
  | Ipv4Type
  | Ipv6Type
  | ComplexType;

/**
 * The meta-kernel's structural root, `top => {}` (§4.1) — every type in a schema IS-A this,
 * and it is every {@link TypeDefinition.body}'s own declared type.
 *
 * A union of every resolved body shape rather than a marker interface: the Java original is
 * a sealed marker every variant `implements`, useful there for `instanceof` narrowing; a
 * TypeScript union serves the same purpose more directly, which is what "discriminated
 * unions on `kind`" (this package's convention throughout) means applied to the root of the
 * hierarchy.
 *
 * Two branches describe something other than a constructed value, and both compose with
 * `top` directly for that reason: {@link Data}, the meta layer's extension point, and
 * {@link TemplateBody}, the held body of an entry that declares type parameters (§5.10).
 * Every other member — reached through {@link Atom}, {@link Product}, or {@link Sum} —
 * carries a `kind` literal matching its resolved constructor's own name (`record`, `array`,
 * `integer_type`, ...), narrowable with an ordinary `switch (body.kind)`.
 *
 * {@link TemplateBody} is the one member with **no** `kind` tag at all: it never serialises
 * and has no constructor name of its own (§5.10), so code that must handle it narrows with
 * `'kind' in body` before switching on the tag.
 */
export type Top = Atom | Product | Sum | Reference | Data | TemplateBody;

/**
 * The meta-kernel's `type_definition` record, resolved (§4, §8.1) — what every schema
 * declaration ultimately resolves to, whatever declaration form produced it (§5.6, §8).
 *
 * `kind` is REQUIRED with no default and always present. `source` and `disjoint` are
 * genuinely optional (`readonly source?: TypeRef`, `readonly disjoint?: boolean`),
 * corresponding to the kernel's own OPTIONAL fields with no default — omit them to mean
 * "absent," never assign `undefined` explicitly.
 *
 * **`parameters`/`supertypes`/`subtypes` are conceptually OPTIONAL in the kernel too**
 * (`[param_name]?`, `[type_name]?`), but are modelled here as bare, always-present arrays —
 * mirroring what the Java original's own compact constructor normalises *to*, not the
 * kernel's own field cardinality. The Java constructor's exact rule: "absent and empty are
 * the same list here... a definition bound from a resolved-form document that omits one
 * arrives with `null` where one resolved from source arrives with an empty list," and the
 * constructor coalesces `null` to `List.of()`. **The TypeScript type cannot enforce this
 * normalisation** — nothing stops a caller from constructing an object with the field
 * missing entirely if it is ever made optional — so the contract is stated here instead:
 * whatever builds a `TypeDefinition` MUST supply `[]` for any of these three fields that has
 * no members, never leave it unset, and any code reading resolver output from an external
 * source (ingest, §8.1) MUST perform that same defaulting before constructing one.
 *
 * **`annotations` follows the identical rule**: always an array, never optional, and a
 * builder reading a definition with no annotations stated MUST supply `[]` — mirroring the
 * Java constructor's `annotations == null ? Annotations.empty() : annotations`.
 *
 * **`constructor` is a plain, always-present `boolean`** (`true` when declared with `~`,
 * §4.2) — no OPTIONAL wrapping and no normalisation question, called out only so its
 * absence from the list above is not mistaken for an oversight.
 *
 * **Two supertype fields answer different questions (§8.1).** This field, `supertypes`, is
 * the **transitive** IS-A chain: direct parents plus each parent's own chain, deduplicated;
 * a `Product`-shaped body's own `supertypes` component (e.g. {@link RecordBody.supertypes})
 * records only the **direct** `&` compositions as written. `subtypes` is a resolver-managed
 * cache — the transitive inverse of `supertypes` across the schema's namespace — fully
 * recomputable and never trusted: ingest (§8.1) MUST discard and recompute it, never take it
 * from a document.
 *
 * `disjoint` is likewise a resolver-derived cache, recorded only on SUM-kind definitions
 * (§5.4): discrimination-class distinctness among a choice's variants. Also discarded and
 * recomputed on ingest rather than ever taken from a document.
 *
 * `position` has no counterpart in the kernel's own `type_definition` at all — it is this
 * implementation's own diagnostic addition (the Java original marks it `@Unbound` for
 * exactly this reason), present only when the definition's source position is known.
 */
export interface TypeDefinition {
  readonly source?: TypeRef;
  readonly kind: TypeKind;
  readonly parameters: readonly string[];
  readonly constructor: boolean;
  readonly supertypes: readonly string[];
  readonly subtypes: readonly string[];
  readonly disjoint?: boolean;
  readonly body: Top;
  readonly position?: SourcePosition;
  readonly annotations: Annotations;
}
