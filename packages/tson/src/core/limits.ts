/**
 * The one [TSON-DATA] §9.1 / [TSON-SCHEMA] §11.5 resource limit this library enforces --
 * nesting depth -- the option that configures it, and the refusal every enforcement site raises
 * for it.
 *
 * §9.1 names twelve limits with defaults, and [TSON-SCHEMA] §11.5 adds five more for the work
 * resolving a schema does on top of a document's own bytes; this library builds the mechanism and
 * this one limit, matching the pinned Java reference's own coverage. `STATUS.md`'s known gaps
 * names the other sixteen, with their §9.1/§11.5 defaults, as not yet enforced.
 *
 * **Every recursive-descent layer here costs a host call frame per level**, so without a bound the
 * bound still exists: it is the host's own call stack, reached somewhere around 750 levels and
 * reported as an uncaught `RangeError: Maximum call stack size exceeded` escaping a public API
 * whose contract is a typed refusal with a position. The Tier 2 event stream is the exception and
 * needs no bound: it replaced recursion with an explicit frame stack and walks a million levels
 * without touching the host stack. `[TSON-SCHEMA] §11.5`'s own materialisation-depth, reference-
 * chain and supertype-chain limits are separate counters over the *resolved schema graph*, not
 * this one, which is why they are not this module's to build even though they share its default.
 *
 * **Exceeding the limit is [TSON-DATA] §8.1's fifth outcome, not a parse or read error.** §9.1:
 * "A processor that exceeds a limit MUST report a clear refusal naming the limit and the
 * configured threshold rather than failing with an out-of-memory condition, a stack overflow, or
 * any other host-language fault... A limit refusal... MUST be distinguishable from the four
 * categories and MUST NOT be reported as a validity error." {@link nestingLimitRefusal} builds
 * exactly that refusal (`core/errors.ts`'s {@link TsonLimitRefusedError}); every enforcement site
 * throws it directly rather than routing it through a `DiagnosticsReceiver` first, collecting read
 * included -- everything past the point the limit is exceeded is unreachable by construction, so
 * there is nothing further a collecting read could gather.
 *
 * **Configurable, because §9.1 asks for a limit rather than for this number.** A service reading
 * documents from the network wants a much smaller one; a build tool processing a machine-generated
 * document may legitimately want a larger one. **Lowering it is free; raising it is bounded by the
 * host**, because the recursion behind it is still real -- a caller who raises it past the host's
 * own limit gets a bare `RangeError` back. The proper fix for that is making these tiers iterative
 * the way the Tier 2 event stream already is, not a larger number here.
 */
import {
  TsonLimitRefusedError,
  TsonSchemaValidationError,
  type ResourceLimitName,
} from './errors.js';
import type { Position } from './position.js';

/** The one limit name {@link nestingLimitRefusal} ever raises -- see this module's own top note on the other sixteen §9.1/§11.5 limits it does not build. */
export const NESTING_DEPTH_LIMIT: ResourceLimitName = 'nesting-depth';

/** The nesting depth a document may reach when a caller states no limit of its own -- [TSON-DATA] §9.1's own default for this limit. */
export const DEFAULT_MAX_NESTING_DEPTH = 64;

/** Accepted wherever a caller can state §9.1's nesting bound. */
export interface NestingLimitOptions {
  /**
   * The deepest a document may nest before it is refused (§9.1). Defaults to
   * {@link DEFAULT_MAX_NESTING_DEPTH}.
   *
   * Counted in levels of *structural* nesting — a record, map or array inside another — not in
   * tokens or annotations. A document at exactly this depth is accepted; one level further is
   * refused, with a position, as {@link nestingLimitRefusal} describes.
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

/**
 * [TSON-DATA] §9.1's resource-limits policy, as far as this library enforces it -- reported beside
 * `unicode/policy.ts`'s `ProcessorPolicy` (§8.2's identifier and token policies) on the same
 * terms: reachable with no document in hand, so a sender can learn what will be accepted before
 * writing rather than one round trip after (`config.ts`'s own `Tson.limitsPolicy`).
 */
export interface LimitsPolicy {
  /** The configured threshold {@link nestingLimitRefusal} checks against -- {@link maxNestingDepthOf}'s own result, bundled here for a caller reading the whole policy at once. */
  readonly maxNestingDepth: number;
}

/** Builds a {@link LimitsPolicy} from `options` (default: {@link DEFAULT_MAX_NESTING_DEPTH}). */
export function limitsPolicyOf(options?: NestingLimitOptions): LimitsPolicy {
  return { maxNestingDepth: maxNestingDepthOf(options) };
}

/**
 * The refusal every enforcement site throws when a document nests past `limit` -- [TSON-DATA]
 * §9.1's "nesting depth" limit, applying to a schema document as a document too ([TSON-SCHEMA]
 * §11.5: "the document-side counters above apply to a schema document as a document"). Named with
 * the limit and its configured threshold, as §8.1's fifth outcome requires.
 *
 * `position`, when the throw site has one, is where the limit was reached -- the token that opened
 * one container too many; `cause`, when given, is the lower-level failure this refusal replaces
 * (never a `TsonReadError`/`TsonParseError` that already named the same overrun, since no
 * enforcement site here builds one of those for this limit -- see `TsonLimitRefusedError`'s
 * own doc).
 */
export function nestingLimitRefusal(
  limit: number,
  position?: Position,
  cause?: unknown,
): TsonLimitRefusedError {
  return new TsonLimitRefusedError(
    `the document nests deeper than ${String(limit)} levels, exceeding the configured ` +
      `'${NESTING_DEPTH_LIMIT}' limit of ${String(limit)} (§9.1, [TSON-SCHEMA] §11.5)`,
    {
      limit: NESTING_DEPTH_LIMIT,
      configuredThreshold: limit,
      ...(position === undefined ? {} : { position }),
      ...(cause === undefined ? {} : { cause }),
    },
  );
}
