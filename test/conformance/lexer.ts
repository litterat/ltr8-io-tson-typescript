/**
 * Conformance-harness bridge from the real {@link createLexer} to the suite's own token-stream
 * vocabulary (§7.3): drives the lexer to completion over a vector's raw subject bytes and maps
 * each produced {@link TokenType} onto {@link ExpectedToken.kind}, the suite's coarser vocabulary.
 *
 * The suite collapses `lbrace`/`rbrace`/`lbracket`/`rbracket`/`colon`/`comma` into one
 * `structural-delimiter` kind, and every reserved punctuation character that has no dedicated
 * production of its own (`bang`, `at`, `ampersand`, `less-than`, `greater-than`, `question`,
 * `tilde`, `pipe`, `semicolon`, `lparen`, `rparen`, `caret`, `equal`, `minus`) into `special-token`
 * — see `lexer/token.ts`'s own doc comment on {@link TokenType} for why this implementation keeps
 * those distinct internally rather than losing the information this coarsening throws away.
 */

import { createLexer } from '../../packages/tson/src/lexer/lexer.js';
import type { TokenType } from '../../packages/tson/src/lexer/token.js';
import { fromBytes, runSync } from '../../packages/tson/src/io/bytes.js';
import type { ExpectedToken } from './sidecar.js';

const STRUCTURAL_DELIMITERS: ReadonlySet<TokenType> = new Set([
  'lbrace',
  'rbrace',
  'lbracket',
  'rbracket',
  'colon',
  'comma',
]);

const DIRECT_KINDS: Partial<Record<TokenType, ExpectedToken['kind']>> = {
  'single-line-token': 'single-line-token',
  'multi-line-token': 'multi-line-token',
  'unquoted-token': 'unquoted-token',
  'absent-token': 'absent-token',
  'map-arrow-token': 'map-arrow-token',
  'directive-token': 'directive-token',
  'range-token': 'range-token',
};

/** Maps one lexer {@link TokenType} onto the suite's own §7.3 vocabulary. Never called with `eof`. */
function toExpectedKind(type: TokenType): ExpectedToken['kind'] {
  const direct = DIRECT_KINDS[type];
  if (direct !== undefined) return direct;
  if (STRUCTURAL_DELIMITERS.has(type)) return 'structural-delimiter';
  // Every remaining kind is one of §7.2.5's reserved special characters, or `bang`/`minus`/`equal`
  // reached through the compound-lookahead dispatch that never became `!!`/`..`/`=>` -- all of
  // which the suite's own sidecars name `special-token` (see this module's own doc comment).
  return 'special-token';
}

/**
 * Lexes `subject`'s raw bytes to completion (§7.2, §7.3), returning every token but the trailing
 * `eof` -- matching {@link Sidecar.tokens}'s own documented contract ("the expected token stream,
 * EOF excluded"). Throws {@link TsonLexError} exactly as {@link createLexer} does, uncaught, for a
 * lexer-layer `error` vector.
 */
export function lexTokens(subject: Uint8Array): readonly ExpectedToken[] {
  const lexer = createLexer(fromBytes(subject));
  const tokens: ExpectedToken[] = [];
  for (;;) {
    const type = runSync(lexer.nextToken());
    if (type === 'eof') return tokens;
    tokens.push({ kind: toExpectedKind(type), text: lexer.text });
  }
}
