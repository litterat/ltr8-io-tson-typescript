/**
 * The two atoms that hold a reference (§4.2, [TSON-DATA] §7.4): `type_ref`, a position that names a
 * type, and `reference`, a record field's type. The wire form of either is a bare qualified name, one
 * token (§4.1). The host form is the model's {@link TypeRef} and {@link Reference}.
 *
 * Both directions live here, between the reference model of `ast/reference.ts` and
 * `schema/meta`'s own: the model names no AST type, so this is the one place the two meet.
 */
import {
  referenceText,
  type ApplicationReference,
  type Reference as AstReference,
} from '../ast/reference.js';
import type { TokenValue } from '../ast/value.js';
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

/**
 * A reference as its wire form: a bare token. A data value holds no argument list and no sibling mark
 * (§4.1), so an application or a sibling reference is written as its canonical text, which no position
 * reads as a name.
 */
export function referenceToWire(reference: Reference): TokenValue {
  if (reference.kind === 'sibling') {
    return { kind: 'token', text: `${reference.field}!`, form: 'unquoted' };
  }
  if (reference.arguments.length === 0) {
    return { kind: 'token', text: reference.name, form: 'unquoted' };
  }
  return { kind: 'token', text: referenceText(applicationToAst(reference)), form: 'unquoted' };
}

function applicationToAst(reference: TypeRef): ApplicationReference {
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
