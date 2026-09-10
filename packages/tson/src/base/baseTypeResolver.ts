/**
 * Base type resolution (§4): resolves an already-lexed token to a {@link BaseValue} per the
 * fixed order of §4.5 — boolean, number, string.
 *
 * Quoted tokens always resolve to string regardless of content (§4.4: "Any quoted token resolves
 * to a string value") — `"42"` and `"true"` are the strings `42` and `true`, not the
 * number/boolean they'd be if unquoted. Only an unquoted token attempts the boolean/number
 * checks.
 *
 * This applies **only in schemaless documents** — a document whose header carries no `!!schema`
 * (§4.1) — and, within one, only to a token carrying no built-in type annotation. Callers must not
 * invoke it on a token annotated with a built-in-vocabulary type (§5) or governed by a schema
 * ([TSON-SCHEMA]); this module has no way to detect either from a bare token alone. Under a schema
 * every value is typed by its position or by its tag, so there is nothing left for this to decide
 * — including at a `value`-typed facet, which is read under the atom the slot stands for
 * ([TSON-SCHEMA] §5.2) rather than falling back here.
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

/**
 * Every quoted token, and every unquoted token that isn't a boolean keyword or a number (§4.4) --
 * `null` included: it is an ordinary unquoted token with no keyword status of its own, like
 * `frobnicate`, and resolves here to the string `"null"`. Absence has one spelling, the sentinel
 * `_` (§2.9), which is lexical and never a token this layer sees.
 */
export interface StringValue {
  readonly kind: 'string';
  readonly text: string;
}

/**
 * The result of base type resolution (§4): a token's identified base type. Identification only —
 * {@link NumberValue} wraps a {@link NumberForm} (the recognized grammar shape), not a bound host
 * numeric type; narrowing to one is `numberNarrowing.ts`'s separate, later job.
 *
 * Three classes, and no more (§4.5): a token's fall-through to string is total, so there is no
 * fourth "unrecognized" case to add one for.
 */
export type BaseValue = BooleanValue | NumberValue | StringValue;

/**
 * Resolves `token` per §4.5's fixed order: true/false, then the number grammar as a full-token
 * match, then string. A quoted token always resolves to string (§4.4) without attempting either
 * of the other two — form is consulted exactly once, here.
 */
export function resolveBaseType(token: BaseToken): BaseValue {
  if (token.form !== 'unquoted') {
    return { kind: 'string', text: token.text };
  }

  const text = token.text;
  if (text === 'true') {
    return { kind: 'boolean', value: true };
  }
  if (text === 'false') {
    return { kind: 'boolean', value: false };
  }

  const form = tryParseNumber(text);
  return form !== undefined ? { kind: 'number', form } : { kind: 'string', text };
}
