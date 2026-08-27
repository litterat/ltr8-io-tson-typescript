/**
 * Base type resolution (§4): resolves an already-lexed token to a {@link BaseValue} per the
 * fixed order of §4.5 — null, boolean, number, string.
 *
 * Quoted tokens always resolve to string regardless of content (§4.4: "Any quoted token resolves
 * to a string value") — `"42"`, `"true"`, and `"null"` are the strings `42`, `true`, and `null`,
 * not the number/boolean/null they'd be if unquoted. Only an unquoted token attempts the
 * null/boolean/number checks.
 *
 * This applies only when no declared type information is in scope and the token carries no
 * built-in type annotation (§4's own applicability clause) — callers must not invoke this on a
 * token annotated with a built-in-vocabulary type (§5) or governed by a schema
 * ([TSON-SCHEMA]); this module has no way to detect either from a bare token alone.
 *
 * `BaseToken` is its own minimal shape rather than `ast/value.ts`'s `TokenValue`, mirroring
 * `atom/contract.ts`'s `AtomToken`: this is a leaf layer with no document-tree concept of its
 * own, and pulling in `ast/`'s `CoreValue` union for the sake of the two fields this module
 * actually needs would run the dependency backwards — `atom/`'s numeric parsers build on
 * `tryParseNumber` from `numberGrammar.ts`, so `base/` has to stay beneath `atom/`, not reach
 * sideways into a peer that already sits above it.
 */

import type { TokenForm } from '../lexer/token.js';
import { tryParseNumber, type NumberForm } from './numberGrammar.js';

/** The already-lexed token text {@link resolveBaseType} resolves — text plus form (§2.4). */
export interface BaseToken {
  readonly text: string;
  readonly form: TokenForm;
}

/** The token `null` (§4.1) — distinct from the absent sentinel `_` (§2.9). */
export interface NullValue {
  readonly kind: 'null';
}

/** `true` or `false` (§4.2). */
export interface BooleanValue {
  readonly kind: 'boolean';
  readonly value: boolean;
}

/** An unquoted token whose complete text matched the `number` production (§4.3). */
export interface NumberValue {
  readonly kind: 'number';
  readonly form: NumberForm;
}

/** Every quoted token, and every unquoted token that isn't `null`/boolean/a number (§4.4). */
export interface StringValue {
  readonly kind: 'string';
  readonly text: string;
}

/**
 * The result of base type resolution (§4): a token's identified base type. Identification only —
 * {@link NumberValue} wraps a {@link NumberForm} (the recognized grammar shape), not a bound host
 * numeric type; narrowing to one is `numberNarrowing.ts`'s separate, later job.
 */
export type BaseValue = NullValue | BooleanValue | NumberValue | StringValue;

/**
 * Resolves `token` per §4.5's fixed order: null, then true/false, then the number grammar as a
 * full-token match, then string. A quoted token always resolves to string (§4.4) without
 * attempting any of the other three — form is consulted exactly once, here.
 */
export function resolveBaseType(token: BaseToken): BaseValue {
  if (token.form !== 'unquoted') {
    return { kind: 'string', text: token.text };
  }

  const text = token.text;
  if (text === 'null') {
    return { kind: 'null' };
  }
  if (text === 'true') {
    return { kind: 'boolean', value: true };
  }
  if (text === 'false') {
    return { kind: 'boolean', value: false };
  }

  const form = tryParseNumber(text);
  return form !== undefined ? { kind: 'number', form } : { kind: 'string', text };
}
