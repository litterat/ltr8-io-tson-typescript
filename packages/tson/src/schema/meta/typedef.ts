/**
 * The resolver's own output record, `type_definition` (Part 2 §4, §8.1), and the type-system
 * vocabulary it is built from: kinds, references, applications, cross-schema scoping, and the
 * structural root every resolved body composes with.
 *
 * This module, like every other module in `schema/meta`, depends on nothing but itself, sibling
 * modules in this same directory, and `core/` — never a compiler type. Two shapes here are local
 * stand-ins for that reason: {@link Token} mirrors `ast.TokenValue`, and {@link SourcePosition}
 * (declared in `./position.js`) is structurally satisfied by `core/position.ts`'s `Position` with
 * no conversion. {@link Annotation}/{@link Annotations} are a third, minimal stand-in: the real
 * wire-annotation carrier (`src/annotations`) also exposes lookup methods, but only the data
 * shape those methods read is needed here.
 */
import type { SourcePosition } from './position.js';
import type { ChoiceBody, EnumBody, TemplateBody } from './bodies.js';
import type { Product, Sum, Unit } from './algebra.js';
import type {
  IntegerType,
  FloatType,
  DecimalType,
  RationalType,
  ComplexType,
} from './atoms-numeric.js';
import type { TextType, UriType, RegexType, EmailType, UuidType } from './atoms-text.js';
import type { BytesType } from './atoms-bytes.js';
import type {
  DateType,
  TimeType,
  DateTimeType,
  DurationType,
  PeriodType,
} from './atoms-temporal.js';
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
 * carries none: see {@link TypeDefinition}'s own note on the "absent and empty are the same
 * list" convention this package follows for every list-shaped field.
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
 * An entry's kind (§4.1, §8.1) — the four base kinds, plus TEMPLATE for an open entry that is
 * not yet a type at all (§5.10). **Not a stored field of {@link
 * TypeDefinition}**: §8.1 removes `kind` from resolver output because it restated what
 * `supertypes` and `body` already determine and was the one thing a document could be lied to
 * about. {@link typeKind} derives it; nothing in this package caches or threads it as a
 * parameter.
 */
export type TypeKind = 'ATOM' | 'PRODUCT' | 'SUM' | 'REFERENCE' | 'DATA' | 'TEMPLATE';

/**
 * A resolved reference to a named entry (§8.1). `name` is the only field the kernel's own
 * `type_ref` requires, so an argument-free reference is written as the bare token everywhere
 * the positional-form rule applies (§5.6), never as `!type_ref { name: ... }`.
 *
 * **`arguments` non-empty means "an application"**, and appears in output only inside
 * template bodies and in `source` provenance (§8.1) — a use-site application is always
 * flattened to a bare reference to its materialised entry before it reaches output (§8.2).
 * **Absent and empty are the same list**: the kernel's `arguments: [type_argument]?` is
 * OPTIONAL with no default, so a resolver MUST normalise an unstated value to `[]` rather than
 * leaving it unset — the same convention {@link TypeDefinition}'s own note states for its
 * list-shaped fields.
 *
 * `annotations` carries the wire annotations written on the reference **itself**, not the
 * enclosing field's. A reference is a hop, never a rewrite (§8.3): a use site names what the
 * author wrote and nothing is ever rewritten into a use site's own reference, so this field
 * carries only annotations the author actually placed on that particular reference token — no
 * resolver-attached provenance ever lands here. Also absent-equals-empty, normalised to `[]`.
 * The Java original excludes `annotations` from this record's equality (identity is where a
 * reference *points*); this package states that as the contract for whoever compares two of
 * these, since a plain TypeScript object has no equality method of its own to carry the
 * exclusion.
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
 * (`annotation`/`documentation`/`doc`), and materialised template instantiations (§5.10,
 * §8.2). For a simple alias, `target` equals the entry's own `source`.
 *
 * `target` is a full {@link TypeRef}, so an alias to a still-open application states its
 * own arguments — §5.10's partial application, `uuid_pair => <B> pair<uuid, B>`, is an
 * alias whose target carries an argument list. **A closed alias never carries arguments**:
 * materialisation rewrites a fully-bound target to name the entry it minted, so an
 * argument-bearing `target` appears only where an application is still open, inside a
 * template (§8.3: the reference-flattening walk stops at an argument-bearing target rather
 * than treating it as a further hop).
 *
 * **A reference is a hop, never a rewrite** (§8.3): a use site elsewhere in the output that
 * names this entry names this entry, and no walk collapses `target` into whatever `target`
 * itself resolves to before writing it out. A consumer that needs a terminal type still walks
 * the chain (subsumption, refinement sources, atom refinement, ...); the walk is a caller's own
 * traversal over `target`, never something this shape performs or memoises.
 */
export interface Reference {
  readonly kind: 'reference';
  readonly target: TypeRef;
}

/**
 * Which namespace a value's type may be drawn from (§7.8) — meta.tn's `scope_kind` enum, the
 * element type of {@link Scoped.scope}. The two cells are independent questions about a
 * position, which is why `scope` is a set rather than a three-valued selector: a position may
 * admit either, both, or — unrepresentably, `scope` carrying `min_items: 1` — neither.
 */
export type ScopeKind = 'LOCAL' | 'EXTERN';

/**
 * meta.tn's `scoped` constructor's own vocabulary, resolved (§7.8): the open sum, in which the
 * value names its own type and the instance names the namespaces that name may be resolved in.
 * One constructor covers every scoped position: core's `declared`, `extern` and `dynamic` are
 * all instances of it, distinguished only by `scope`.
 *
 * Distinct from {@link ChoiceBody} on closed-versus-open: a choice enumerates its variants; a
 * scoped instance names where variants are drawn from. That is also why `disjoint` never
 * applies here as it does not on any non-choice sum (§8.1) — a fact about a variant list has
 * nowhere to live on a body with none.
 *
 * `scope` says which namespaces are admitted — the kernel's own `set<scope_kind>`, `min_items:
 * 1` — modelled as a bare array on the absent-equals-empty convention this package states
 * throughout, though a coherent instance's `scope` is never actually empty.
 *
 * `schemas` narrows the foreign namespace, when `scope` holds `EXTERN`: absent admits any
 * foreign schema; present, it maps each admitted schema's canonical URI to the type names
 * admitted from it, an empty list meaning every type that schema declares — the kernel's own
 * `[type_name; 1..]?` collapsed onto this package's absent-equals-empty convention, since a
 * list that is present at the wire is never itself empty. Keys compare by canonical identity
 * (§2.2.1), so a pinned key and an unpinned `!!schema` in the data match.
 *
 * Pure constraint values, no reading behaviour: the dispatch this constructor drives — the
 * governing-schema switch on descent into an EXTERN value — is a later work package's concern,
 * not this value model's.
 */
export interface Scoped {
  readonly kind: 'scoped';
  readonly scope: readonly ScopeKind[];
  readonly schemas?: ReadonlyMap<string, readonly string[]>;
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
 * variant. {@link Unit} backs `value`/`identifier`/`void` (the atom with no constraint
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
  | BytesType
  | DateType
  | TimeType
  | DateTimeType
  | DurationType
  | PeriodType
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
 * as a value of this vocabulary and has no constructor name of its own (§5.10), so code that
 * must handle it narrows with {@link isTemplateBody} before switching on `kind`.
 */
export type Top = Atom | Product | Sum | Reference | Data | TemplateBody;

/**
 * Whether `body` is the held, unresolved body of an open entry (§5.10) — the one {@link Top}
 * member with no `kind` tag of its own (see {@link Top}'s own note), so every switch over a
 * resolved body runs this check first.
 */
export function isTemplateBody(body: Top): body is TemplateBody {
  return 'template' in body && 'parameters' in body;
}

/**
 * Whether `def` IS-A `top` (§4.2, §8.1) — which is what makes it a constructor. Derived from
 * `supertypes` rather than stated: the kernel carries no marker for it, so this is not a fact a
 * document can be wrong about.
 *
 * True of every entry whose (transitive) {@link TypeDefinition.supertypes} includes `'top'` —
 * `atom`, `product`, `sum`, `data`, `reference`, `template`, and everything a schema composes
 * with one of those, directly or through further composition and refinement. False of an
 * ordinary instance (`integer => !integer_type {}`) or a refinement of one
 * (`positive_integer => !integer ^ { min: 1 }`), neither of which composes with `top` at all —
 * an application mints a fresh entry with no IS-A chain of its own (§8.1's `supertypes` note).
 *
 * `top` itself is the one entry this predicate does not answer for: its own `supertypes` is
 * `[]` by definition (it is the root, with no parent to record), so `isConstructor` applied to
 * `top`'s own definition reads `false` even though `top` IS-A itself. Nothing in this package
 * or its known callers ever asks `top`'s own constructorness — only whether some *other* entry
 * composes with it — so the edge case is noted rather than special-cased away.
 */
export function isConstructor(def: TypeDefinition): boolean {
  return def.supertypes.includes('top');
}

/**
 * The type parameters `def` declares (§5.10) — `[]` unless its body is held. Not stored: a held
 * body already carries the list it binds ({@link TemplateBody.parameters}), so "does this entry
 * declare parameters?" and "what does its body hold?" are one question with one answer and
 * cannot disagree.
 */
export function typeParameters(def: TypeDefinition): readonly string[] {
  return isTemplateBody(def.body) ? def.body.parameters : [];
}

/**
 * `def`'s own choice-disjointness fact (§5.4, §8.1) — present exactly when `def.body` is a
 * {@link ChoiceBody}, absent for every other body shape. The fact is about a variant list, so it
 * lives on the one body that has one ({@link ChoiceBody.disjoint}) and an entry with no variants
 * has nowhere to put it — "recorded on every choice and absent on everything else" is structural
 * rather than a rule a document could break.
 */
export function choiceDisjoint(def: TypeDefinition): boolean | undefined {
  const body = def.body;
  return !isTemplateBody(body) && isChoiceBody(body) ? body.disjoint : undefined;
}

/**
 * `'variants' in body` rather than `body.kind === 'choice'` alone: `Data.kind` is a bare
 * `string` (§4.1's own open extension point), so an equality check against the literal
 * `'choice'` cannot rule a `Data` body out on the type level, even though no real one is ever
 * tagged that way — the same problem `link/bodyKind.ts`'s own `isDataBody` exists to solve for
 * every other switch in this codebase over a `Top` body.
 */
function isChoiceBody(body: Exclude<Top, TemplateBody>): body is ChoiceBody {
  return 'variants' in body;
}

/**
 * The four base-kind names {@link typeKind}'s third branch searches `TypeDefinition.supertypes`
 * for, in the order the base kinds are declared in the meta-kernel — order has no semantic
 * weight, since a coherent schema's `supertypes` names at most one of them, but a stable order
 * keeps the derivation deterministic even over a document that has not yet been checked
 * coherent.
 */
const BASE_KIND_NAMES: readonly (readonly [string, TypeKind])[] = [
  ['atom', 'ATOM'],
  ['product', 'PRODUCT'],
  ['sum', 'SUM'],
  ['data', 'DATA'],
];

/**
 * Derives `def`'s {@link TypeKind} (§4.1, §8.1) — resolver output carries no `kind` field;
 * every conforming resolver derives the same answer from `supertypes` and `body` alone. `lookup`
 * resolves a type name to its definition within the same namespace, consulted only by the
 * fourth branch.
 *
 * The four branches, in order — the first that matches wins:
 *
 * 1. `body` is a {@link TemplateBody} → `'TEMPLATE'`, an open entry with no kind of its own
 *    (§5.10).
 * 2. Else `body`'s own constructor head is `'reference'` → `'REFERENCE'` — the head lookup
 *    would say `'PRODUCT'`, since the kernel's `reference` is itself a product, and §4.1 makes
 *    REFERENCE a kind the alias form confers rather than a base kind.
 * 3. Else `def` {@link isConstructor | IS-A `top`} → the base-kind name among its own
 *    `supertypes` (`'atom'` → ATOM, `'sum'` → SUM, `'data'` → DATA), or `'PRODUCT'` if none of
 *    them appears — a constructor's kind states what its *instances* are, not what its own body
 *    is (`integer_type` has a `!record` body listing its own fields, and is ATOM-kinded).
 * 4. Else `def` is an ordinary instance or refinement: the kind of the entry `body`'s own
 *    constructor head names, resolved through `lookup` and derived recursively.
 *
 * A `lookup` that cannot resolve the fourth branch's head — an unresolved reference in the
 * graph handed in — is a schema-load error a caller is expected to have already refused before
 * ever deriving a kind over the result; this function does not itself guard against that or
 * against a cycle, and throws rather than returning a meaningless answer.
 */
export function typeKind(
  def: TypeDefinition,
  lookup: (name: string) => TypeDefinition | undefined,
): TypeKind {
  if (isTemplateBody(def.body)) return 'TEMPLATE';
  if (def.body.kind === 'reference') return 'REFERENCE';
  if (isConstructor(def)) {
    for (const [name, kind] of BASE_KIND_NAMES) {
      if (def.supertypes.includes(name)) return kind;
    }
    return 'PRODUCT';
  }
  const head = def.body.kind;
  const headDef = lookup(head);
  if (headDef === undefined) {
    throw new Error(
      `cannot derive a type kind: '${head}' does not resolve in the supplied namespace`,
    );
  }
  return typeKind(headDef, lookup);
}

/**
 * The meta-kernel's `type_definition` record, resolved (§4, §8.1) — what every schema
 * declaration ultimately resolves to, whatever declaration form produced it (§5.6, §8).
 *
 * Four fields are deliberately absent, each because it would restate a fact `supertypes` and
 * `body` already determine — and a restated fact is one a document can state wrongly:
 *
 * - **No `constructor`.** Whether an entry is a constructor is whether it {@link isConstructor
 *   | IS-A `top`}, derived from `supertypes`.
 * - **No `kind`.** {@link typeKind} derives it from `body` and `supertypes` together.
 * - **No `parameters`.** {@link typeParameters} reads it off `body` when `body` is a
 *   {@link TemplateBody}.
 * - **No `disjoint`.** {@link choiceDisjoint} reads it off `body` when `body` is a
 *   {@link ChoiceBody} — the only body shape a variant list, and so a disjointness fact about
 *   one, can live on.
 *
 * **`supertypes`/`subtypes` are conceptually OPTIONAL in the kernel** (`[type_name]?`), but
 * modelled here as bare, always-present arrays — mirroring what the Java original's own compact
 * constructor normalises *to*, not the kernel's own field cardinality. **Absent and empty are
 * the same list here**: a definition bound from a resolved-form document that omits one arrives
 * with nothing where one resolved from source arrives with an empty list, and whatever builds a
 * `TypeDefinition` MUST supply `[]` for either field that has no members, never leave it unset.
 *
 * **`annotations` follows the identical rule**: always an array, never optional, and a builder
 * reading a definition with no annotations stated MUST supply `[]`.
 *
 * **Two supertype fields answer different questions (§8.1).** This field, `supertypes`, is
 * the **transitive** IS-A chain: direct parents plus each parent's own chain, deduplicated;
 * a `Product`-shaped body's own `supertypes` component (e.g. {@link RecordBody.supertypes})
 * records only the **direct** `&` compositions as written. `subtypes` is a resolver-managed
 * cache — the transitive inverse of `supertypes` across the schema's namespace — fully
 * recomputable and never trusted: ingest (§8.1) MUST discard and recompute it, never take it
 * from a document.
 *
 * `position` has no counterpart in the kernel's own `type_definition` at all — it is this
 * implementation's own diagnostic addition (the Java original marks it `@Unbound` for
 * exactly this reason), present only when the definition's source position is known.
 */
export interface TypeDefinition {
  readonly source?: TypeRef;
  readonly supertypes: readonly string[];
  readonly subtypes: readonly string[];
  readonly body: Top;
  readonly position?: SourcePosition;
  readonly annotations: Annotations;
}
