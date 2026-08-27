/**
 * The resolved-schema value model — the §8 resolver output.
 *
 * Published as `@ltr8/tson/schema`. It names no compiler type, so a consumer can hold and inspect
 * a resolved schema without the resolver, linker or compiler reaching their bundle.
 */
export * from './meta/typedef.js';
export * from './meta/bodies.js';
export * from './meta/algebra.js';
export * from './meta/atoms-numeric.js';
export * from './meta/atoms-text.js';
export * from './meta/atoms-temporal.js';
export * from './meta/atoms-network.js';
export * from './meta/position.js';
