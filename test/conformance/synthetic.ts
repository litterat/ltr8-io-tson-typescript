/**
 * RUNNER.md rule 6, generalized: a resolved schema's synthetic entries and template
 * instantiations carry a name ending in an implementation-chosen content hash, which
 * [TSON-SCHEMA] §8.2 keys identity on *structure*, not on that spelling. Both sides of a
 * comparison must therefore reduce a trailing `_[0-9a-f]{8}` to a fixed placeholder before
 * comparing — "a runner that compares the hashes is testing its own hash function" — and rule 6
 * is explicit that this applies "wherever such a name appears — as an entry's own key, inside a
 * body, or in a list of names a sidecar states", not only where a name stands alone.
 *
 * {@link SYNTHETIC_HASH_PLACEHOLDER} is `_xxhash`, matching the literal placeholder the shared
 * corpus itself writes in a `class2/` vector's expected side (e.g.
 * `tests/class2/schema/valid/container-sugar-lifts-a-synthetic-expected.tn`'s
 * `array_text_xxhash`) — a vector author cannot know what hash an implementation under test would
 * actually mint, so the corpus states the placeholder directly rather than a real hash, and this
 * implementation's own minted names must reduce to the same spelling for the two sides to compare
 * equal. `"xxhash"` is not itself eight hex digits, so normalizing the corpus's own text a second
 * time is a no-op.
 */

const SYNTHETIC_HASH_SUFFIX = /_[0-9a-f]{8}$/;
const SYNTHETIC_HASH_ANYWHERE = /_[0-9a-f]{8}\b/g;

/** The placeholder every normalized synthetic name ends in, replacing the implementation's own hash. */
export const SYNTHETIC_HASH_PLACEHOLDER = '_xxhash';

/**
 * Reduces a trailing `_[0-9a-f]{8}` (an implementation-chosen content hash on a synthetic entry
 * name) to {@link SYNTHETIC_HASH_PLACEHOLDER}, leaving every other name — and any suffix that
 * merely *looks* like eight hex digits but isn't preceded by `_`, or is a different length —
 * untouched. For a whole name being compared on its own (an entry key, a name in a `binds`/
 * `subtypes` list).
 */
export function normalizeSyntheticName(name: string): string {
  return name.replace(SYNTHETIC_HASH_SUFFIX, SYNTHETIC_HASH_PLACEHOLDER);
}

/**
 * {@link normalizeSyntheticName}'s unanchored companion, for a whole rendered document or value
 * that may name a resolver-minted entry at any depth — as the type of a field, inside an argument
 * list — rather than only as the one name a caller already isolated. Every occurrence is reduced
 * independently, matching the Java reference implementation's own `SYNTHETIC_HASH_ANYWHERE`.
 */
export function normalizeSyntheticNamesAnywhere(text: string): string {
  return text.replace(SYNTHETIC_HASH_ANYWHERE, SYNTHETIC_HASH_PLACEHOLDER);
}
