/**
 * `!boolean` ([TSON-DATA] §5.5) -- meta-kernel's `boolean => !enum [true false]`, read as a host
 * `boolean` rather than as the member's own text. An ordinary enum-shaped reading would hand back
 * the strings `'true'`/`'false'`, exactly wrong for a position declared `boolean`; this is the
 * schemaless vocabulary's own line between the two, matching `compiler/atomBuilder.ts`'s
 * `{true, false}` special case on the schema-compiled side so a token reads to the same host value
 * with a schema and without one.
 *
 * Exactly the two tokens `true`/`false`, case-sensitive -- no other spelling (`yes`, `on`, `True`,
 * `FALSE`) is recognised. The form is never consulted: `!boolean "true"` and `!boolean true` are
 * one value, because [TSON-DATA] §4.2's special status for the two unquoted tokens is a
 * *base-resolution* rule, which a typed position never reaches (§5.5).
 *
 * **A third small copy of the `{true, false}` check, deliberately** -- `atom/forType.ts`'s
 * `buildEnumParser` and `compiler/atomBuilder.ts`'s `buildEnumAtomType` each carry their own, and
 * this module does not import either to share it: both take a resolved schema `EnumBody`/`Atom`,
 * where `reader/schemaless/vocabulary.ts` has no schema to resolve one from at all (this table's
 * own top note), and `forType.ts`'s version answers `string | boolean` for any enum, not `boolean`
 * for this one. `atom/forType.ts`'s own `asTextConstraints` states the same tradeoff for its own
 * small duplicate of a `compiler/atomBuilder.ts` builder.
 */
import { TsonAtomValidationError } from '../core/errors.js';
import type { AtomToken, AtomType } from './contract.js';

const MEMBERSHIP = 'one of (true, false)';

/**
 * `boolean`'s parsing contract: `read` throws {@link TsonAtomValidationError}, never
 * {@link TsonAtomParseError}, for any token but the two members -- an enum's member set is a
 * range, not a grammar, so a token outside it is a value the type does not admit rather than one
 * the type cannot parse at all (§5.5, mirroring every other enum's member-set violation).
 */
export function createBooleanParser(): AtomType<boolean> {
  return {
    read(token: AtomToken): boolean {
      switch (token.text) {
        case 'true':
          return true;
        case 'false':
          return false;
        default:
          throw new TsonAtomValidationError(
            'boolean',
            `'${token.text}' is not a member of 'boolean' -- expected ${MEMBERSHIP}`,
            MEMBERSHIP,
          );
      }
    },
    write(value: boolean): string {
      return value ? 'true' : 'false';
    },
  };
}
