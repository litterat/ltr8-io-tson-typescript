/**
 * The binding descriptor model -- what a TSON reader/writer consumes instead of reflecting over a
 * host type (PORT-PLAN.md, architectural decision 2).
 *
 * Java's `tson-bind` is a *descriptor factory*: `DefaultRecordBinder` reflects over a `Class<?>`
 * and derives a `DataClass` tree of `MethodHandle`s once, at startup, so every later read/write
 * consumes descriptors and never touches reflection again. TypeScript has no runtime reflection
 * to derive from, so nothing here is derived -- a {@link Binding} is **authored**, directly, by
 * calling the combinators declared (not implemented) at the bottom of this file. A `MethodHandle`
 * becomes a plain closure the author writes by hand.
 *
 * Authoring rather than deriving deletes, wholesale:
 *  - `DefaultRecordBinder`'s 1158 LOC of `MethodHandle`-producing reflection;
 *  - the three component finders (record/tuple/union component discovery over a `Class<?>`);
 *  - `DataBindContext`'s in-flight-resolution / cycle-detection apparatus, needed only because
 *    reflection discovers a (possibly cyclic) class graph bottom-up and must not re-enter a
 *    descriptor still being built.
 *
 * What survives is `Memoized` -> {@link LazyBinding}/{@link BindingRef}, because *authoring* a
 * self-referential binding still has to close one cycle: a binding that refers to itself, directly
 * or through a field/element/entry, cannot supply the `Binding` it refers to before that `Binding`
 * exists. See {@link LazyBinding}'s own doc for the one place this still bites.
 *
 * `@Profile` has no counterpart here, and is not ported: Java needed it because one Java class can
 * carry only one binding, so a second interpretation of the same class required a side channel to
 * pick between them. A TypeScript {@link Binding} is a plain value, not an annotation on a class --
 * a second interpretation is simply a second value. See {@link BindingRegistry.profile} for the one
 * place a profile-like label still shows up, purely as an author-facing name with no runtime effect.
 */

import type { Annotations } from '../annotations/index.js';

// ---------------------------------------------------------------------------------------------
// Phantom output type
// ---------------------------------------------------------------------------------------------

/**
 * The key every {@link Binding} carries its phantom output type at.
 *
 * Not exported: the only sanctioned way to read what a `Binding` produces is {@link Infer}, and
 * the only sanctioned way to acquire a value typed at this key is one of the combinators below.
 * Keeping the key itself private is what stops a caller from satisfying `BindingBase<T>`
 * structurally by hand with the wrong `T`.
 */
declare const OUT: unique symbol;

/**
 * The type every member of the {@link Binding} union carries in common: nothing at runtime, and a
 * phantom `T` at compile time for {@link Infer} to recover.
 *
 * `T` never appears in an actual property value -- `OUT` is declared with `declare const`, so it
 * emits no JavaScript at all. It exists purely so `Binding<T>`'s structural shape pins down `T`
 * precisely enough for {@link Infer} to extract it, the same role Java's `DataClass<T>`'s type
 * parameter plays by being a generic class rather than a raw interface.
 */
export interface BindingBase<T> {
  readonly [OUT]: T;
}

/**
 * Recovers the host type a {@link Binding} produces and consumes.
 *
 * @example
 * ```ts
 * declare const personBinding: Binding<Person>;
 * type P = Infer<typeof personBinding>; // Person
 * ```
 */
export type Infer<B> = B extends { readonly [OUT]: infer T } ? T : never;

// ---------------------------------------------------------------------------------------------
// Reference cells that can close a declaration-order cycle
// ---------------------------------------------------------------------------------------------

/**
 * A `Binding<T>` position that may not be resolvable yet, because it sits on the one cycle
 * authoring can still produce: a binding that reaches back to itself -- directly, or through a
 * field, array/map/tuple element, or variant member -- before its own declaration has finished
 * evaluating.
 *
 * This is the TypeScript port of `Memoized<DataClass>` (`tson-bind/internal/Memoized.java`), and
 * the *only* survivor of the Java implementation's cycle machinery (see this file's own top
 * comment for what else that machinery included and why none of it is needed here). Java needed a
 * whole in-flight-resolution apparatus because every `DataClass` was *discovered* bottom-up from
 * reflection over a class graph that could itself be cyclic; here the only remaining cycle is the
 * mundane one every recursive value has always had in a `const`-initialized language -- a binding
 * that refers to itself before its own `const` has finished being assigned.
 *
 * `LazyBinding<T>` is a member of the {@link Binding} union in its own right (`kind: 'lazy'`)
 * rather than a wrapper type held *beside* it, so every position that must tolerate "a binding, or
 * a not-yet-resolved reference to one" can simply be typed `Binding<T>` -- see {@link BindingRef},
 * which is exactly that.
 *
 * {@link get} resolves and memoises the thunk on first call, exactly like `Memoized.get()`.
 * {@link peek} mirrors `Memoized.peek()` precisely: it **must never force** resolution, because a
 * diagnostic or a `toString` that walks a binding graph to describe it must not itself trigger the
 * resolution it is only trying to describe -- the same trap `DataClass.shown`'s `toString` guard
 * exists to avoid in Java.
 */
export interface LazyBinding<T> extends BindingBase<T> {
  readonly kind: 'lazy';
  /** Resolve the referenced binding, computing and caching it on first call. */
  get(): Binding<T>;
  /** The resolved binding if {@link get} has already been called, else `undefined`. Never forces resolution. */
  peek(): Binding<T> | undefined;
}

/**
 * The type used at every position a binding graph can close a cycle through -- a record field
 * ({@link FieldSlot.binding}), an array/map/tuple element, a variant member.
 *
 * Identical to {@link Binding}, since {@link LazyBinding} already lives inside that union; this is
 * a separate name only to document, at each of those positions, *why* a `'lazy'` member is
 * expected there specifically and not merely tolerated as a side effect of `Binding`'s own shape.
 */
export type BindingRef<T> = Binding<T>;

// ---------------------------------------------------------------------------------------------
// Atom
// ---------------------------------------------------------------------------------------------

/**
 * The binding for a position whose value is a built-in vocabulary atom (§5) -- the port of
 * `DataClassAtom`.
 *
 * Deliberately inert: Java's `DataClassAtom` carries no parsing logic either (it is `typeClass` +
 * an optional bridge, nothing more) -- "an Atom uses identity function for toData/toObject and
 * construct", per its own comment. The actual token-level parsing contract is {@link
 * AtomType} (`atom/contract.ts`), and the association between a schema-declared atom type name and
 * its `AtomType` implementation is made by a `reader/`-layer registry, not by this binding --
 * exactly where Java makes it, via `ValueReaderFactoryRegistry` keyed by constructor name. Keeping
 * that association out of `AtomBinding` is what keeps `bind/` from having to depend on `atom/` at
 * all.
 */
export interface AtomBinding<T> extends BindingBase<T> {
  readonly kind: 'atom';
  /**
   * The built-in vocabulary type name this position's value is expected to parse/write as (e.g.
   * `"int32"`, `"uuid"`, `"date"`) -- a label a reader resolves against its own atom-type registry,
   * not a reference this binding holds directly.
   */
  readonly wireType: string;
}

// ---------------------------------------------------------------------------------------------
// Record
// ---------------------------------------------------------------------------------------------

/**
 * One construction slot of a {@link RecordBinding} -- the port of `DataClassField`.
 *
 * `index`/`wireName`/`key` are three separate identities that coincide in the common case but need
 * not: `index` is where this value goes when {@link RecordBinding.construct} is called (constructor
 * argument order), `wireName` is the name matched against the data (after any schema-level rename),
 * and `key` is the host property this slot reads/writes through -- a rename, or a host shape whose
 * property names simply differ from the wire's, is exactly the case these three diverge.
 *
 * `isPresent`/`get`/`set` all take `host: unknown` rather than a typed host parameter, mirroring
 * `DataClassField`'s own `Object`-typed `MethodHandle`s exactly: this slot alone has no way to name
 * the enclosing record's own host type (only {@link RecordBinding} does), so the closures an author
 * supplies must already know it from their own authoring context. {@link field}/{@link optional}
 * exist so an author writes those closures once, typed against a real `Host`, rather than by hand
 * against `unknown` every time.
 */
export interface FieldSlot<T = unknown> {
  readonly index: number;
  /** The field name matched against the wire data, after any schema-level rename. */
  readonly wireName: string;
  /** The host property this slot reads/writes through. */
  readonly key: PropertyKey;
  readonly required: boolean;
  /**
   * True when this slot occupies a construction index but is never matched against the wire by
   * name -- generalising `DataClassRecord.annotationsCarrier()`'s one hardcoded exemption to any
   * slot an author wants excluded from wire matching (a value supplied from the read/write
   * environment rather than the document itself, e.g. an annotations carrier -- see {@link
   * RecordBinding.annotationsCarrier} -- or a context-injected value). An unbound slot is excluded
   * from {@link RecordBinding.byWireName} and from the record's own "closed under its type" field
   * enumeration.
   */
  readonly unbound: boolean;
  readonly binding: BindingRef<T>;
  isPresent(host: unknown): boolean;
  get(host: unknown): T;
  /** Present only for a slot on a {@link RecordBinding.mutable} shape. */
  set?(host: unknown, value: T): void;
}

/**
 * The binding for a record-shaped value -- the port of `DataClassRecord`.
 *
 * `fields` is ordered by {@link FieldSlot.index}, the order {@link construct} expects its `slots`
 * argument in; `byWireName` is the same fields keyed for matching against data, and excludes
 * {@link annotationsCarrier} (which, per {@link FieldSlot.unbound}, is never matched by name at
 * all) -- port of `DataClassRecord.fields()` and the wire-name lookup a compiled reader builds over
 * it. `annotationsCarrier` is the port of `DataClassRecord.annotationsCarrier()`: the one field, if
 * any, that receives this record's own TSON wire-format annotations rather than an authored wire
 * value. It still occupies a slot in `fields` (a real construction argument has to be filled), but
 * is excluded from `byWireName` -- at most one per record; a second is an authoring error, not
 * something this type can prevent structurally.
 *
 * `mutable`/`create`/`construct` port `DataClassRecord.isMutable()`/`creator()`/`constructor()`: an
 * immutable shape supplies every field at once through `construct`, while a mutable one calls
 * `create()` for an empty instance and then each field's own {@link FieldSlot.set} in turn.
 */
export interface RecordBinding<T> extends BindingBase<T> {
  readonly kind: 'record';
  readonly fields: readonly FieldSlot[];
  readonly byWireName: ReadonlyMap<string, FieldSlot>;
  readonly annotationsCarrier?: FieldSlot<Annotations>;
  readonly mutable: boolean;
  /** Present only when {@link mutable} is `true`. */
  create?(): T;
  /** Build the record from its construction slots, one value per {@link FieldSlot.index} (0-based, contiguous). */
  construct(slots: readonly unknown[]): T;
}

// ---------------------------------------------------------------------------------------------
// Tuple
// ---------------------------------------------------------------------------------------------

/**
 * One positional slot of a {@link TupleBinding} -- the port of `DataClassElement`, `DataClassTuple`'s
 * tuple-specific analogue of {@link FieldSlot}. Pared down the same way its Java original is: no
 * name (positional, not named), no `required`/`isPresent`/`set` -- a tuple slot is always present
 * and a tuple is rebuilt whole via {@link TupleBinding.construct}, never filled one slot at a time.
 */
export interface ElementSlot<T = unknown> {
  readonly index: number;
  readonly binding: BindingRef<T>;
  get(host: unknown): T;
}

/**
 * The binding for a fixed-arity, positionally-accessed product -- the port of `DataClassTuple`.
 *
 * Java's original has no `size()`/iterator MethodHandles the way {@link ArrayBinding} does: arity
 * is fixed at authoring time (`elements.length`), not runtime state to query, and reading is a
 * plain per-slot {@link ElementSlot.get} rather than a combined dispatch point -- each slot has its
 * own type, so there is nothing to gain by forcing them through one shared accessor the way a
 * single homogeneous element type lets {@link ArrayBinding} do.
 */
export interface TupleBinding<T> extends BindingBase<T> {
  readonly kind: 'tuple';
  readonly elements: readonly ElementSlot[];
  /** Build the tuple from its positional values, in {@link ElementSlot.index} order. */
  construct(values: readonly unknown[]): T;
}

// ---------------------------------------------------------------------------------------------
// Array
// ---------------------------------------------------------------------------------------------

/**
 * The binding for a sequential, homogeneous collection -- the port of `DataClassArray`.
 *
 * Java's original needs five separate `MethodHandle`s (`constructor`/`size`/`iterator`/`get`/`put`)
 * because a single `MethodHandle` invocation handles one call at a time, and Java has no
 * reflection-free way to hand back "every value" of an arbitrary host collection type at once. A TS
 * closure has no such restriction, so the whole protocol collapses to two: {@link construct} takes
 * every element value at once (replacing `constructor` + a `put` loop) and {@link read} hands back
 * every element at once as an `Iterable` (replacing `size` + `iterator` + a `get` loop).
 */
export interface ArrayBinding<T> extends BindingBase<T> {
  readonly kind: 'array';
  readonly element: BindingRef<unknown>;
  /** Build a host array/collection from its element values, in order. */
  construct(values: readonly unknown[]): T;
  /** Read a host value back out as an ordered sequence of element values, for writing/traversal. */
  read(host: T): Iterable<unknown>;
}

// ---------------------------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------------------------

/**
 * The binding for a keyed collection -- the port of `DataClassMap`.
 *
 * Collapses Java's six `MethodHandle`s (`constructor`/`size`/`iterator`/`next`/`key`/`value`/`put`
 * -- a two-stage `next(iter):entry` then `key(entry)`/`value(entry)`, because a map entry needs two
 * values off one iteration step) to the same two-closure shape {@link ArrayBinding} uses: {@link
 * construct} takes every entry at once, {@link read} hands every entry back at once as an
 * `Iterable` of key/value pairs.
 */
export interface MapBinding<T> extends BindingBase<T> {
  readonly kind: 'map';
  readonly key: BindingRef<unknown>;
  readonly value: BindingRef<unknown>;
  /** Build a host map from its entries. */
  construct(entries: readonly (readonly [unknown, unknown])[]): T;
  /** Read a host value back out as its entries, for writing/traversal. */
  read(host: T): Iterable<readonly [unknown, unknown]>;
}

// ---------------------------------------------------------------------------------------------
// Variant
// ---------------------------------------------------------------------------------------------

/**
 * One member of a {@link VariantBinding}.
 *
 * `test` is consulted only when the enclosing {@link VariantBinding.discriminant} is absent -- see
 * that field's own doc for when each applies.
 */
export interface VariantMember<T = unknown> {
  /** The schema type name this member reads/writes as -- what a wire type-ref names. */
  readonly wireName: string;
  readonly binding: BindingRef<T>;
  /** Recognises a host value as this member for writing. Ignored when {@link VariantBinding.discriminant} is set. */
  readonly test?: (value: unknown) => boolean;
}

/**
 * The binding for a tagged union / sealed hierarchy -- the port of `DataClassUnion`.
 *
 * **Read direction is not this binding's concern.** A wire value's own `!type-ref` (or the
 * schema's own `disjoint` classification for an untagged value -- `DiscriminationClass.java`)
 * already says which member is present; a reader resolves that member's own {@link
 * Binding} by `wireName` the same way any other named schema entry resolves, through a {@link
 * BindingRegistry}. Nothing here needs porting for that direction at all.
 *
 * **Write direction has no structural analogue and must be declared.** Java's
 * `DataClassUnion.isMemberType(value.getClass())` asks the JVM which concrete class a value is;
 * TypeScript's structural typing means two unrelated shapes can satisfy the same interface; there
 * is no runtime "which member is this" question a TS union answers for free. An author must say
 * how to tell members apart on the way out, one of two ways:
 *  - {@link discriminant}: a property key shared by every member's host shape whose value picks
 *    the member -- the common case, a `kind`/`type` tag -- checked structurally, no member `test`
 *    needed.
 *  - each member's own {@link VariantMember.test}, for an untagged union recovered by shape alone.
 *
 * `sealed` ports `DataClassUnion.isSealed()`; `addMember` ports `addMemberType` for the open case --
 * present only on an open (`sealed: false`) variant, absent on a sealed one, where an attempt to
 * add a member has nowhere structural to go (Java throws `DataBindException`; here the capability
 * simply isn't offered).
 */
export interface VariantBinding<T> extends BindingBase<T> {
  readonly kind: 'variant';
  readonly members: readonly VariantMember[];
  readonly sealed: boolean;
  /** A shared tag property picking the member, when members are told apart that way rather than by {@link VariantMember.test}. */
  readonly discriminant?: PropertyKey;
  /** Which member a host value belongs to, for writing. `undefined` is a write error: the value matches no member. */
  memberFor(value: unknown): VariantMember | undefined;
  /** Register another implementation at runtime. Present only on an open ({@link sealed} `false`) variant. */
  addMember?(member: VariantMember): void;
}

// ---------------------------------------------------------------------------------------------
// Annotated
// ---------------------------------------------------------------------------------------------

/**
 * The binding for a position declared `Annotated<T>` -- the value's own binding, plus the
 * knowledge that a reader must hand back the value *and* the wire-format annotations written at
 * that position together. Port of `DataClassAnnotated`.
 *
 * Modelled as its own {@link Binding} member, exactly as `DataClassAnnotated` is modelled as its
 * own `DataClass`, rather than as a flag on {@link FieldSlot}/{@link ElementSlot}/etc., so that
 * every position which resolves a child binding -- a record field, an array element, a tuple slot,
 * either side of a map entry -- gets annotation-wrapping the same way, by simply resolving to an
 * `AnnotatedBinding` there instead of needing a flag of its own at each of those position types.
 *
 * Adds no wire encoding of its own: the annotations are framing around the value (§3.1's
 * `*annotation [type-ref] core-value`), not part of the value's own representation, exactly as
 * `DataClassAnnotated`'s own doc states.
 */
export interface AnnotatedBinding<T> extends BindingBase<T> {
  readonly kind: 'annotated';
  /** The binding for the value carried inside this position's annotation box. */
  readonly value: BindingRef<unknown>;
  /** Build the host box from a value and the annotations written at this position. */
  construct(value: unknown, annotations: Annotations): T;
  /** The value inside the box. */
  unwrap(host: T): unknown;
  /** The annotations written at this position. */
  annotationsOf(host: T): Annotations;
}

// ---------------------------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------------------------

/**
 * The binding that converts between a host type `T` and a separately-bound wire-shaped type `D` --
 * the port of `DataClassBridge`, promoted from a field every other `DataClass` constructor
 * optionally carried to a `Binding` kind in its own right. Any other binding kind can sit behind
 * one: a `BridgeBinding<Date, string>` might wrap an {@link AtomBinding}, or a
 * `BridgeBinding<Map<string, Order>, Order[]>` might wrap an {@link ArrayBinding} keyed by one of
 * `Order`'s own fields after the fact.
 *
 * `toWire`/`fromWire` are `DataClassBridge.toData()`/`toObject()` renamed for this file's own
 * data/wire vocabulary; each is `MethodHandle` turned into a plain closure, per this file's own
 * top comment.
 */
export interface BridgeBinding<T, D = unknown> extends BindingBase<T> {
  readonly kind: 'bridge';
  /** The binding for the wire-shaped value this bridges through. */
  readonly wire: BindingRef<D>;
  /** Host value -> wire shape, for writing. */
  toWire(value: T): D;
  /** Wire shape -> host value, for reading. */
  fromWire(wire: D): T;
}

// ---------------------------------------------------------------------------------------------
// The union
// ---------------------------------------------------------------------------------------------

/**
 * A descriptor a reader/writer consumes for one position in a bound value graph -- the TypeScript
 * port of the `DataClass` hierarchy (`tson-bind`), authored rather than derived; see this file's
 * own top comment.
 *
 * `kind` is the discriminant every consumer switches on. Every member is generic in the same host
 * type `T` {@link Infer} recovers, so `Binding<T>` itself, not a subtype, is what a combinator
 * returns and what a {@link BindingRegistry} hands back.
 */
export type Binding<T> =
  | AtomBinding<T>
  | RecordBinding<T>
  | TupleBinding<T>
  | ArrayBinding<T>
  | MapBinding<T>
  | VariantBinding<T>
  | AnnotatedBinding<T>
  | BridgeBinding<T>
  | LazyBinding<T>;

// ---------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------

/**
 * Resolves a schema type name to the {@link Binding} an author registered for it -- the port of
 * `DataNameBinder`, which resolved a schema/wire type name to a Java `Class<?>` for `DataBindContext`
 * to derive a descriptor from by reflection. There is nothing left to derive here, so this seam
 * resolves straight to the authored `Binding` itself.
 *
 * Kept as a one-method function seam, exactly as `DataNameBinder` is a one-method functional
 * interface, so the extension point Java's `DataBindContext.Builder#nameBinder` gave a caller with
 * its own naming convention survives: {@link registry}/{@link chain} are two ways to build one, but
 * any object shaped like this interface works.
 *
 * `profile` is the one trace of `@Profile` left in this port -- a label distinguishing one registry
 * from another built against the same schema for a different purpose (see this file's own top
 * comment for why `@Profile` itself has no counterpart). It is never consulted by anything in this
 * module; it exists purely for a caller's own bookkeeping (e.g. choosing which registry to pass to
 * a reader) and diagnostics.
 */
export interface BindingRegistry {
  /** The `Binding` registered for `schemaTypeName`, or `undefined` when none is -- a missing binding is deferred to first read (`TsonMissingBindingError`), never raised here. */
  get(schemaTypeName: string): Binding<unknown> | undefined;
  readonly profile?: string;
}

// ---------------------------------------------------------------------------------------------
// Combinators -- signatures only; implemented by a later work package.
// ---------------------------------------------------------------------------------------------

/**
 * A shape literal as authored directly at a {@link tuple}/{@link variant} call site: bindings keyed
 * by position or member name. A `const` type parameter (`<const S extends Shape>`) on those
 * combinators lets the host type be inferred from the literal precisely, with no `as const` needed
 * at the call site -- TypeScript 5's const type parameters exist for exactly this shape of API.
 *
 * {@link record} deliberately does *not* take a bare `Shape` this way: a record field carries
 * metadata a flat `{ key: binding }` literal cannot -- a rename (`wireName` diverging from `key`),
 * `required`/`unbound`, mutability, an annotations carrier -- so its fields are built explicitly via
 * {@link field}/{@link optional} instead, each already fully typed.
 */
export type Shape = Readonly<Record<string, BindingRef<unknown>>>;

/** The host object type a {@link Shape} infers: one property per key, each inferred through {@link Infer}. */
export type InferShape<S extends Shape> = { readonly [K in keyof S]: Infer<S[K]> };

/** {@link record}'s parameter shape -- everything {@link RecordBinding} needs beyond its own `kind`. */
export interface RecordOptions<T> {
  readonly fields: readonly FieldSlot[];
  readonly annotationsCarrier?: FieldSlot<Annotations>;
  readonly mutable?: boolean;
  create?(): T;
  construct(slots: readonly unknown[]): T;
}

/** Build a {@link RecordBinding} from explicit fields -- see {@link field}/{@link optional} to build each one. */

/** {@link array}'s parameter shape -- everything {@link ArrayBinding} needs beyond its own `kind`. */
export interface ArrayOptions<T, E> {
  readonly element: BindingRef<E>;
  construct(values: readonly E[]): T;
  read(host: T): Iterable<E>;
}

/** Build an {@link ArrayBinding}. */

/** {@link map}'s parameter shape -- everything {@link MapBinding} needs beyond its own `kind`. */
export interface MapOptions<T, K, V> {
  readonly key: BindingRef<K>;
  readonly value: BindingRef<V>;
  construct(entries: readonly (readonly [K, V])[]): T;
  read(host: T): Iterable<readonly [K, V]>;
}

/** Build a {@link MapBinding}. */

/** Build a {@link BridgeBinding} converting between a host type `T` and a wire-shaped `D` bound by `wire`. */

/** Build a {@link BindingRegistry} from a fixed table of bindings keyed by schema type name. */
