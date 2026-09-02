/**
 * The twelve combinators that author a {@link Binding} graph by hand -- what a Java `DataBinder`
 * derived by reflection, here written directly (see `binding.ts`'s own top comment for the full
 * rationale). `record`/`tuple`/`array`/`map`/`variant`/`bridge`/`lazy`/`field`/`optional`/
 * `annotated` live here; `registry`/`chain` live in `registry.ts` since they build a
 * {@link BindingRegistry} rather than a {@link Binding}.
 *
 * Every function below ends by asserting its return value against the `Binding` member it
 * builds. That assertion is deliberate, not a shortcut: {@link BindingBase}'s phantom `[OUT]` key
 * is declared with a `unique symbol` this module cannot name (see `binding.ts`'s own comment on
 * why), so no object literal built from the outside can *structurally* satisfy a `Binding<T>` --
 * these functions are the one place in the package licensed to assert past that on the strength
 * of having built the object honestly, field by field, immediately above the assertion.
 */
import type {
  AnnotatedBinding,
  ArrayBinding,
  ArrayOptions,
  BridgeBinding,
  Binding,
  BindingRef,
  FieldSlot,
  LazyBinding,
  MapBinding,
  MapOptions,
  RecordBinding,
  RecordOptions,
  Shape,
  TupleBinding,
  VariantBinding,
  VariantMember,
  InferShape,
} from './binding.js';
import type { Annotations } from '../annotations/index.js';
import type { InferTuple } from './infer.js';
import { TsonInternalError } from '../core/errors.js';

/** Build a {@link RecordBinding} from explicit fields -- see {@link field}/{@link optional} to build each one. */
export function record<T>(options: RecordOptions<T>): RecordBinding<T> {
  const byWireName = new Map<string, FieldSlot>();
  for (const slot of options.fields) {
    // Two exclusions, and the second is not redundant. `unbound` is the author's declaration that
    // a slot takes no wire value; excluding the annotations carrier BY IDENTITY as well is what
    // the frozen contract on RecordBinding.byWireName promises, and it holds whether or not the
    // author also remembered to mark the carrier unbound. The reference implementation excludes
    // it the same way, by identity against the carrier rather than by a flag.
    if (slot.unbound || slot === options.annotationsCarrier) continue;
    byWireName.set(slot.wireName, slot);
  }
  const binding = {
    kind: 'record',
    fields: options.fields,
    byWireName,
    mutable: options.mutable ?? false,
    construct: (slots: readonly unknown[]): T => options.construct(slots),
    ...(options.annotationsCarrier !== undefined
      ? { annotationsCarrier: options.annotationsCarrier }
      : {}),
    ...(options.create !== undefined ? { create: (): T => (options.create as () => T)() } : {}),
  };
  return binding as unknown as RecordBinding<T>;
}

/**
 * Build a {@link TupleBinding} from a positional literal of element bindings, inferring the tuple's
 * host type via a `const` type parameter -- `tuple([intBinding, textBinding])` infers
 * `TupleBinding<readonly [number, string]>` with no `as const` needed.
 */
export function tuple<const E extends readonly BindingRef<unknown>[]>(
  elements: E,
): TupleBinding<InferTuple<E>> {
  const slots = elements.map((binding, index) => ({
    index,
    binding,
    get(host: unknown): unknown {
      return (host as readonly unknown[])[index];
    },
  }));
  const binding = {
    kind: 'tuple',
    elements: slots,
    construct(values: readonly unknown[]): InferTuple<E> {
      return values as unknown as InferTuple<E>;
    },
  };
  return binding as unknown as TupleBinding<InferTuple<E>>;
}

/** Build an {@link ArrayBinding}. */
export function array<T, E>(options: ArrayOptions<T, E>): ArrayBinding<T> {
  const binding = {
    kind: 'array',
    element: options.element,
    construct: (values: readonly E[]): T => options.construct(values),
    read: (host: T): Iterable<E> => options.read(host),
  };
  return binding as unknown as ArrayBinding<T>;
}

/** Build a {@link MapBinding}. */
export function map<T, K, V>(options: MapOptions<T, K, V>): MapBinding<T> {
  const binding = {
    kind: 'map',
    key: options.key,
    value: options.value,
    construct: (entries: readonly (readonly [K, V])[]): T => options.construct(entries),
    read: (host: T): Iterable<readonly [K, V]> => options.read(host),
  };
  return binding as unknown as MapBinding<T>;
}

/**
 * Build a {@link VariantBinding} from a shape literal of members keyed by wire type name, inferring
 * the host union type via a `const` type parameter. Pass `discriminant` for a shared tag property;
 * omit it to fall back to each member's own `test` (built alongside its binding by a caller that
 * needs one -- this signature only fixes the member shape's keys, not per-member recognition, which
 * a later work package's implementation composes from the shape and any per-member options passed
 * alongside it).
 */
export function variant<const M extends Shape>(
  members: M,
  discriminant?: PropertyKey,
): VariantBinding<InferShape<M>[keyof M]> {
  const memberList: VariantMember[] = Object.entries(members).map(([wireName, binding]) => ({
    wireName,
    binding,
  }));
  const byDiscriminant =
    discriminant === undefined
      ? undefined
      : new Map(memberList.map((member) => [member.wireName, member]));

  function memberFor(value: unknown): VariantMember | undefined {
    if (discriminant !== undefined && byDiscriminant !== undefined) {
      if (typeof value !== 'object' || value === null) return undefined;
      const tag = (value as Record<PropertyKey, unknown>)[discriminant];
      return typeof tag === 'string' ? byDiscriminant.get(tag) : undefined;
    }
    return memberList.find((member) => member.test?.(value) === true);
  }

  const binding = {
    kind: 'variant',
    members: memberList,
    sealed: true,
    memberFor,
    ...(discriminant !== undefined ? { discriminant } : {}),
  };
  return binding as unknown as VariantBinding<InferShape<M>[keyof M]>;
}

/** Build a {@link BridgeBinding} converting between a host type `T` and a wire-shaped `D` bound by `wire`. */
export function bridge<T, D>(
  wire: BindingRef<D>,
  toWire: (value: T) => D,
  fromWire: (wire: D) => T,
): BridgeBinding<T, D> {
  const binding = { kind: 'bridge', wire, toWire, fromWire };
  return binding as unknown as BridgeBinding<T, D>;
}

/**
 * Build an {@link AnnotatedBinding} for a position declared `Annotated<T>` -- the value's own
 * `value` binding, plus the three closures a reader/writer needs to move between the host box `T`
 * and the wire-format annotations framing that position (§3.1). `construct`/`unwrap` are the
 * read/write inverses over the inner value, `annotationsOf` the write-direction counterpart to
 * what a reader hands `construct` as its own second argument.
 */
export function annotated<T>(options: {
  readonly value: BindingRef<unknown>;
  readonly construct: (value: unknown, annotations: Annotations) => T;
  readonly unwrap: (host: T) => unknown;
  readonly annotationsOf: (host: T) => Annotations;
}): AnnotatedBinding<T> {
  const binding = {
    kind: 'annotated',
    value: options.value,
    construct: options.construct,
    unwrap: options.unwrap,
    annotationsOf: options.annotationsOf,
  };
  return binding as unknown as AnnotatedBinding<T>;
}

/**
 * Defer a binding until first use, closing a declaration-order cycle -- see {@link LazyBinding}'s
 * own doc for what this ports and why it is the only survivor of Java's cycle machinery.
 *
 * ### The ergonomics cliff
 *
 * A self-referential binding cannot be written as a single flat `const`, because TypeScript must
 * finish inferring an expression's type before that expression can refer to the variable it is
 * being assigned to:
 *
 * ```ts
 * // Does NOT typecheck:
 * const nodeBinding = record({
 *   fields: [
 *     field<Node, 'value'>(0, 'value', 'value', valueBinding),
 *     field<Node, 'next'>(1, 'next', 'next', lazy(() => nodeBinding)),
 *   ],
 *   construct: ([value, next]) => ({ value, next }) as Node,
 * });
 * // error TS7022: 'nodeBinding' implicitly has type 'any' because it is referenced
 * // directly or indirectly in its own initializer.
 * ```
 *
 * The fix is to give the binding an explicit type -- an interface plus a `: Binding<X>` (or
 * `: RecordBinding<X>`, etc.) annotation on the `const` -- *before* the initializer runs, so the
 * reference inside `lazy(() => nodeBinding)` resolves against a type already fully known rather
 * than one still being inferred:
 *
 * ```ts
 * interface NodeBinding extends RecordBinding<Node> {}
 *
 * const nodeBinding: NodeBinding = record({
 *   fields: [
 *     field<Node, 'value'>(0, 'value', 'value', valueBinding),
 *     field<Node, 'next'>(1, 'next', 'next', lazy((): Binding<Node> => nodeBinding)),
 *   ],
 *   construct: ([value, next]) => ({ value, next }) as Node,
 * });
 * ```
 *
 * This is the one authoring cost of deleting Java's reflection-driven cycle detection: Java
 * discovered the cycle at runtime, from a class graph that already fully existed; here the author
 * states it, once, at the one declaration that closes it.
 */
export function lazy<T>(resolve: () => Binding<T>): LazyBinding<T> {
  let cached: Binding<T> | undefined;
  const binding = {
    kind: 'lazy',
    get(): Binding<T> {
      cached ??= resolve();
      return cached;
    },
    peek(): Binding<T> | undefined {
      return cached;
    },
  };
  return binding as unknown as LazyBinding<T>;
}

/**
 * Build a required {@link FieldSlot} reading/writing host property `key` directly -- `wireName` is
 * matched against the wire data (after any rename), `key` is the host property, and `index` is the
 * construction slot {@link RecordBinding.construct} expects this value at.
 */
export function field<Host, K extends keyof Host & string>(
  index: number,
  wireName: string,
  key: K,
  binding: BindingRef<Host[K]>,
): FieldSlot<Host[K]> {
  return {
    index,
    wireName,
    key,
    required: true,
    unbound: false,
    binding,
    isPresent(): boolean {
      return true;
    },
    get(host: unknown): Host[K] {
      return (host as Record<K, Host[K]>)[key];
    },
    set(host: unknown, value: Host[K]): void {
      (host as Record<K, Host[K]>)[key] = value;
    },
  };
}

/**
 * {@link field}'s optional counterpart: `required` is `false`, and presence is derived from
 * `host[key]` being non-`null`/non-`undefined` -- the host-side analogue of `DataClassField`'s own
 * note that an optional field's accessor proxies through the host's own `Optional`/nullable slot
 * rather than this descriptor layer inventing a second notion of absence.
 */
export function optional<Host, K extends keyof Host & string>(
  index: number,
  wireName: string,
  key: K,
  binding: BindingRef<NonNullable<Host[K]>>,
): FieldSlot<NonNullable<Host[K]>> {
  return {
    index,
    wireName,
    key,
    required: false,
    unbound: false,
    binding,
    isPresent(host: unknown): boolean {
      const value = (host as Record<K, Host[K]>)[key];
      return value !== null && value !== undefined;
    },
    get(host: unknown): NonNullable<Host[K]> {
      const value = (host as Record<K, Host[K]>)[key];
      if (value === null || value === undefined) {
        throw new TsonInternalError('optional field slot read without checking isPresent first');
      }
      return value;
    },
    set(host: unknown, value: NonNullable<Host[K]>): void {
      (host as Record<K, Host[K]>)[key] = value;
    },
  };
}
