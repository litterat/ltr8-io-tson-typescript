/**
 * The atom that holds a reference (§4.2, §5.12): `meta.type_ref` and every `meta.ref`, whose wire form is one
 * token of either form, its text a qualified name. The host form is the model's {@link TypeRef}.
 *
 * Both directions live here: a token read into the reference it spells, and a reference written back as the
 * token an author would write -- unquoted exactly when every segment is in the token profile.
 */
import type { TokenValue } from '../ast/value.js';
import type { TokenForm as LexerTokenForm } from '../lexer/token.js';
import { isQualifiedName, parseReference } from '../atom/referenceGrammar.js';
import type { TypeRef } from './meta/typedef.js';

/**
 * The reference a token at a reference position reads to (§5.12): a quoted token is the reference its text
 * spells, as an unquoted one is ([TSON-DATA] §2.4). Text that spells no qualified name is kept as written and
 * left for the position to judge.
 */
export function referenceOfWire(text: string, form: LexerTokenForm): TypeRef {
  void form;
  try {
    return { name: parseReference(text), annotations: [] };
  } catch {
    return { name: text, annotations: [] };
  }
}

/**
 * A reference as its wire form: one token, its name, written unquoted where every segment is an identifier and
 * quoted otherwise (§5.12, [TSON-DATA] §7.1).
 */
export function referenceToWire(reference: TypeRef): TokenValue {
  return {
    kind: 'token',
    text: reference.name,
    form: isQualifiedName(reference.name) ? 'unquoted' : 'single-line',
  };
}
