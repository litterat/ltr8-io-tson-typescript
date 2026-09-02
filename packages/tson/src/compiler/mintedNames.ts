/**
 * The names one phase has minted, and what each was derived from — [TSON-SCHEMA] §8.2's freshness
 * MUST that an internal name "collides with no declared entry and no other internal entry", stated
 * exactly.
 *
 * **Deduping by name is the identity discipline working, and is also what would hide a
 * collision.** Two occurrences of one form must land on one entry — that is what lets `[text]`
 * written twice be one type, what lets a form written out and the same form arriving through a
 * template agree, and what ties a recursive template's knot. So a second arrival under a name is
 * ordinarily the same form again and nothing to report. By name alone that is indistinguishable
 * from two *different* bindings that happened to derive one name, which would silently merge two
 * types.
 *
 * So the derivations are compared rather than assumed equal. Both minting sites
 * (`derivedName.ts`'s `ofBinding`/`ofApplication`) render one canonically before hashing it, and
 * those renderings are injective by construction — two are equal exactly when the bindings are —
 * so this is the MUST decided rather than a probability. That matters because the name's own hash
 * is 32 bits: it is a rendering, and was never load-bearing on its own.
 *
 * **One instance per phase, not one shared across them.** `desugar.ts` mints while lifting sugar
 * forms and `templates.ts` mints while closing applications; they run either side of resolution,
 * so each holds its own instance. The two share their naming functions, so a name minted in one
 * phase colliding with a different form in the other would have had to collide within a phase as
 * well to exist at all — which is why a cross-phase collision is not this module's concern.
 */
import { TsonInternalError } from '../core/errors.js';

export interface MintedNames {
  /**
   * Records that `name` was derived from `canonical`.
   *
   * Returns `true` the first time a name is claimed, `false` when this is the same derivation
   * arriving again — which a caller uses to tell "build the entry" from "it is already there".
   *
   * @throws {@link TsonInternalError} if `name` was already claimed from a *different* canonical
   *   rendering: an invariant of the naming function has broken, which is neither an author's
   *   error nor a gap in this library — a real 32-bit hash collision between two distinct forms.
   */
  claim(name: string, canonical: string): boolean;
}

export function createMintedNames(): MintedNames {
  const canonicalByName = new Map<string, string>();
  return {
    claim(name: string, canonical: string): boolean {
      const existing = canonicalByName.get(name);
      if (existing === undefined) {
        canonicalByName.set(name, canonical);
        return true;
      }
      if (existing !== canonical) {
        throw new TsonInternalError(
          `two different forms derive the internal name '${name}', so one would silently take the ` +
            "other's entry (§8.2 requires an internal name to collide with no other): " +
            `${existing} and ${canonical}`,
        );
      }
      return false;
    },
  };
}
