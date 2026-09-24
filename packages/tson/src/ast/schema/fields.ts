import type { Annotation, DataValue, TokenValue } from '../value.js';

import type { TypeRef } from './typeref.js';

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

/** `field-type = type-ref ["?"]` (§12.1, §5.2) — `voidable` is the type's own `?`: a written `_` is admitted at this field when `true`. */
export interface FieldType {
  readonly typeRef: TypeRef;
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
 * `group-def = *annotation "(" ws group-member 1*(ws "|" ws group-member) ws ")" ["?"]`
 * (§12.1, §5.11) — a field group: mutually exclusive labelled members occupying one logical
 * record position. The field name is the discriminator; the wire form of instances is
 * unchanged by grouping.
 *
 * `members` has at least two elements by grammar — a declared group of one has a simpler
 * spelling (a plain field with the group's state), and the grammar refuses the noise — encoded
 * here as a non-empty (2+) tuple type. `optional`: a bare group is REQUIRED (exactly one
 * member MUST be present in conforming data); with a trailing `?`, OPTIONAL (at most one MAY
 * be present). These are the group's only two states — no default or fixed form in v1.
 */
export interface GroupDef {
  readonly kind: 'groupDef';
  readonly annotations: readonly Annotation[];
  readonly members: readonly [GroupMember, GroupMember, ...GroupMember[]];
  readonly optional: boolean;
}

/**
 * `group-member = *annotation field-name ws ":" ws type-ref ["?"]` (§12.1, §5.11) — one labelled
 * alternative of a {@link GroupDef}. Deliberately bare on the name: no `?` on it and no `~`/`=`/
 * `=?` value modifier — selection belongs to the label, presence belongs to the group, and a
 * group never injects. The type's own `?` is admitted (`voidable`): a voidable member written
 * `_` is present and selects its alternative (§5.11).
 */
export interface GroupMember {
  readonly annotations: readonly Annotation[];
  readonly name: string;
  readonly typeRef: TypeRef;
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
 * Each bound is preserved as raw token text, not parsed to a number: within a template body a
 * bound MAY be a value-parameter name instead of a `decimal-natural` literal (§5.3), and
 * classifying which is a later, semantic-layer step ("parameters cannot be numeric" is the
 * disambiguation rule, but nothing at this layer needs to act on it).
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
 * `instance = [type-params] "!" type-name ws core-value` (§12.1, §5.5) — constructor
 * application: produces a fresh atom-family instance filled with `value`'s own core-value.
 *
 * The payload is deliberately narrower than a full `data-value` (`*annotation [type-ref]
 * core-value`, [TSON-DATA] §2.3), which would let it carry its own further annotations and a
 * second, competing type-ref; §12.1 states that no production of the schema grammar takes the
 * full `data-value`.
 *
 * **A parameter list makes it a template, and changes nothing else.**
 * `<T> !array { element_type: T }` is this same shape with `typeParams` non-empty, and its
 * payload is unrestricted for the same reason the closed form's is: an open entry's body is
 * held rather than read against its constructor's vocabulary until materialisation has
 * substituted the parameters away, so a collection payload — `<T> !choice { variants: [T
 * error] }` — is as ordinary here as a scalar one. A parameterized atom refinement is not a
 * form at all: the atom-refinement production has no parameter list, a refinement of an atom
 * instance having no parameter to take (§5.10).
 *
 * **No separate `target` field.** `value` (a `DataValue`, imported from `../value.js`) already
 * has exactly the right shape to carry the constructor name via its own `typeRef` — always
 * present here, populated from the `"!" type-name` prefix at parse time — and `value`'s own
 * `annotations` are always empty (the grammar has no room for any). A reader wanting the
 * constructor name reads `value.typeRef`.
 *
 * `value.typeRef`'s name MUST resolve to a constructor (a semantic-layer check, not enforced
 * here). This form establishes no IS-A — construction transfers only the constructor's kind
 * (§4.1, §5.5), unlike {@link AtomRefinement}.
 */
export interface Instance {
  readonly kind: 'instance';
  readonly typeParams: readonly string[];
  readonly value: DataValue;
}

/**
 * `atom-refinement = "!" type-name ws "^" ws record-def` (§12.1, §5.5) — refines an
 * atom-family instance by tightening its constructor's constraint fields. `target` MUST
 * resolve to a non-constructor atom-family instance and `bindings` is a braced record of
 * constraint values (both semantic-layer checks, not enforced here); this establishes IS-A
 * with `target`, unlike {@link Instance}.
 *
 * `bindings` is a {@link DataValue}, not a `RecordDef`, and the difference is not
 * cosmetic. A refinement body is braced constraint bindings, but the *values* bound are ordinary
 * data — including nested records. `RecordDef` is a schema production whose members are type
 * definitions, so it cannot represent `{ size: { bits: 8  signed: true } }`, which is
 * `spec/m/core.tn` line 105 and the shape §5.5's own worked example uses. Typed as a
 * `RecordDef`, the bundled `core.tn` does not parse at all. The reference implementation carries
 * it the same way: `AtomRefinement(String target, DataValue bindings)`, built from
 * `parseCoreValue()`.
 *
 * No parameter list — a parameterized atom refinement is not a grammar production (§5.10): a
 * refinement of an atom instance has no parameter slot to route through.
 */
export interface AtomRefinement {
  readonly kind: 'atomRefinement';
  readonly target: string;
  readonly bindings: DataValue;
}
