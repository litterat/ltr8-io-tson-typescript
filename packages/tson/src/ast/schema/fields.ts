import type { Annotation, DataValue, TokenValue } from '../value.js';

import type { FieldTypeExpr } from './typeref.js';

/**
 * `record-entry = field-def / group-def` (Part 2 §12.1) — one entry inside a `RecordDef`'s
 * braces. Discriminated on `kind` via its two members' own `kind` fields.
 */
export type RecordEntry = FieldDef | GroupDef;

/**
 * `field-def = *annotation field-name ["?"] ws ":" ws ( field-type field-modifier / field-type /
 * field-modifier )` (§12.1, §5.2) — one record field, answering three independent questions: the
 * name's own `?` (`optional`, below), the type's own `?` ({@link FieldType.voidable}), and the
 * modifier (`~`/`=`/`=?`).
 *
 * Exactly one of `type`/`modifier` may be absent, never both — a bare `field:` with neither a
 * type-ref nor a modifier is not a grammar production; a parser building this type is
 * responsible for that non-empty-union rule (this layer states the shape, not the check).
 * Where `type` is absent, the type is elided and inherited from a refinement/composition
 * source (§5.7's "elided type-refs") — legal only there; rejecting an elided type-ref in a
 * fresh record definition is a later, semantic-layer job (§5.2).
 *
 * **Three slots, spelled independently.** §5.2 gives a field three marks that never interact
 * grammatically: `optional` here, `voidable` on {@link FieldType}, and the modifier's own kind
 * and value. What each combination *resolves to*
 * — a `schema.meta` `RecordField`'s `optional`/`voidable`/`role`/`value` — is a resolver fact,
 * out of scope for this grammar-only AST; every spelling §5.2 tables is representable here, and
 * the four refusals it states over them (a default on an unmarked name, a pin on a voidable
 * type, a modifier on `void`, `=?` outside its one admitted shape) are resolver errors, not
 * parse errors — this layer does not reject them.
 */
export interface FieldDef {
  readonly kind: 'fieldDef';
  readonly annotations: readonly Annotation[];
  readonly name: string;
  /** The name's own `?` (§5.2): the key MAY be omitted when `true`. */
  readonly optional: boolean;
  readonly type?: FieldType;
  readonly modifier?: FieldModifier;
}

/**
 * `field-type = type-expr ["?"] / dependent-type` (§12.1, §5.2) — `voidable` is the type's own `?`: a written `_`
 * is admitted at this field when `true`.
 */
export interface FieldType {
  readonly typeRef: FieldTypeExpr;
  readonly voidable: boolean;
}

/**
 * `field-modifier = ws ("~" / "=") ws token / ws "=" ws "?"` (§12.1, §5.2) — `~` is
 * {@link FieldModifierDefault}, `=` is {@link FieldModifierFixed}, and `=?` is
 * {@link FieldModifierSelector}, the discriminator a family's members pin (§5.2). The absent
 * sentinel is not a modifier value: a field that may be omitted or written as `_` and nothing
 * else is spelled `a?: void?`, never `~ _` or `= _`. Every value-bearing modifier carries an
 * ordinary scalar token, never annotated, never typed, never a container: §12.1 states that no
 * production of the schema grammar uses the full `data-value`, and §5.2 restricts modifier
 * values to scalar tokens.
 */
export type FieldModifier = FieldModifierDefault | FieldModifierFixed | FieldModifierSelector;

/** `~ token` — the value is a **default**, supplied when the key is omitted and overridable by a written value (§5.2). */
export interface FieldModifierDefault {
  readonly kind: 'default';
  readonly token: TokenValue;
}

/** `= token` — the value is **fixed**; a written value MUST equal it (§5.2). */
export interface FieldModifierFixed {
  readonly kind: 'fixed';
  readonly token: TokenValue;
}

/**
 * `= ?` — the selector a discriminated family's members pin (§5.2): no value follows. Legal only
 * on an unmarked name and a non-voidable type; a resolver error everywhere else (checked at
 * resolution, not here).
 */
export interface FieldModifierSelector {
  readonly kind: 'selector';
}

/**
 * `group-def = *annotation "(" group-option *( "|" group-option ) ")" [ "?" / "+" ]`
 * (§12.1, §5.11) — a field group: a presence rule over the fields its options hold. An option is
 * chosen when any of its members is present, and a chosen option holds every member whose name is
 * not marked `?`. A bare group admits exactly one chosen option, `?` at most one, and `+` at least
 * one of its members, each option then being one field. The field names are the discriminator; the
 * wire form of instances is unchanged by grouping.
 *
 * This is the group as written. `options` holds at least one option and each option at least one
 * member, in source order; the grammar's shape rules and the lowering to the kernel's
 * `members`/`optional_members`/`optional` belong to later phases.
 */
export interface GroupDef {
  readonly kind: 'groupDef';
  readonly annotations: readonly Annotation[];
  readonly options: readonly (readonly [GroupMember, ...GroupMember[]])[];
  readonly quantifier: GroupQuantifier;
}

/**
 * The mark after a group's closing `)` (§5.11): bare is `EXACTLY_ONE` (one option chosen), `?` is
 * `AT_MOST_ONE`, and `+` is `AT_LEAST_ONE` (at least one member present, every option being one
 * field).
 */
export type GroupQuantifier = 'EXACTLY_ONE' | 'AT_MOST_ONE' | 'AT_LEAST_ONE';

/**
 * `group-member = *annotation field-name ["?"] ws ":" ws field-type` (§12.1, §5.11) — one
 * member of a {@link GroupDef} option. The name's `?` (`omittable`) makes the member optional once
 * its option is chosen; the type's (`voidable`) admits `_`, and a voidable member written `_` is
 * present and chooses its option. A member takes no `~`/`=`/`=?` value modifier, since a group
 * never supplies a member.
 */
export interface GroupMember {
  readonly annotations: readonly Annotation[];
  readonly name: string;
  readonly omittable: boolean;
  readonly typeRef: FieldTypeExpr;
  readonly voidable: boolean;
}

/**
 * The size specifier after `;` in an `ArrayRef` or a `MapRef` (`typeref.ts`) (§12.1, §5.3):
 * `size-spec = size-bound [ws ".." ws [size-bound]] / ".." ws size-bound`.
 *
 * Four surface spellings, kept structurally distinct here rather than collapsed — collapsing
 * `N` into `N..N` is a resolution-time equivalence (§5.3: "two spellings of the same
 * application"), not a grammar fact, and this layer only builds the grammar's own AST.
 *
 * Each bound is preserved as raw token text; `size-bound` is `decimal-natural` (§12.1), which the desugar
 * phase checks, naming a parameter written there as the slot a parameter cannot stand at (§5.10).
 */
export type SizeSpec = SizeSpecExact | SizeSpecRanged | SizeSpecMin | SizeSpecMax;

/** `N` — exactly N elements. */
export interface SizeSpecExact {
  readonly kind: 'exact';
  readonly bound: string;
}

/** `N..M` — bounded range; `N` MUST be `<= M` once both are concrete (checked at resolution). */
export interface SizeSpecRanged {
  readonly kind: 'ranged';
  readonly lower: string;
  readonly upper: string;
}

/** `N..` — at least N elements. */
export interface SizeSpecMin {
  readonly kind: 'min';
  readonly lower: string;
}

/** `..M` — at most M elements. */
export interface SizeSpecMax {
  readonly kind: 'max';
  readonly upper: string;
}

/**
 * `removal-set = "-" ws "{" ws field-name *(separator field-name) ws "}"` (§12.1, §5.9) — the
 * trailing removal clause on a construction (`ConstructionDef`, `typedef.ts`), naming fields
 * (or field-group members) to drop and deliberately break IS-A.
 *
 * At least one name is required by grammar — "empty subtraction does not exist" (§5.9 rule 6)
 * — encoded here as a non-empty tuple type.
 */
export interface RemovalSet {
  readonly fieldNames: readonly [string, ...string[]];
}

/**
 * `instance = [type-params] "!" qualified-name ws core-value` (§12.1, §5.5) — constructor
 * application: a fresh instance filled with `value`'s own core-value, or over a type that is no
 * constructor a value entry of that type. The payload is a `core-value`, the data grammar's, so it
 * holds no argument list and no dependent type ([TSON-DATA] §7.2.5).
 *
 * **A parameter list is admitted before `!meta.record` alone** (§5.10), the explicit spelling of a
 * parametric record; which head it precedes is the resolver's question, not the grammar's.
 *
 * **No separate `target` field.** `value.typeRef` carries the constructor name, populated from the
 * `"!" qualified-name` prefix at parse time, and `value`'s own `annotations` are always empty.
 */
export interface Instance {
  readonly kind: 'instance';
  readonly typeParams: readonly string[];
  readonly value: DataValue;
}

/**
 * `atom-refinement = "!" qualified-name ws "^" ws record-def` (§12.1, §5.5, §5.7) — `^` follows `!name` and
 * takes values: over a type built by an atom constructor, `meta.array`, `meta.map` or a constructor IS-A either,
 * it refines the type and establishes IS-A with `target`; over a constructor of types it declares an
 * incomplete entry, and over an incomplete entry a further one (§5.5). Which, is the resolver's question.
 *
 * `bindings` is a {@link DataValue}: the braces hold constraint values — ordinary data, nested records
 * included (`{ size: { bits: 8  signed: true } }`) — which no schema production represents.
 *
 * No parameter list — a parameterized refinement is not a grammar production (§5.10).
 */
export interface AtomRefinement {
  readonly kind: 'atomRefinement';
  readonly target: string;
  readonly bindings: DataValue;
}
