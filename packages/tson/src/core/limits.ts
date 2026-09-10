/**
 * The [TSON-DATA] §9.1 / [TSON-SCHEMA] §11.5 resource limits this library enforces -- document
 * nesting depth, plus §11.5's own five schema-side counters -- the refusal every enforcement site
 * raises for each, and (nesting depth alone) the option that configures it.
 *
 * §9.1 names twelve document-side limits with defaults; [TSON-SCHEMA] §11.5 adds five more for
 * the work resolving a schema does on top of a document's own bytes, and states them as a Class 2
 * MUST ("on the same terms, as part of the same policy and reported through the same surfaces").
 * This library builds the mechanism, one of the twelve document-side limits (nesting depth,
 * matching the pinned Java reference's own coverage there), and all five of §11.5's schema-side
 * limits (§11.5 has no Java analogue to match coverage against -- building all five is this
 * port's own reading of §11.5's MUST). `STATUS.md`'s known gaps names the other eleven
 * document-side limits as not yet enforced.
 *
 * **Every recursive-descent layer here costs a host call frame per level**, so without a bound the
 * bound still exists: it is the host's own call stack, reached somewhere around 750 levels and
 * reported as an uncaught `RangeError: Maximum call stack size exceeded` escaping a public API
 * whose contract is a typed refusal with a position. The Tier 2 event stream is the exception and
 * needs no bound: it replaced recursion with an explicit frame stack and walks a million levels
 * without touching the host stack.
 *
 * **Exceeding a limit is [TSON-DATA] §8.1's fifth outcome, not a parse or resolver error.** §9.1:
 * "A processor that exceeds a limit MUST report a clear refusal naming the limit and the
 * configured threshold rather than failing with an out-of-memory condition, a stack overflow, or
 * any other host-language fault... A limit refusal... MUST be distinguishable from the four
 * categories and MUST NOT be reported as a validity error." Each `*LimitRefusal` function below
 * builds exactly that refusal (`core/errors.ts`'s {@link TsonLimitRefusedError}); every
 * enforcement site throws it directly rather than routing it through a `DiagnosticsReceiver`
 * first, collecting read included -- everything past the point a limit is exceeded is unreachable
 * by construction, so there is nothing further a collecting read or resolve could gather.
 *
 * **Nesting depth alone is configurable per instance** (`config.ts`'s own `Config.maxNestingDepth`),
 * because §9.1 asks for a limit rather than for this number: a service reading documents from the
 * network wants a much smaller one, a build tool processing a machine-generated document may
 * legitimately want a larger one, and lowering it is free while raising it is bounded by the host
 * (the recursion behind it is still real -- a caller who raises it past the host's own limit gets
 * a bare `RangeError` back; the proper fix is making these tiers iterative the way the Tier 2
 * event stream already is, not a larger number here). **The five schema-side limits enforce at
 * their §11.5 defaults and are not independently configurable today** -- a narrower scope than
 * nesting depth's, recorded here rather than silently matched to it: threading a per-instance
 * override through schema resolution's own dependency-injected passes (`schemaResolver.ts`,
 * `definitionResolver.ts`, `templates.ts`, `referenceChain.ts`) is real additional wiring this
 * pass does not spend, and `LimitsPolicy` still reports what each one enforces -- reachable with
 * no document in hand -- even though that figure cannot be changed by a caller yet.
 */
import {
  TsonLimitRefusedError,
  TsonSchemaValidationError,
  type ResourceLimitName,
} from './errors.js';
import type { Position } from './position.js';

/** The limit name {@link nestingLimitRefusal} raises -- see this module's own top note on the other eleven §9.1 document-side limits it does not build. */
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

// ── [TSON-SCHEMA] §11.5's five schema-side limits ───────────────────────────────────────────────
//
// Each is a counter at a site that already walks the thing it counts: the import graph
// (`config.ts`'s own `resolveAgainstRegistry`), the resolved schema map (the same site), a
// reference chain (`referenceChain.ts`'s own `walk`), a transitive supertype chain
// (`definitionResolver.ts`'s own `resolveComposition`/`refineOnto`), and nested open synthetics
// closed for one application (`templates.ts`'s own `close`, which already carried a depth guard
// under a different name and error class before this one existed). None is configurable per
// instance today -- see this module's own top note.

export const IMPORT_CLOSURE_LIMIT: ResourceLimitName = 'import-closure';
/** [TSON-SCHEMA] §11.5's own default: schema documents reachable from one header through `!!meta`/`!!import`. */
export const DEFAULT_MAX_IMPORT_CLOSURE = 64;

export const SCHEMA_ENTRIES_LIMIT: ResourceLimitName = 'schema-entries';
/** [TSON-SCHEMA] §11.5's own default: declarations in one schema map, synthetic and instantiation entries included. */
export const DEFAULT_MAX_SCHEMA_ENTRIES = 65_536;

export const REFERENCE_CHAIN_LIMIT: ResourceLimitName = 'reference-chain';
/** [TSON-SCHEMA] §11.5's own default: hops from a use site to a terminal entry (§8.3). */
export const DEFAULT_MAX_REFERENCE_CHAIN = 64;

export const SUPERTYPE_CHAIN_LIMIT: ResourceLimitName = 'supertype-chain';
/** [TSON-SCHEMA] §11.5's own default: length of one entry's transitive `supertypes` (§8.1). */
export const DEFAULT_MAX_SUPERTYPE_CHAIN = 64;

export const MATERIALISATION_DEPTH_LIMIT: ResourceLimitName = 'materialisation-depth';
/** [TSON-SCHEMA] §11.5's own default: nested open synthetics closed for one application (§5.10, §8.2). */
export const DEFAULT_MAX_MATERIALISATION_DEPTH = 64;

/** The refusal thrown when a schema's own `!!meta`/`!!import` closure reaches more than `limit` distinct schema documents. `documentId` is the `!!id` of the schema being resolved -- the walk's own starting point, not necessarily where the limit was tipped over, since the closure is counted as a whole rather than link by link. */
export function importClosureLimitRefusal(
  limit: number,
  documentId: string,
): TsonLimitRefusedError {
  return new TsonLimitRefusedError(
    `resolving '${documentId}' reaches more than ${String(limit)} schema documents through ` +
      `'!!meta'/'!!import', exceeding the configured '${IMPORT_CLOSURE_LIMIT}' limit of ` +
      `${String(limit)} ([TSON-SCHEMA] §11.5)`,
    { limit: IMPORT_CLOSURE_LIMIT, configuredThreshold: limit },
  );
}

/** The refusal thrown when a schema's own resolved map holds more than `limit` entries, synthetic and instantiation entries included. */
export function schemaEntriesLimitRefusal(
  limit: number,
  documentId: string,
): TsonLimitRefusedError {
  return new TsonLimitRefusedError(
    `'${documentId}' resolves to more than ${String(limit)} declarations (synthetic and ` +
      `instantiation entries included), exceeding the configured '${SCHEMA_ENTRIES_LIMIT}' limit ` +
      `of ${String(limit)} ([TSON-SCHEMA] §11.5)`,
    { limit: SCHEMA_ENTRIES_LIMIT, configuredThreshold: limit },
  );
}

/** The refusal thrown when following a reference chain (§8.3) from `name` takes more than `limit` hops without reaching a terminal entry. */
export function referenceChainLimitRefusal(limit: number, name: string): TsonLimitRefusedError {
  return new TsonLimitRefusedError(
    `'${name}' does not reach a terminal entry within ${String(limit)} reference hops, ` +
      `exceeding the configured '${REFERENCE_CHAIN_LIMIT}' limit of ${String(limit)} ` +
      '([TSON-SCHEMA] §8.3, §11.5)',
    { limit: REFERENCE_CHAIN_LIMIT, configuredThreshold: limit },
  );
}

/** The refusal thrown when `name`'s own transitive `supertypes` (§8.1) grows past `limit` entries. */
export function supertypeChainLimitRefusal(limit: number, name: string): TsonLimitRefusedError {
  return new TsonLimitRefusedError(
    `'${name}' accumulates more than ${String(limit)} transitive supertypes, exceeding the ` +
      `configured '${SUPERTYPE_CHAIN_LIMIT}' limit of ${String(limit)} ([TSON-SCHEMA] §8.1, §11.5)`,
    { limit: SUPERTYPE_CHAIN_LIMIT, configuredThreshold: limit },
  );
}

/** The refusal thrown when materialising `head`'s own application nests more than `limit` open synthetics deep before any of them closes (§5.10, §8.2). */
export function materialisationDepthLimitRefusal(
  limit: number,
  head: string,
): TsonLimitRefusedError {
  return new TsonLimitRefusedError(
    `'${head}<...>' does not close within ${String(limit)} nested instantiations, exceeding the ` +
      `configured '${MATERIALISATION_DEPTH_LIMIT}' limit of ${String(limit)} ([TSON-SCHEMA] §5.10, §11.5)`,
    { limit: MATERIALISATION_DEPTH_LIMIT, configuredThreshold: limit },
  );
}

/**
 * [TSON-DATA] §9.1's resource-limits policy, as far as this library enforces it -- reported beside
 * `unicode/policy.ts`'s `ProcessorPolicy` (§8.2's identifier and token policies) on the same
 * terms: reachable with no document in hand, so a sender can learn what will be accepted before
 * writing rather than one round trip after (`config.ts`'s own `Tson.limitsPolicy`).
 *
 * The five [TSON-SCHEMA] §11.5 fields are each fixed at their own spec default -- see this
 * module's own top note on why they are not yet independently configurable -- so they are
 * constant across every instance today; they are still carried on every instance's own policy
 * rather than left for a caller to look up separately, since a policy is read as a whole (the
 * same reason `ProcessorPolicy` bundles the identifier and token surfaces together).
 */
export interface LimitsPolicy {
  /** The configured threshold {@link nestingLimitRefusal} checks against -- {@link maxNestingDepthOf}'s own result, bundled here for a caller reading the whole policy at once. */
  readonly maxNestingDepth: number;
  /** The configured threshold {@link importClosureLimitRefusal} checks against. */
  readonly maxImportClosure: number;
  /** The configured threshold {@link schemaEntriesLimitRefusal} checks against. */
  readonly maxSchemaEntries: number;
  /** The configured threshold {@link referenceChainLimitRefusal} checks against. */
  readonly maxReferenceChain: number;
  /** The configured threshold {@link supertypeChainLimitRefusal} checks against. */
  readonly maxSupertypeChain: number;
  /** The configured threshold {@link materialisationDepthLimitRefusal} checks against. */
  readonly maxMaterialisationDepth: number;
}

/** Builds a {@link LimitsPolicy} from `options` (default: {@link DEFAULT_MAX_NESTING_DEPTH}). The five §11.5 schema-side fields are always their own spec default -- see {@link LimitsPolicy}'s own doc. */
export function limitsPolicyOf(options?: NestingLimitOptions): LimitsPolicy {
  return {
    maxNestingDepth: maxNestingDepthOf(options),
    maxImportClosure: DEFAULT_MAX_IMPORT_CLOSURE,
    maxSchemaEntries: DEFAULT_MAX_SCHEMA_ENTRIES,
    maxReferenceChain: DEFAULT_MAX_REFERENCE_CHAIN,
    maxSupertypeChain: DEFAULT_MAX_SUPERTYPE_CHAIN,
    maxMaterialisationDepth: DEFAULT_MAX_MATERIALISATION_DEPTH,
  };
}
