/**
 * The one conversion table between the lexer's own {@link LexerTokenForm} (`ast.TokenValue`'s
 * `form`, lower-kebab: `'unquoted' | 'single-line' | 'multi-line'`) and `schema/meta`'s local
 * stand-in {@link MetaTokenForm} (`Token.Form`, upper-snake: `'UNQUOTED' | 'SINGLE_LINE_QUOTED' |
 * 'MULTI_LINE_QUOTED'`, mirroring `ast.TokenForm` one-for-one per `typedef.ts`'s own doc).
 *
 * Every conversion between the two goes through here, so the two spellings cannot drift apart.
 */
import type { TokenForm as LexerTokenForm } from '../lexer/token.js';
import type { TokenForm as MetaTokenForm } from '../schema/meta/typedef.js';

export function metaFormOfLexer(form: LexerTokenForm): MetaTokenForm {
  switch (form) {
    case 'unquoted':
      return 'UNQUOTED';
    case 'single-line':
      return 'SINGLE_LINE_QUOTED';
    case 'multi-line':
      return 'MULTI_LINE_QUOTED';
  }
}

export function lexerFormOfMeta(form: MetaTokenForm): LexerTokenForm {
  switch (form) {
    case 'UNQUOTED':
      return 'unquoted';
    case 'SINGLE_LINE_QUOTED':
      return 'single-line';
    case 'MULTI_LINE_QUOTED':
      return 'multi-line';
  }
}
