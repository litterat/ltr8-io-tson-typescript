/**
 * The atom whose values are names (Part 2 §4.2, §5.12), `meta.ref`: a type's name where its
 * `of` is a constructor, and a value's qualified name otherwise. It is no part of Part 1's built-in
 * vocabulary (§5): what a name denotes is the linked closure's, so these parsers judge the spelling
 * alone and leave the referent to whoever holds the closure.
 */
import {
  TsonAtomParseError,
  TsonAtomValidationError,
  TsonSchemaValidationError,
} from '../core/errors.js';
import type { IdentifierType } from '../schema/meta/atoms-text.js';
import type { RefBody } from '../schema/meta/bodies.js';
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
 * A `meta.ref` instance's value (§5.12): a qualified name, segments joined by `.`, each a
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
 * The atom a `meta.ref` instance reads (§4.2, §5.12): a value is a name -- a type's where `of`
 * is a constructor, a value's qualified name where it is any other type. A reference is a name whatever
 * the token's form (§2.4, §7.1): no argument list and no sibling mark is data syntax (§4.1). Not part of Part 1's built-in vocabulary (§5): what a name denotes is the
 * linked closure's, and the host form is the reference's canonical text.
 *
 * `judges` says whether a name resolves in the closure the reference was linked over, as a data
 * document's names do. A name in a schema document resolves in that schema, which the closure does not
 * hold: there the grammar alone is read, and the schema's own link judges the name.
 */
export function createReferenceParser(
  typeRef: string,
  reference: RefBody,
  judges: boolean,
): AtomType<string> {
  // An unlinked reference reads as one over a constructor with no members, as a kind with none.
  return (reference.index?.namesTypes ?? true)
    ? createTypeNameParser(typeRef, reference, judges)
    : createValueNameParser(typeRef, reference, judges);
}

/** The name `text` spells, each segment read as the kernel's `type_name` reads one, joined back. */
function readName(segment: AtomType<string>, text: string, typeRef: string): string {
  const parts = text.split('.');
  const read: string[] = [];
  for (const part of parts) {
    if (part.length === 0) {
      throw new TsonAtomParseError(
        typeRef,
        `'${text}' is no qualified name -- each segment between the dots is an identifier, and one is empty (§5.12)`,
        QUALIFIED_NAME,
      );
    }
    try {
      read.push(segment.read({ text: part, form: 'unquoted' }));
    } catch (error) {
      if (!(error instanceof TsonAtomParseError)) throw error;
      throw new TsonAtomParseError(
        typeRef,
        `'${text}' is no qualified name -- each segment between the dots is an identifier, and '${part}' is not: ${error.message} (§5.12)`,
        QUALIFIED_NAME,
      );
    }
  }
  return read.join('.');
}

/**
 * A reference that names types, `of` a constructor (§4.2): a type's name, quoted or not, judged a member --
 * the entry it denotes must be one of the reference's linked members.
 */
function createTypeNameParser(
  typeRef: string,
  reference: RefBody,
  judges: boolean,
): AtomType<string> {
  const segment = createIdentifierParser(typeRef, TYPE_NAME_GRAMMAR);
  const members = reference.index?.members ?? [];
  const shown = reference.index?.shown ?? members;
  return {
    read(token: AtomToken): string {
      // A reference is a name, whatever the token's form (§2.4, §7.1): a quoted token is the reference
      // its text spells, and a text no segment grammar reads is no reference.
      const canonical = readName(segment, token.text, typeRef);
      if (!judges) return canonical;
      const entry = reference.index === undefined ? undefined : canonical;
      const listing = shown.length === 0 ? 'none' : shown.join(', ');
      if (entry === undefined) {
        throw new TsonAtomValidationError(
          typeRef,
          `'${canonical}' names no type this schema closes -- no entry of this closure bears that name; one of ${listing}`,
          `one of (${shown.join(', ')})`,
        );
      }
      if (members.includes(entry)) return canonical;
      throw new TsonAtomValidationError(
        typeRef,
        `'${canonical}' is not a member of this kind -- expected the name of a type whose value IS-A '${reference.of.name}', ` +
          `${members.length === 0 ? 'and the kind has no members' : `one of ${listing}`} (§4.2)`,
        members.length === 0
          ? 'no value (the kind has no members)'
          : `one of (${shown.join(', ')})`,
      );
    },
    write: (value: string): string => value,
  };
}

/**
 * A reference that names values, `of` a type that is no constructor (§4.2, §5.12): a qualified name, each
 * segment an identifier, read into the name it is. A value is named and never applied, so it takes no
 * argument list. Where the reference was linked over a whole closure the name is judged by what it
 * reaches there, as a value body's names are: a name reaching nothing, a type, or a value whose type is no
 * `of` is refused as a constraint the value breaks.
 */
function createValueNameParser(
  typeRef: string,
  reference: RefBody,
  judges: boolean,
): AtomType<string> {
  const segment = createIdentifierParser(typeRef, TYPE_NAME_GRAMMAR);
  return {
    read(token: AtomToken): string {
      const name = readName(segment, token.text, typeRef);
      const values = judges ? reference.index?.values : undefined;
      if (values === undefined) return name;
      try {
        values('this reference', name);
      } catch (error) {
        if (!(error instanceof TsonSchemaValidationError)) throw error;
        throw new TsonAtomValidationError(
          typeRef,
          error.message,
          `the name of a value of '${reference.of.name}'`,
        );
      }
      return name;
    },
    write: (value: string): string => value,
  };
}
