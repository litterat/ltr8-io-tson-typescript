/**
 * Parses and validates against an enum -- an instance of meta-kernel's `enum_type` or a tightening
 * of it such as `enum` or `text_enum` (§7.4). Matches on the token's text directly, never through
 * base type resolution's boolean/number/string identification: that is what makes `boolean =>
 * !enum [true false]` readable at all, since the token `true` is a member, not a boolean literal
 * to be identified first.
 *
 * **The match is in the label type's form** (§7.4, §5.5): an enum over a case-folding identifier
 * admits a member however it is cased, and the value is the token in that form. The form is not on
 * the body -- the label type may live in the governing meta -- so the caller supplies what linking
 * recorded (`LinkedSchema.enumForms`). Each member is put into the form as it is compared, and the
 * two compare in NFC, the floor no text comparison goes below (§5.5), so a decomposed spelling of a
 * member is the member.
 *
 * `{true, false}` is the one member set that narrows to a real host `boolean`; a three-member enum
 * that happens to include `true` stays string-valued.
 */
import { TsonAtomValidationError } from '../core/errors.js';
import type { EnumBody } from '../schema/meta/bodies.js';
import type { Normalization } from '../schema/meta/atoms-text.js';
import { applyNormalization, describeToken, nfcFloor } from '../unicode/normalization.js';
import type { AtomToken, AtomType } from './contract.js';

/** Builds the `AtomType` for one enum, matching in `form` -- its label type's `normalization`. */
export function createEnumParser(
  typeRef: string,
  body: EnumBody,
  form: Normalization = 'NONE',
): AtomType<string | boolean> {
  const members = body.members;
  const values = new Set(members.map((member) => nfcFloor(applyNormalization(form, member))));
  const isBoolean = members.length === 2 && values.has('true') && values.has('false');
  const membership = `one of (${members.join(', ')})`;

  return {
    read(token: AtomToken): string | boolean {
      const value = applyNormalization(form, token.text);
      const compared = nfcFloor(value);
      if (!values.has(compared)) {
        throw new TsonAtomValidationError(
          typeRef,
          `${describeToken(token.text, value, form)} is not a member of '${typeRef}' -- expected ${membership}`,
          membership,
        );
      }
      return isBoolean ? compared === 'true' : value;
    },
    write(value: string | boolean): string {
      return typeof value === 'boolean' ? (value ? 'true' : 'false') : value;
    },
  };
}
