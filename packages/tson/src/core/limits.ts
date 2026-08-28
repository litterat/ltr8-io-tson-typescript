/**
 * The one resource bound this library imposes on a document, and the option that configures it.
 *
 * [TSON-DATA] §9.1 names deeply nested structures a denial-of-service vector and asks an
 * implementation to bound them. Every recursive-descent layer here — the Tier 3 data parser, the
 * schemaless tree reader, the schema grammar and the data-value grammar the schema grammar
 * embeds — costs a host call frame per level, so without a bound the bound still exists: it is
 * the host's own call stack, reached somewhere around 750 levels and reported as an uncaught
 * `RangeError: Maximum call stack size exceeded` escaping a public API whose contract is a
 * `TsonParseError` with a position.
 *
 * The Tier 2 event stream is the exception and needs no bound: it replaced recursion with an
 * explicit frame stack and walks a million levels without touching the host stack.
 *
 * **Configurable, because §9.1 asks for a limit rather than for this number.** A service reading
 * documents from the network wants a much smaller one; a build tool processing a machine-generated
 * document may legitimately want a larger one.
 *
 * **Lowering it is free; raising it is bounded by the host.** The default is chosen to sit well
 * under where a host stack gives out -- measured at roughly 750 levels for the Tier 3 parser --
 * and far past anything written by hand or by a well-behaved generator. A caller who raises it
 * past the host's own limit gets the `RangeError` back, because the recursion is still real; the
 * proper fix for that is making these tiers iterative the way the Tier 2 event stream already is,
 * not a larger number here.
 */
import { TsonSchemaValidationError } from './errors.js';

/** The nesting depth a document may reach when a caller states no limit of its own. */
export const DEFAULT_MAX_NESTING_DEPTH = 512;

/** Accepted wherever a caller can state §9.1's nesting bound. */
export interface NestingLimitOptions {
  /**
   * The deepest a document may nest before it is refused (§9.1). Defaults to
   * {@link DEFAULT_MAX_NESTING_DEPTH}.
   *
   * Counted in levels of *structural* nesting — a record, map or array inside another — not in
   * tokens or annotations. A document at exactly this depth is accepted; one level further is
   * refused, with a position.
   */
  readonly maxNestingDepth?: number;
}

/**
 * The limit `options` states, or the default.
 *
 * @throws TsonSchemaValidationError if the limit is not a positive integer. A limit of `0` would
 *   refuse every document including an empty one, and a non-integer or negative one is a
 *   configuration mistake that would otherwise show up as a document being rejected for a reason
 *   that has nothing to do with the document.
 */
export function maxNestingDepthOf(options?: NestingLimitOptions): number {
  const limit = options?.maxNestingDepth;
  if (limit === undefined) return DEFAULT_MAX_NESTING_DEPTH;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new TsonSchemaValidationError(
      `maxNestingDepth must be a positive integer, not ${String(limit)}`,
    );
  }
  return limit;
}

/** The message every layer reports when a document nests past its limit, so all of them say the same thing. */
export function nestingLimitMessage(limit: number): string {
  return `document nests deeper than ${String(limit)} levels (§9.1)`;
}

/** The `expected` half of that report, in the operator form `core/errors.ts` documents. */
export function nestingLimitExpectation(limit: number): string {
  return `at most ${String(limit)} levels of nesting`;
}
