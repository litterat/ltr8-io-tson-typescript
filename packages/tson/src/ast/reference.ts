import type { TokenForm } from '../lexer/token.js';

/**
 * A reference as the data grammar spells it (§7.4): the structured value a qualified name with an
 * argument list, `pair<uuid B>`, or a sibling reference, `kind!`, parses to. Uninterpreted: what a
 * name or an argument denotes is the reading type's to judge ([TSON-SCHEMA] §4.2), and a schemaless
 * read resolves nothing (§4.1).
 *
 * The model is the grammar's own and carries no referent, closure or annotation: those belong to a
 * schema's reading of a reference, not to the text that spelled one.
 */
export type Reference = NameReference | ApplicationReference | SiblingReference;

/**
 * The references that are a core value on their own (§7.4): an application or a sibling reference.
 * A bare qualified name is a token, read as a reference by a position typed by one.
 */
export type CoreReference = ApplicationReference | SiblingReference;

/** A reference that names a type: a bare qualified name or an application. */
export type TypeReference = NameReference | ApplicationReference;

/** A qualified name with no argument list (§7.4): segments joined by `.`, each an identifier (§7.7). */
export interface NameReference {
  readonly kind: 'name';
  readonly name: string;
}

/**
 * `application = qualified-name-token "<" ws type-args ws ">"` (§7.4): a qualified name and one or
 * more arguments, in written order. `arguments` is never empty: there is no spelling of an empty
 * argument list.
 */
export interface ApplicationReference {
  readonly kind: 'application';
  readonly name: string;
  readonly arguments: readonly ReferenceArgument[];
}

/**
 * `sibling-ref = unquoted-token "!"` (§7.4): the field of the enclosing record, named by one
 * identifier (a single segment), whose value chooses a record field's type ([TSON-SCHEMA] §5.2).
 */
export interface SiblingReference {
  readonly kind: 'sibling';
  readonly field: string;
}

/**
 * `type-arg = application / token` (§7.4), as the grammar classifies it: a token that is a
 * qualified name is a {@link ReferenceArgument} of kind `reference` (a name or a nested
 * application), and any other token is a `value` carrying its text and token form. A quoted token
 * is never a reference. Whether an argument binds a type or a value is its parameter's to say.
 */
export type ReferenceArgument =
  | { readonly kind: 'reference'; readonly reference: TypeReference }
  | { readonly kind: 'value'; readonly text: string; readonly form: TokenForm };

/**
 * The canonical text of `reference`: no whitespace inside the brackets beyond one space between
 * arguments, a quoted value argument escaped as a quoted token is (`"` and `\` backslashed, a
 * control character as `\uXXXX`), so `map<text list<int32>>` reads back as the one reference it was
 * written as. Identity is the parsed form, never the spelling (§7.4).
 */
export function referenceText(reference: Reference): string {
  switch (reference.kind) {
    case 'name':
      return reference.name;
    case 'sibling':
      return `${reference.field}!`;
    case 'application':
      return `${reference.name}<${reference.arguments.map(argumentText).join(' ')}>`;
  }
}

/** The canonical text of one argument, as it stands inside an argument list. */
export function argumentText(argument: ReferenceArgument): string {
  if (argument.kind === 'reference') return referenceText(argument.reference);
  return argument.form === 'unquoted' ? argument.text : quotedArgument(argument.text);
}

function quotedArgument(text: string): string {
  let out = '"';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (code < 0x20 || code === 0x7f)
      out += `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}
