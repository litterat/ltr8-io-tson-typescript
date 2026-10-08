/**
 * Parses and validates against meta-kernel's `identifier_type` constructor -- a UAX #31 identifier
 * profile with `text_type`'s facets inside it (§5.5, §7.7). The kernel's `identifier` instance is
 * the type of every naming position in the series; other instances name an outside system's
 * positions under that system's own profile.
 *
 * **The text is put into the `normalization` form, then the profile judges it, then the text
 * facets** (§5.5). The value is the normalised text, so the profile asks whether the *value* is a
 * name: under `NFKC_CASEFOLD`, a profile of lowercase letters admits `Content-Type`. A name the
 * profile refuses is a grammar violation whatever its facets say -- a {@link TsonAtomParseError},
 * which the readers report as a resolver error -- so a refinement's `pattern` or `members` is only
 * ever asked of a well-formed name.
 *
 * **What is here is only the atom.** `unicode/identifier-profile.ts` owns the profile, beside the
 * tables it reads, because it is not a parser: it answers *is this a legal name* over text a caller
 * already holds, and each caller decides what a failure becomes. The rule that a name the profile
 * refuses is a *parse* failure is this position's answer. Name hygiene (§8.2) is not here either:
 * it is a policy over the value, applied by the reader that holds the policy
 * (`compiler/atomBuilder.ts`, `json/schema/atoms.ts`).
 */
import { TsonAtomParseError } from '../../core/errors.js';
import type { IdentifierType } from '../../schema/meta/atoms-text.js';
import { checkIdentifier, identifierProfileOf } from '../../unicode/identifier-profile.js';
import { applyNormalization, describeToken } from '../../unicode/normalization.js';
import type { AtomToken, AtomType } from '../contract.js';
import { createTextFacets } from './text.js';

/** The `expected` fragment a name outside the profile reports (`atom/contract.ts`'s grammar shape). */
const EXPECTED = 'an identifier';

/** Builds the `AtomType` for one fully-parameterised `identifier_type` instance. */
export function createIdentifierParser(
  typeRef: string,
  constraints: IdentifierType,
): AtomType<string> {
  const profile = identifierProfileOf(constraints);
  const facets = createTextFacets(typeRef, constraints);
  const form = constraints.normalization;

  return {
    read(token: AtomToken): string {
      const value = applyNormalization(form, token.text);
      const violation = checkIdentifier(profile, value);
      if (violation !== undefined) {
        // The profile locates a character by its index in the value, so the value stays in its
        // sentence; the written spelling leads it wherever the form changed the text.
        throw new TsonAtomParseError(
          typeRef,
          value === token.text
            ? violation
            : `${describeToken(token.text, value, form)}: ${violation}`,
          EXPECTED,
        );
      }
      facets(value, describeToken(token.text, value, form));
      return value;
    },
    write: (value: string): string => value,
  };
}
