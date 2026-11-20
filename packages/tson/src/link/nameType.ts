/**
 * Where a record's `name_type` resolves, and whether what it resolves to may stand there
 * ([TSON-SCHEMA] §5.2): the identifier family a record's field names are values of. The peer of
 * `enumLabels.ts`'s `enumLabelType`, on the same terms, and shared by the linker's field-name check
 * (`fieldNames.ts`), its hygiene walk (`nameHygiene.ts`) and the readers, through
 * `LinkedSchema.nameTypes`.
 *
 * **Where it resolves.** A `name_type` an author wrote resolves in the schema's own namespace
 * first, then the governing meta's, as an enum's does (§7.4): `field_name => !identifier_type {
 * start_add: "@" }` declared locally is what `name_type: field_name` names. The absent default is
 * `meta.identifier` (§5.2), resolved in the governing meta first, so a schema's own entry of that
 * spelling does not retype every record that states nothing. Two name types are one by the entry they
 * resolve to (§8.3), never by spelling.
 *
 * **What may stand there** is a member of `identifier_kind` (§4.2): an entry built with
 * `identifier_type` -- an instance, a refinement of one, or an alias of either -- which is to say one whose value, at the end of its
 * alias chain, is an `identifier_type` body. And its `normalization` must imply NFC
 * ({@link nameTypeFormRefusal}).
 */
import type { IdentifierBase, IdentifierType } from '../schema/meta/atoms-text.js';
import type { RecordBody } from '../schema/meta/bodies.js';
import type { Top } from '../schema/meta/typedef.js';
import { metaName } from '../schema/meta/kernel.js';
import { terminal, type EntryLookup } from './aliasChain.js';
import { identifierProfileOf, profileAdmits } from '../unicode/identifier-profile.js';

/** The kernel's `identifier` (§7.7): an enum's default name type, and the name type a record stating none has (§5.2). */
const IDENTIFIER = metaName('identifier');

/** A resolved name type: the terminal entry's name, its value, and the namespace its own names resolve in. */
export interface ResolvedNameType {
  readonly name: string;
  readonly definition: Top;
  readonly lookup: EntryLookup;
}

function fallingBackTo(primary: EntryLookup, fallback: EntryLookup | undefined): EntryLookup {
  return fallback === undefined ? primary : (name) => primary(name) ?? fallback(name);
}

/**
 * `body`'s name type, given the schema's own namespace and the governing meta's (`structure`,
 * absent for the meta-kernel bootstrap). `undefined` for a name that resolves in neither.
 */
export function recordNameType(
  body: Pick<RecordBody, 'nameType'>,
  local: EntryLookup,
  structure: EntryLookup | undefined,
): ResolvedNameType | undefined {
  const written = body.nameType ?? IDENTIFIER;
  const order: readonly (EntryLookup | undefined)[] =
    body.nameType === undefined ? [structure, local] : [local, structure];
  for (const [index, namespace] of order.entries()) {
    if (namespace?.(written) === undefined) continue;
    const other = order[1 - index];
    const name = terminal(written, namespace);
    const definition = namespace(name);
    if (definition === undefined) return undefined;
    return { name, definition, lookup: fallingBackTo(namespace, other) };
  }
  return undefined;
}

/** Whether `type` is an identifier family: a member of `identifier_kind` (§4.2), built with `identifier_type`. */
export function isIdentifierFamily(
  type: ResolvedNameType,
): type is ResolvedNameType & { readonly definition: IdentifierType } {
  return type.definition.kind === 'identifier_type';
}

/**
 * Whether `type` is the kernel's `identifier` -- an enum's default and a record's (§5.2) -- whose values a refusal calls identifiers, where it names any other type, the author's
 * own.
 */
export function isKernelIdentifier(
  type: ResolvedNameType,
  structure: EntryLookup | undefined,
): boolean {
  if (structure === undefined) return type.name === IDENTIFIER;
  return type.definition === structure(terminal(IDENTIFIER, structure));
}

/**
 * Why `type`'s `normalization` cannot judge names, or `undefined` when it can ([TSON-SCHEMA] §5.2,
 * §7.4). Names are compared in a form that implies NFC: under one that does not, two canonically
 * equivalent spellings are two names that render alike, the confusion §8.2's rules exist to refuse,
 * and no reader could match a document's name to a declared one without choosing a form the type
 * never stated. `NONE` implies none; `ASCII_CASEFOLD` implies NFC only of ASCII text, so it names a
 * type whose every character is ASCII -- an `ASCII` or empty base, and additions within ASCII.
 */
export function nameTypeFormRefusal(type: IdentifierType): string | undefined {
  switch (type.normalization) {
    case 'NONE':
      return (
        'its normalization is NONE, under which two canonically equivalent spellings are two ' +
        "names; a name type's form implies NFC"
      );
    case 'ASCII_CASEFOLD':
      return asciiOnly(type)
        ? undefined
        : 'its normalization is ASCII_CASEFOLD, which leaves text beyond ASCII unnormalized, and ' +
            "its profile admits such text; a name type's form implies NFC -- use NFKC_CASEFOLD, or " +
            "admit only ASCII ('start: ASCII  continue: ASCII')";
    case 'NFC':
    case 'NFKC':
    case 'NFKC_CASEFOLD':
      return undefined;
  }
}

function asciiOnly(type: IdentifierType): boolean {
  return (
    asciiBase(type.start) &&
    asciiBase(type.continue) &&
    [type.startAdd, type.continueAdd, type.medial].every(
      (text) => text === undefined || isAscii(text),
    )
  );
}

/** Whether every UTF-16 unit of `text` is below U+0080 -- which is every code point, since none beyond ASCII encodes to one. */
function isAscii(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) >= 0x80) return false;
  }
  return true;
}

function asciiBase(base: IdentifierBase): boolean {
  return base === 'ASCII' || base === 'NONE';
}

/**
 * Why `type` cannot name the keys a qualified name's segment selects, or `undefined` when it can ([TSON-SCHEMA]
 * §4.2, §5.2, §5.12): a qualified name splits at `.` before any family is consulted, so a name holding one could not
 * be reached by a reference. Asked of a namespace's `key_type` and a record's `name_type`.
 */
export function nameTypeDotRefusal(type: IdentifierType): string | undefined {
  return profileAdmits(identifierProfileOf(type), FULL_STOP)
    ? "its profile admits '.' (U+002E), which joins the segments of a qualified name, so a name holding " +
        'one could not be reached by a reference ([TSON-SCHEMA] §5.12)'
    : undefined;
}

/** U+002E, the separator of a qualified name's segments. */
const FULL_STOP = 0x2e;
