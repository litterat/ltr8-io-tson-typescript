/**
 * Which variant of a choice each `$type` selects ([TSON-SCHEMA] §5.4, [TSON-JSON] §8.1): a name meaning
 * a variant selects it, before any variant it only IS-A; a name IS-A exactly one variant and meaning
 * none selects that one; a name IS-A more than one and meaning none selects none.
 *
 * One tally, handed what the namespace says a variant's names and subtypes are, so the rule is read
 * once here and the reader built from it asks a table.
 */

/** What a choice's `$type` selects. */
export interface ChoiceSelection {
  /** Each name a tag may carry, to the variant it selects. */
  readonly selects: ReadonlyMap<string, string>;
  /** The names of {@link selects} meaning their variant (itself or an alias of it), rather than IS-A it. */
  readonly named: ReadonlySet<string>;
  /** Each name IS-A more than one variant and meaning none, to those variants' names: it selects none. */
  readonly selectsNone: ReadonlyMap<string, readonly string[]>;
}

/**
 * The selection over `variants`, a choice's named variants (a variant written in place is named by no
 * tag and is left out). `naming(variant)` gives the names meaning the variant past its alias chain, and
 * `subtypes(variant)` the names of the entries IS-A it.
 */
export function selectChoice(
  variants: readonly string[],
  naming: (variant: string) => Iterable<string>,
  subtypes: (variant: string) => Iterable<string>,
): ChoiceSelection {
  const selects = new Map<string, string>();
  for (const variant of variants) selects.set(variant, variant);
  for (const variant of variants) {
    for (const written of naming(variant)) if (!selects.has(written)) selects.set(written, variant);
  }
  const named = new Set(selects.keys());
  const below = new Map<string, string[]>();
  for (const variant of variants) {
    for (const written of new Set(subtypes(variant))) {
      if (named.has(written)) continue;
      const among = below.get(written);
      if (among === undefined) below.set(written, [variant]);
      else among.push(variant);
    }
  }
  const selectsNone = new Map<string, readonly string[]>();
  for (const [written, isA] of below) {
    const only = isA.length === 1 ? isA[0] : undefined;
    if (only !== undefined) selects.set(written, only);
    else selectsNone.set(written, isA);
  }
  return { selects, named, selectsNone };
}
