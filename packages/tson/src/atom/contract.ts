/**
 * The built-in vocabulary atom parsing contract -- the port of `atom/AtomType.java`.
 *
 * **Atom parsing is ordinary synchronous code.** Per PORT-PLAN.md's first architectural decision,
 * the read stack is suspendable-but-sync-shaped from the lexer up through `TypeReader` (see
 * `reader/contracts.ts`), because a document can arrive one chunk at a time and memory must stay
 * proportional to nesting depth. That reasoning stops at the token boundary: by the time an
 * {@link AtomType} sees a token, the lexer has already produced its complete decoded text --
 * there is nothing left to starve on. `atom/`, `base/`, `resolver/` and `link/` all run on
 * already-lexed text and stay ordinary sync code (PORT-PLAN.md), so {@link AtomType.read}/{@link
 * AtomType.write} are plain functions, not `Task`-returning generators.
 *
 * `AtomToken` is its own minimal shape rather than `ast/value.ts`'s `TokenValue`: `atom/` is a
 * leaf layer with no schema or document-tree concept of its own, and `TokenValue` is one member of
 * `ast/`'s tree-shaped `CoreValue` union -- reusing it would pull that whole concept in for the
 * sake of the two fields this contract actually needs. Its `form` field reuses `TokenForm` directly
 * from `lexer/token.ts`, the single canonical definition `ast/value.ts`'s own `TokenValue.form`
 * reuses too, rather than redeclaring a third copy of the same three-way distinction.
 */

// These two are referenced only from TSDoc {@link} tags below, which the unused-vars rule
// cannot see. The import is what makes those links resolve in an editor.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type { TsonAtomParseError, TsonAtomValidationError } from '../core/errors.js';
import type { TokenForm } from '../lexer/token.js';

/**
 * The already-lexed token text an {@link AtomType} parses -- `text` is the token's fully decoded
 * content (escapes processed, multi-line whitespace stripped), exactly what the lexer's own token
 * type already provides; `form` records which of the three token kinds produced it.
 */
export interface AtomToken {
  readonly text: string;
  readonly form: TokenForm;
}

/**
 * A built-in vocabulary atom's parsing contract (§5): which tokens it accepts, what host value
 * results, and the inverse. One implementation per meta-kernel/meta type constructor the built-in
 * vocabulary surfaces (e.g. `integer_type` backs the `int32`/`int64`/... family) -- a single
 * instance is a fully-parameterised *instance* of that constructor, mirroring the schema's own
 * constructor/instance split exactly as `AtomType.java`'s own doc describes.
 *
 * Unlike the Java original, there is no second `read(token, target)` overload for narrowing to a
 * caller-chosen host representation: that overload exists in Java to let a caller ask for `int`
 * instead of `Integer`/`Short`/`byte` without a caller-side table of which method produces which
 * primitive, a distinction that exists only because Java has multiple boxed/primitive
 * representations of one logical value to choose between. `T` here is already the one host type
 * this atom produces; a caller wanting a *different* host representation composes this binding
 * behind a `bridge()` (`bind/binding.ts`'s `BridgeBinding`) instead, which is exactly what that
 * combinator is for.
 *
 * **The spec's own split between two failure shapes is load-bearing, not a nicety**: a token that
 * is not shaped like the type at all -- malformed digits, a non-hex `!binary` body, an unparseable
 * `!uuid` -- is a {@link TsonAtomParseError}; a token that is correctly shaped but whose value falls
 * outside a constraint the schema declares (an `int32` literal that overflows 32 bits, a `date`
 * before a declared `minimum`) is a {@link TsonAtomValidationError}. The conformance suite asserts
 * these two categories separately, so an implementation that raises the wrong one for a given
 * vector is a real conformance failure, not merely an imprecise message.
 */
export interface AtomType<T> {
  /**
   * Parse `token` into this atom's own canonical host value.
   *
   * @throws {@link TsonAtomParseError} when `token` is not shaped like this type at all.
   * @throws {@link TsonAtomValidationError} when `token` is shaped correctly but its value falls
   *   outside a constraint this atom's own instance declares.
   */
  read(token: AtomToken): T;

  /**
   * `read`'s inverse: the token text that would read back to a value equivalent to `value`. Never
   * quoted and never carrying a type-ref -- both are a caller's structural concern (how the token
   * is framed in a larger document), not this atom's.
   */
  write(value: T): string;
}
