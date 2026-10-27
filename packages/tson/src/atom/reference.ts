/**
 * The two atoms whose values are names (Part 2 §4.2, §5.12): a kind's value, a type's name, and a
 * reference's value, a value's qualified name. Neither is part of Part 1's built-in vocabulary
 * (§5): what a name denotes is the linked closure's, so these parsers judge the spelling alone and
 * leave the referent to whoever holds the closure.
 */
import { TsonAtomParseError, TsonAtomValidationError } from '../core/errors.js';
import type { IdentifierType } from '../schema/meta/atoms-text.js';
import type { KindBody } from '../schema/meta/typedef.js';
import type { AtomToken, AtomType } from './contract.js';
import { createIdentifierParser } from './text/identifier.js';

/**
 * The grammar a name of a type is read by: the kernel's `type_name`, an `identifier`
 * ([TSON-DATA] §7.7) -- `!identifier_type { continue_add: "-" }`.
 */
export const TYPE_NAME_GRAMMAR: IdentifierType = {
  kind: 'identifier_type',
  spec: 'https://www.unicode.org/reports/tr31/',
  normalization: 'NFC',
  start: 'XID',
  continue: 'XID',
  continueAdd: '-',
};

/** The `expected` fragment a token that is no qualified name reports. */
const QUALIFIED_NAME = 'a qualified name';

/**
 * A `ref_type` instance's value (§5.12): a qualified name, segments joined by `.`, each a
 * [TSON-DATA] §7.7 identifier read as `type_name` reads it, none empty. So `orders.1x`, `.orders`
 * and `orders.` are no names. The value is the name as written; what it reaches is judged where
 * it resolves, when the schema holding it links.
 */
export function createQualifiedNameParser(typeRef: string): AtomType<string> {
  const segment = createIdentifierParser(typeRef, TYPE_NAME_GRAMMAR);
  return {
    read(token: AtomToken): string {
      for (const part of token.text.split('.')) {
        if (part.length === 0) {
          throw new TsonAtomParseError(
            typeRef,
            `'${token.text}' is no qualified name -- each segment between the dots is an identifier, and one is empty (§5.12)`,
            QUALIFIED_NAME,
          );
        }
        try {
          segment.read({ text: part, form: 'unquoted' });
        } catch (error) {
          if (!(error instanceof TsonAtomParseError)) throw error;
          throw new TsonAtomParseError(
            typeRef,
            `'${token.text}' is no qualified name -- each segment between the dots is an identifier, and '${part}' is not: ${error.message} (§5.12)`,
            QUALIFIED_NAME,
          );
        }
      }
      return token.text;
    },
    write: (value: string): string => value,
  };
}

/**
 * A `kind_type` instance's value (§4.2): a type's name, read by the type-name grammar, and -- where
 * `judgesMembers` -- a member of the kind's linked `members`, as an enum refuses a label it does
 * not list. The value is the name, never a value of the type it names.
 *
 * **Membership is judged where the names resolve.** A kind's members are the names of the closure
 * it was linked over, so a name read under that schema is a member or refused. Where the
 * governing schema is a meta layer the document being read is a schema, or describes one, and a
 * name it writes resolves in that schema's namespace, which the closure does not hold: there the
 * grammar alone is read, and the described schema's link judges the name a member.
 */
export function createKindParser(
  typeRef: string,
  kind: KindBody,
  judgesMembers: boolean,
): AtomType<string> {
  const grammar = createIdentifierParser(typeRef, TYPE_NAME_GRAMMAR);
  const members = kind.members ?? [];
  return {
    read(token: AtomToken): string {
      const name = grammar.read(token);
      if (!judgesMembers || members.includes(name)) return name;
      throw new TsonAtomValidationError(
        typeRef,
        `'${name}' is not a member of this kind -- expected the name of a type built with ` +
          `'${kind.of}', ${members.length === 0 ? 'and the kind has no members' : `one of ${members.join(', ')}`} (§4.2)`,
        members.length === 0
          ? 'no value (the kind has no members)'
          : `one of (${members.join(', ')})`,
      );
    },
    write: (value: string): string => value,
  };
}
