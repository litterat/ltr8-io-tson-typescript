/**
 * The binding layer: authored descriptors carrying inferred static types.
 *
 * Published as `@ltr8/tson/bind`. A `Binding` is what the Java reference derives by reflection;
 * here it is a value, and the combinators re-exported from `combinators.ts`/`registry.ts` are the
 * whole mechanism -- there is no class analysis anywhere. `binding.ts` declares the `Binding`
 * union and its options types only and emits no JavaScript itself, which is why every runtime
 * export below lives in a sibling module: re-exporting both here is what makes them resolvable
 * from one subpath with no name collision, since `binding.ts` no longer declares the combinator
 * names it merely documents.
 */
export * from './binding.js';
export * from './combinators.js';
export * from './infer.js';
export * from './registry.js';
export * from './encode.js';
export * from './decode.js';
export * from './strictness.js';
