/**
 * The two atoms that hold a reference (§4.2, [TSON-DATA] §7.4): `type_ref`, a position that names a
 * type, and `reference`, a record field's type, which also admits a sibling reference. The wire form of
 * either is the data grammar's own: a bare qualified name is one token, an application is the structured
 * reference value `pair<uuid B>`, and a sibling reference is `kind!`. The host form is the model's
 * {@link TypeRef} and {@link Reference}.
 *
 * Both directions live here, between the data grammar's structured reference (`ast/reference.ts`) and
 * `schema/meta`'s own: the model names no AST type, so this is the one place the two meet.
 */
import type { CoreReference, Reference as AstReference } from '../ast/reference.js';
import type { ReferenceValue, TokenValue } from '../ast/value.js';
import type { TokenForm as LexerTokenForm } from '../lexer/token.js';
import { parseReference } from '../atom/referenceGrammar.js';
import type { Reference, SiblingRef, Token, TypeArgument, TypeRef } from './meta/typedef.js';

const FORM_FROM_LEXER: Record<LexerTokenForm, Token['form']> = {
  unquoted: 'UNQUOTED',
  'single-line': 'SINGLE_LINE_QUOTED',
  'multi-line': 'MULTI_LINE_QUOTED',
};

const FORM_TO_LEXER: Record<Token['form'], LexerTokenForm> = {
  UNQUOTED: 'unquoted',
  SINGLE_LINE_QUOTED: 'single-line',
  MULTI_LINE_QUOTED: 'multi-line',
};

/** A parsed reference in the model's form, annotations empty. */
export function referenceFromAst(reference: AstReference): Reference {
  if (reference.kind === 'sibling') return siblingOf(reference.field);
  return typeRefFromAst(reference);
}

/** A parsed type reference in the model's form, annotations empty. */
export function typeRefFromAst(reference: Exclude<AstReference, { kind: 'sibling' }>): TypeRef {
  if (reference.kind === 'name') return { name: reference.name, arguments: [], annotations: [] };
  return {
    name: reference.name,
    arguments: reference.arguments.map((argument): TypeArgument => {
      if (argument.kind === 'reference') {
        return { kind: 'ref', ref: typeRefFromAst(argument.reference) };
      }
      return {
        kind: 'value',
        value: { text: argument.text, form: FORM_FROM_LEXER[argument.form] },
      };
    }),
    annotations: [],
  };
}

/** The unannotated sibling reference to `field`. */
export function siblingOf(field: string): SiblingRef {
  return { kind: 'sibling', field, annotations: [] };
}

/**
 * The reference a token or structured reference value at a reference position reads to. A quoted token is
 * never a reference (§7.4), so it is kept as the one name it spells and left for the position to judge.
 * `sibling` says whether the position admits a sibling reference; where it does not, one is refused by the
 * caller, which owns the diagnostic.
 */
export function referenceOfWire(text: string, form: LexerTokenForm): Reference {
  if (form !== 'unquoted') return { name: text, arguments: [], annotations: [] };
  try {
    return referenceFromAst(parseReference(text));
  } catch {
    return { name: text, arguments: [], annotations: [] };
  }
}

/** A reference as its wire form: a bare token for a name, the structured reference value for an application or a sibling. */
export function referenceToWire(reference: Reference): TokenValue | ReferenceValue {
  if (reference.kind === 'sibling') {
    return { kind: 'reference', reference: { kind: 'sibling', field: reference.field } };
  }
  if (reference.arguments.length === 0) {
    return { kind: 'token', text: reference.name, form: 'unquoted' };
  }
  return { kind: 'reference', reference: applicationToAst(reference) };
}

function applicationToAst(reference: TypeRef): CoreReference & { kind: 'application' } {
  return {
    kind: 'application',
    name: reference.name,
    arguments: reference.arguments.map((argument) => {
      if (argument.kind === 'ref') {
        return {
          kind: 'reference' as const,
          reference:
            argument.ref.arguments.length === 0
              ? { kind: 'name' as const, name: argument.ref.name }
              : applicationToAst(argument.ref),
        };
      }
      return {
        kind: 'value' as const,
        text: argument.value.text,
        form: FORM_TO_LEXER[argument.value.form],
      };
    }),
  };
}
