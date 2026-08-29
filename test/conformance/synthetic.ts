/**
 * RUNNER.md rule 6 (Class 2, not yet exercisable by any vector in this checkout — `class2/` is
 * absent — but stated correctly ahead of it): a resolved schema's synthetic entries carry a name
 * ending in an implementation-chosen content hash, which [TSON-SCHEMA] §8.2 keys identity on
 * *structure*, not on that spelling. Both sides of a comparison must therefore reduce a trailing
 * `_[0-9a-f]{8}` to a fixed placeholder before comparing — "a runner that compares the hashes is
 * testing its own hash function."
 */

const SYNTHETIC_HASH_SUFFIX = /_[0-9a-f]{8}$/;

/** The placeholder every normalized synthetic name ends in, replacing the implementation's own hash. */
export const SYNTHETIC_HASH_PLACEHOLDER = '_00000000';

/**
 * Reduces a trailing `_[0-9a-f]{8}` (an implementation-chosen content hash on a synthetic entry
 * name) to {@link SYNTHETIC_HASH_PLACEHOLDER}, leaving every other name — and any suffix that
 * merely *looks* like eight hex digits but isn't preceded by `_`, or is a different length —
 * untouched.
 */
export function normalizeSyntheticName(name: string): string {
  return SYNTHETIC_HASH_SUFFIX.test(name)
    ? name.slice(0, -SYNTHETIC_HASH_PLACEHOLDER.length) + SYNTHETIC_HASH_PLACEHOLDER
    : name;
}
