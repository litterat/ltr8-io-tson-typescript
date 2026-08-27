/**
 * Type-level inference helpers layered on top of {@link Infer}/{@link Shape}/{@link InferShape}
 * (`bind/binding.ts`, frozen).
 *
 * `binding.ts` already carries the two shape-recovery helpers a *keyed* literal needs
 * ({@link Shape}, {@link InferShape} -- what {@link variant} infers a member union from). A
 * positional literal -- what {@link tuple} takes -- needs the analogous helper over a tuple type
 * rather than an object type, which is what this module adds. Kept as its own named type, not
 * inlined at the `tuple` call site, so the mapped-type shape has one place to read and cite
 * rather than being re-derived at each combinator that needs it.
 */
import type { BindingRef, Infer } from './binding.js';

/**
 * The host tuple type a positional literal of element bindings infers -- one property per
 * position, each recovered through {@link Infer} -- the positional counterpart to {@link
 * InferShape}. `tuple([intBinding, textBinding])` infers `InferTuple<[...]>` = `readonly [number,
 * string]`, which is exactly {@link TupleBinding}'s own host type parameter.
 */
export type InferTuple<E extends readonly BindingRef<unknown>[]> = {
  readonly [I in keyof E]: Infer<E[I]>;
};
