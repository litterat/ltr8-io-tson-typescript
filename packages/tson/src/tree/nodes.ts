import type { Annotations } from '../annotations/index.js';
import { EMPTY_ANNOTATIONS } from '../annotations/index.js';
import type {
  Cidr,
  Complex,
  Ipv4Address,
  Ipv6Address,
  MacAddress,
  PlainDate,
  PlainDateTime,
  PlainTime,
  Rational,
  TsonDecimal,
  TsonDuration,
  Uuid,
} from '../value/types.js';

/**
 * The `TsonValue` tree model, ported from `tson-tree` (`io.ltr8.tson.tree.*`) — the queryable,
 * structure-preserving, annotation-aware node type a schema-driven read or a schemaless `readTree` hands
 * back. Distinct from the grammar-faithful parse tree in `ast/value.ts`: a node here carries typed leaf
 * values and query ergonomics the parse tree deliberately doesn't, and drops lexical detail (token
 * quoting) the parse tree keeps.
 *
 * **Naming divergence from the Java, stated here rather than left implicit.** The Java sealed interface
 * is `TsonValue`, with members `TsonRecord`/`TsonMap`/`TsonArray`/`TsonTuple`/`TsonAtom`/`TsonAbsent`/
 * `TsonMissing` — no `Node` suffix; the Java Javadoc calls the *addition* of one elsewhere "anti-Jackson"
 * naming it deliberately avoids. This port cannot follow suit: `Record` is a TypeScript global utility
 * type and `Map`/`Array` are globals, so a bare `interface Record`/`Map`/`Array` in this module would
 * shadow them for the whole file (and, via re-export, confuse any file importing them unqualified
 * alongside this module's own). Every member of the union therefore takes a `Node` suffix instead —
 * `RecordNode`, `MapNode`, `ArrayNode`, `TupleNode`, `AtomNode`, `AbsentNode`, `MissingNode` — and the
 * union itself is named `Value`, matching this file's own requested export name rather than `TsonValue`
 * (the `Tson` prefix is otherwise reserved for error classes in this port; see `core/errors.ts`).
 *
 * **Types and trivial constructors only.** Navigation (`get`/`at`) and the two typed-access families
 * (`as`/`asString`, which *cast*, versus `asInt`/`asLong`/`asDouble`, which *convert*) are declared below
 * as signatures only, per this file's own scope — implementing them (RFC 6901 pointer walking, exact
 * decimal conversion) is `tree/accessors.ts`, a later work package, not this file.
 */

// ---------------------------------------------------------------------------------------------
// The node union
// ---------------------------------------------------------------------------------------------

/**
 * A node in a TSON document tree — the sealed union this file exists to define. Discriminated on `kind`.
 * See this file's own TSDoc for why every member carries a `Node` suffix where the Java original has
 * none.
 */
export type Value =
  RecordNode | MapNode | ArrayNode | TupleNode | AtomNode | AbsentNode | MissingNode;

/**
 * A record node — named fields in a stable order (§2.5). Mirrors `TsonRecord`. Duplicate field names are
 * already resolved ("last value wins", §2.5) before a tree is built, so `fields` carries unique keys.
 *
 * Field order is whatever the producing reader inserted — for a schema-driven read, the fields the
 * document stated in document order, then the ones the schema supplied (defaults, fixed values) in
 * declaration order. That is not necessarily §8.1 declaration order end to end (see `TsonRecord`'s own
 * Javadoc); a consumer needing that order sorts against the schema rather than trusting this map.
 */
export interface RecordNode {
  readonly kind: 'record';
  readonly fields: ReadonlyMap<string, Value>;
  readonly typeRef?: string;
  readonly annotations: Annotations;
}

/** One key/value entry of a {@link MapNode}. Mirrors the nested `TsonMap.Entry`. */
export interface MapEntry {
  readonly key: Value;
  readonly value: Value;
}

/**
 * A map node — ordered key→value entries whose **keys are themselves nodes** (TSON map keys can be
 * typed, §2.6), unlike a record's plain string field names. Mirrors `TsonMap`.
 */
export interface MapNode {
  readonly kind: 'map';
  readonly entries: readonly MapEntry[];
  readonly typeRef?: string;
  readonly annotations: Annotations;
}

/**
 * An array node — ordered, variable-length elements of a single element type (§2.7). Mirrors `TsonArray`.
 * Distinct from {@link TupleNode}, which only a schema-driven read produces for a fixed-arity,
 * positionally-typed sequence; the grammar itself has no array/tuple distinction (§2.7 vs. §5.4 of
 * [TSON-SCHEMA]).
 */
export interface ArrayNode {
  readonly kind: 'array';
  readonly elements: readonly Value[];
  readonly typeRef?: string;
  readonly annotations: Annotations;
}

/**
 * A tuple node — a fixed-arity, positionally-typed sequence, structurally like {@link ArrayNode} but a
 * distinct kind produced only by a schema-driven read. Mirrors `TsonTuple`.
 */
export interface TupleNode {
  readonly kind: 'tuple';
  readonly elements: readonly Value[];
  readonly typeRef?: string;
  readonly annotations: Annotations;
}

/**
 * The host value a resolved {@link AtomNode} holds — either a base-resolved value (§4: an untyped or
 * schemaless leaf) or a type narrowed by the built-in vocabulary (§5) or a schema. Mirrors the range of
 * objects the Java `TsonAtom.value()` accessor documents: "a base-resolved `BigInteger`/`BigDecimal`/
 * `Double`/`Boolean`/`String` for an untyped or schemaless leaf, or an atom-narrowed `UUID`/`LocalDate`/
 * `Integer`/… for a built-in- or schema-typed one".
 */
export type AtomValue =
  | bigint
  | number
  | string
  | boolean
  | Uint8Array
  | TsonDecimal
  | Rational
  | Complex
  | PlainDate
  | PlainTime
  | PlainDateTime
  | TsonDuration
  | Ipv4Address
  | Ipv6Address
  | Cidr
  | Uuid
  | MacAddress;

/**
 * A scalar leaf node holding a single resolved host value plus its optional type-ref — one node for
 * TSON's whole atom vocabulary (§5), not a class per atom type. Mirrors `TsonAtom`.
 *
 * The value is never absent — {@link AbsentNode} is the node for a position holding no value, exactly as
 * in Java (`TsonAtom`'s constructor rejects `null` "use TsonAbsent" instead).
 */
export interface AtomNode {
  readonly kind: 'atom';
  readonly value: AtomValue;
  readonly typeRef?: string;
  readonly annotations: Annotations;
}

/**
 * The absent sentinel as a node (§2.9) — a position that was written but holds no value, spelled `_` or,
 * equivalently, `null`. Distinct from {@link MissingNode} (no such node at all): this one was written.
 * Mirrors `TsonAbsent`.
 *
 * Also the placeholder a tree-mode reader leaves where a value failed to read in collecting mode — what
 * went wrong is carried by the diagnostic (`core/diagnostic.ts`), not by the node standing in for it.
 */
export interface AbsentNode {
  readonly kind: 'absent';
  readonly typeRef?: string;
  readonly annotations: Annotations;
}

/**
 * The result of navigating to something that isn't in the tree — a query artifact, not a real value, so
 * repeated navigation keeps returning it and a deep accessor chain never throws. Distinct from
 * {@link AbsentNode} (the sentinel `_`/`null`), which is a position the document actually wrote. Mirrors
 * `TsonMissing`.
 *
 * `path` is the RFC 6901 pointer of the step that failed, relative to the node navigation started from —
 * so a chain that comes back empty still says *where* it died. Once navigation has failed the path is
 * fixed: per `TsonMissing`'s own Javadoc, "every further `get`/`at` returns this same node rather than
 * extending it, because the first failure is the informative one" (a behaviour {@link At} below must
 * honour when implemented, not something this type enforces on its own).
 *
 * Has no `typeRef`/`annotations` — unlike every other member of {@link Value} — because it names a
 * failed step, not a value; Java's `TsonMissing` overrides both accessors to return empty for the same
 * reason.
 */
export interface MissingNode {
  readonly kind: 'missing';
  /** The RFC 6901 pointer of the step that failed to resolve. */
  readonly path: string;
}

// ---------------------------------------------------------------------------------------------
// The document wrapper
// ---------------------------------------------------------------------------------------------

/**
 * A whole data document as a tree: its header directives (§2.2) and the single value they govern.
 * Mirrors `TsonDocument`.
 *
 * **A header is a property of the document, not of the root value** — §2.2 states this outright
 * ("Header directives are properties of the document, not of the body's root value"), which is why this
 * is a wrapper around {@link Value} rather than two more fields on {@link RecordNode} and its siblings.
 *
 * **Only a data document is representable here.** A document carrying `!!meta` is a *schema* document,
 * whose value model is `schema/meta/*.ts`, not this one.
 *
 * Both `id` and `schema` are genuinely optional, and neither absence is an error: a bare value with no
 * header at all is an ordinary Class 1 document.
 */
export interface TsonDocument {
  /** The document's own identity (`!!id`), when declared. */
  readonly id?: string;
  /** The schema governing its value (`!!schema`), when declared. */
  readonly schema?: string;
  /** The document's single value — itself carrying any annotations/type-ref it was written with. */
  readonly root: Value;
}

// ---------------------------------------------------------------------------------------------
// Trivial constructors
// ---------------------------------------------------------------------------------------------

/** The bare absent node, carrying no type-ref or annotations. Mirrors `TsonAbsent.instance()`. */
export const ABSENT: AbsentNode = { kind: 'absent', annotations: EMPTY_ANNOTATIONS };

/** Constructs a {@link RecordNode}. Mirrors `TsonRecord.of`/its canonical constructor. */
export function recordNode(
  fields: ReadonlyMap<string, Value>,
  typeRef?: string,
  nodeAnnotations: Annotations = EMPTY_ANNOTATIONS,
): RecordNode {
  return {
    kind: 'record',
    fields,
    annotations: nodeAnnotations,
    ...(typeRef !== undefined ? { typeRef } : {}),
  };
}

/** Constructs a {@link MapNode}. Mirrors `TsonMap.of`/its canonical constructor. */
export function mapNode(
  entries: readonly MapEntry[],
  typeRef?: string,
  nodeAnnotations: Annotations = EMPTY_ANNOTATIONS,
): MapNode {
  return {
    kind: 'map',
    entries,
    annotations: nodeAnnotations,
    ...(typeRef !== undefined ? { typeRef } : {}),
  };
}

/** Constructs an {@link ArrayNode}. Mirrors `TsonArray.of`/its canonical constructor. */
export function arrayNode(
  elements: readonly Value[],
  typeRef?: string,
  nodeAnnotations: Annotations = EMPTY_ANNOTATIONS,
): ArrayNode {
  return {
    kind: 'array',
    elements,
    annotations: nodeAnnotations,
    ...(typeRef !== undefined ? { typeRef } : {}),
  };
}

/** Constructs a {@link TupleNode}. Mirrors `TsonTuple.of`/its canonical constructor. */
export function tupleNode(
  elements: readonly Value[],
  typeRef?: string,
  nodeAnnotations: Annotations = EMPTY_ANNOTATIONS,
): TupleNode {
  return {
    kind: 'tuple',
    elements,
    annotations: nodeAnnotations,
    ...(typeRef !== undefined ? { typeRef } : {}),
  };
}

/** Constructs an {@link AtomNode}. Mirrors `TsonAtom.of`/its canonical constructor. */
export function atomNode(
  value: AtomValue,
  typeRef?: string,
  nodeAnnotations: Annotations = EMPTY_ANNOTATIONS,
): AtomNode {
  return {
    kind: 'atom',
    value,
    annotations: nodeAnnotations,
    ...(typeRef !== undefined ? { typeRef } : {}),
  };
}

/** Constructs an {@link AbsentNode}; equivalent to {@link ABSENT} when called with no arguments. */
export function absentNode(
  typeRef?: string,
  nodeAnnotations: Annotations = EMPTY_ANNOTATIONS,
): AbsentNode {
  return {
    kind: 'absent',
    annotations: nodeAnnotations,
    ...(typeRef !== undefined ? { typeRef } : {}),
  };
}

/** Constructs a {@link MissingNode} carrying the RFC 6901 pointer at which navigation failed. */
export function missingNode(path: string): MissingNode {
  return { kind: 'missing', path };
}

/** Constructs a {@link TsonDocument}. Mirrors `TsonDocument.of`/its canonical constructor. */
export function tsonDocument(root: Value, id?: string, schema?: string): TsonDocument {
  return { root, ...(id !== undefined ? { id } : {}), ...(schema !== undefined ? { schema } : {}) };
}

// ---------------------------------------------------------------------------------------------
// Accessor signatures (declared only — implemented by a later work package, `tree/accessors.ts`)
// ---------------------------------------------------------------------------------------------

/**
 * One pointer step or field/entry lookup: the field/entry named `name` (record/map) or the element at
 * `index` (array/tuple), or a {@link MissingNode} pointing at that step. Never throws. Mirrors the two
 * `TsonValue.get` overloads.
 *
 * Signature only — implemented by `tree/accessors.ts`, not this file.
 */
export type Get = (node: Value, key: string | number) => Value;

/**
 * RFC 6901 JSON Pointer navigation from `node`: `""` is `node` itself, `"/a/b"` steps into fields/
 * indices, and any absent step yields a {@link MissingNode} carrying the pointer up to and including the
 * step that failed (not the whole pointer asked for). Mirrors `TsonValue.at`.
 *
 * Signature only — implemented by `tree/accessors.ts`, not this file.
 */
export type At = (node: Value, pointer: string) => Value;

/**
 * Casts (never converts) an {@link AtomNode}'s held value to `T` via a runtime type guard, mirroring the
 * Java family `TsonValue.as(Class<T>)`/`asString()`/`asBoolean()`/`asBigInteger()`/… (§5.2's "Host-value
 * entries … MUST preserve the parsed value's information content" is what makes a plain cast meaningful
 * here). Returns `undefined` when `node` is not an {@link AtomNode} or its value does not satisfy `guard`.
 *
 * Signature only — implemented by `tree/accessors.ts`, not this file.
 */
export type As = <T>(node: Value, guard: (value: unknown) => value is T) => T | undefined;

/** Casts to `string`. See {@link As}. */
export type AsString = (node: Value) => string | undefined;
/** Casts to `boolean`. See {@link As}. */
export type AsBoolean = (node: Value) => boolean | undefined;
/** Casts to the exact-decimal host type. See {@link As}. */
export type AsDecimal = (node: Value) => TsonDecimal | undefined;

/**
 * Converts (never casts) an {@link AtomNode}'s numeric value to a `number`, succeeding only when the
 * value is exactly representable — mirroring `TsonValue.asInt()`: "A fractional part that *is* integral
 * converts (`123.0` and `234.56E2` both give an `int`); a real one (`345.6`) does not. A magnitude
 * outside `int` range fails rather than saturating or wrapping."
 *
 * Signature only — implemented by `tree/accessors.ts`, not this file.
 */
export type AsInt = (node: Value) => number | undefined;

/** As {@link AsInt}, but converting to `bigint` with no range limit beyond exactness. Mirrors `asLong`. */
export type AsLong = (node: Value) => bigint | undefined;

/**
 * Converts an {@link AtomNode}'s numeric value to a finite `number`, rounding to the nearest
 * representable double — "that is what a binary floating-point accessor *means*" (`TsonValue.asDouble`'s
 * own Javadoc). An out-of-range magnitude yields `undefined` rather than `Infinity`.
 *
 * Signature only — implemented by `tree/accessors.ts`, not this file.
 */
export type AsDouble = (node: Value) => number | undefined;
