/**
 * The binding layer: authored descriptors carrying inferred static types.
 *
 * Published as `@ltr8/tson/bind`. A `Binding` is what the Java reference derives by reflection;
 * here it is a value, which is why the combinators below are the whole mechanism and there is no
 * class analysis anywhere.
 */
export * from './binding.js';
