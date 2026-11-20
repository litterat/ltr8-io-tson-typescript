/**
 * The [TSON-DATA] §9.1 and [TSON-SCHEMA] §11.5 resource limits: the whole table as one
 * {@link LimitsPolicy} (`spec/m/policy.tn`'s `policy.limits`, field for field and in the same
 * order, with the spec's defaults), the refusal every enforcement site raises for a counted
 * limit, and the options that configure it.
 *
 * §9.1 names eleven document-side limits and §11.5 adds five for the work resolving a schema does
 * on top of a document's own bytes, stated as a Class 2 MUST ("on the same terms, as part of the
 * same policy and reported through the same surfaces"). Each is a positive `int64` on the wire
 * (`policy.limit => !int64 ^ { min: 1 }`); a processor that holds one in a narrower type caps it
 * (§9.1), and this one holds every limit as a safe-integer `number`, capping a larger stated value
 * at {@link MAX_LIMIT}. Six limits are counted: nesting depth, in the token stream; and §11.5's
 * import closure, schema entries, alias chain, supertype chain and wait
 * depth, each at the site that already walks the thing it counts. The other ten are stated
 * thresholds, configured and reported by the same surfaces and not yet counted, so a document past
 * one of them is not refused for it.
 *
 * **Every recursive-descent layer here costs a host call frame per level**, so without a bound the
 * bound still exists: it is the host's own call stack, reported as an uncaught `RangeError:
 * Maximum call stack size exceeded` escaping a public API whose contract is a typed refusal with a
 * position. The Tier 2 event stream is the exception and needs no bound: it replaced recursion
 * with an explicit frame stack and walks a million levels without touching the host stack.
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
 * **Configuration is a code decision.** `maxNestingDepth` is the per-call and per-instance option
 * every reader already takes; every other limit is stated once on the instance, as
 * `Config.limits`. Lowering a limit is free while raising one is bounded by the host: the
 * recursion behind nesting depth is still real, and a caller who raises it past the host's own
 * stack gets a bare `RangeError` back. A limit is never read from the environment.
 */
import {
  TsonLimitRefusedError,
  TsonSchemaValidationError,
  type ResourceLimitName,
} from './errors.js';
import type { Position } from './position.js';

/** The limit name {@link nestingLimitRefusal} raises. */
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

// ── The table ───────────────────────────────────────────────────────────────────────────────────

/**
 * The widest limit this processor holds, 2^53 - 1: `policy.limit` is an `int64`, and a limit
 * stated above this is capped to it (§9.1, "a processor that holds one in a narrower host type
 * caps it").
 */
export const MAX_LIMIT = Number.MAX_SAFE_INTEGER;

export const IMPORT_CLOSURE_LIMIT: ResourceLimitName = 'import-closure';
export const SCHEMA_ENTRIES_LIMIT: ResourceLimitName = 'schema-entries';
export const ALIAS_CHAIN_LIMIT: ResourceLimitName = 'alias-chain';
export const SUPERTYPE_CHAIN_LIMIT: ResourceLimitName = 'supertype-chain';
export const WAIT_DEPTH_LIMIT: ResourceLimitName = 'wait-depth';

/** [TSON-SCHEMA] §11.5's default: schema documents reachable from one header through `!!import`. */
export const DEFAULT_MAX_IMPORT_CLOSURE = 64;
/** [TSON-SCHEMA] §11.5's default: declarations in one schema map. */
export const DEFAULT_MAX_SCHEMA_ENTRIES = 65_536;
/** [TSON-SCHEMA] §11.5's default: hops from a use site to a terminal entry (§8.3). */
export const DEFAULT_MAX_ALIAS_CHAIN = 64;
/** [TSON-SCHEMA] §11.5's default: length of one type's transitive supertype chain (§8.1). */
export const DEFAULT_MAX_SUPERTYPE_CHAIN = 64;
/** [TSON-SCHEMA] §11.5's default: the longest chain of waits one schema's resolution runs. */
export const DEFAULT_MAX_WAIT_DEPTH = 64;

/**
 * [TSON-DATA] §9.1's and [TSON-SCHEMA] §11.5's resource limits, as a value a caller can read
 * before writing a document rather than only discover by having one refused
 * (`Tson.processorPolicy.limits`, and `tson policy` on the command line).
 *
 * The members are `policy.tn`'s `policy.limits` in its order, named in camel case
 * (`max_wait_depth` is {@link maxWaitDepth}); `max_depth` is {@link maxNestingDepth}, the name the
 * readers' own option already carries. Every one is at least 1 and at most {@link MAX_LIMIT}.
 *
 * A limit refusal is not a verdict on the document: the bytes may be well-formed, valid, and
 * accepted in full by the next processor along. See {@link TsonLimitRefusedError}.
 */
export interface LimitsPolicy {
  /** `max_depth` -- the deepest a container may nest before the read is refused (§9.1), counted as containers open in the token stream so the refusal lands before any reader descends. A schema document counts the same way. */
  readonly maxNestingDepth: number;
  /** `max_token_length` -- one token's decoded text, in code points. */
  readonly maxTokenLength: number;
  /** `max_text_length` -- one value's text after escape processing, in code points. */
  readonly maxTextLength: number;
  /** `max_numeric_literal_length` -- the digits in one numeric token. */
  readonly maxNumericLiteralLength: number;
  /** `max_binary_size` -- one `!bytes` value's decoded octets. */
  readonly maxBinarySize: number;
  /** `max_document_size` -- the document's bytes. */
  readonly maxDocumentSize: number;
  /** `max_elements` -- the elements of one array or set. */
  readonly maxElements: number;
  /** `max_entries` -- the entries of one map. */
  readonly maxEntries: number;
  /** `max_fields` -- the fields of one record. */
  readonly maxFields: number;
  /** `max_annotations` -- the annotations on one value. */
  readonly maxAnnotations: number;
  /** `max_values` -- all values in one document, containers and scalars alike. */
  readonly maxValues: number;
  /** `max_import_closure` -- the threshold {@link importClosureLimitRefusal} checks against. */
  readonly maxImportClosure: number;
  /** `max_schema_entries` -- the threshold {@link schemaEntriesLimitRefusal} checks against. */
  readonly maxSchemaEntries: number;
  /** `max_alias_chain` -- the hops from a use site to a terminal entry: the threshold {@link aliasChainLimitRefusal} checks against, and the one the resolver's alias walk consults. */
  readonly maxAliasChain: number;
  /** `max_supertype_chain` -- the threshold {@link supertypeChainLimitRefusal} checks against. */
  readonly maxSupertypeChain: number;
  /**
   * `max_wait_depth` -- the longest chain of waits resolving one schema may run ([TSON-SCHEMA]
   * §11.5): an entry whose declaration is read against another entry of the same document waits
   * on that entry being ready, and that one on the next, so the chain counts the waits from an
   * entry to one that waits on nothing. An import is ready before the document's resolution
   * starts, so a wait ends at one. The threshold {@link waitDepthLimitRefusal} checks against.
   */
  readonly maxWaitDepth: number;
}

/** The limits a processor applies when a caller has stated none: every one at the spec's default. */
export const DEFAULT_LIMITS: LimitsPolicy = {
  maxNestingDepth: DEFAULT_MAX_NESTING_DEPTH,
  maxTokenLength: 1_048_576,
  maxTextLength: 1_048_576,
  maxNumericLiteralLength: 4_096,
  maxBinarySize: 16_777_216,
  maxDocumentSize: 16_777_216,
  maxElements: 1_048_576,
  maxEntries: 1_048_576,
  maxFields: 65_536,
  maxAnnotations: 64,
  maxValues: 16_777_216,
  maxImportClosure: DEFAULT_MAX_IMPORT_CLOSURE,
  maxSchemaEntries: DEFAULT_MAX_SCHEMA_ENTRIES,
  maxAliasChain: DEFAULT_MAX_ALIAS_CHAIN,
  maxSupertypeChain: DEFAULT_MAX_SUPERTYPE_CHAIN,
  maxWaitDepth: DEFAULT_MAX_WAIT_DEPTH,
};

/**
 * The limits a caller states beyond nesting depth, which keeps its own option
 * ({@link NestingLimitOptions.maxNestingDepth}) so that a limit has one spelling. A `bigint` is
 * accepted for a limit a policy document states as an `int64`; either form past {@link MAX_LIMIT}
 * is capped.
 */
export type LimitOverrides = Readonly<
  Partial<Record<Exclude<keyof LimitsPolicy, 'maxNestingDepth'>, number | bigint>>
>;

/** Accepted wherever a caller can state the limits, `Config` first. */
export interface LimitOptions extends NestingLimitOptions {
  /** Every limit beyond nesting depth, each defaulting to {@link DEFAULT_LIMITS}'s. */
  readonly limits?: LimitOverrides;
}

/**
 * `value` as the limit `name` holds: a positive integer, capped at {@link MAX_LIMIT}.
 *
 * @throws TsonSchemaValidationError if the value is not a positive integer. A limit of `0` admits
 *   nothing at all, and a non-integer or negative one is a configuration mistake that would
 *   otherwise show up as a document being rejected for a reason that has nothing to do with the
 *   document.
 */
function heldLimit(name: string, value: number | bigint): number {
  if (typeof value === 'bigint') {
    if (value < 1n) {
      throw new TsonSchemaValidationError(
        `${name} must be a positive integer, not ${String(value)}`,
      );
    }
    return value > BigInt(MAX_LIMIT) ? MAX_LIMIT : Number(value);
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new TsonSchemaValidationError(`${name} must be a positive integer, not ${String(value)}`);
  }
  return Math.min(value, MAX_LIMIT);
}

/**
 * The nesting depth `options` states, or the default.
 *
 * @throws TsonSchemaValidationError if the limit is not a positive integer.
 */
export function maxNestingDepthOf(options?: NestingLimitOptions): number {
  const limit = options?.maxNestingDepth;
  return limit === undefined ? DEFAULT_MAX_NESTING_DEPTH : heldLimit('maxNestingDepth', limit);
}

/**
 * The {@link LimitsPolicy} `options` states: every limit at its default but those stated.
 *
 * @throws TsonSchemaValidationError for a limit that is not a positive integer, or a name in
 *   `options.limits` that is no limit.
 */
export function limitsPolicyOf(options?: LimitOptions): LimitsPolicy {
  const held: Record<string, number> = { ...DEFAULT_LIMITS };
  held.maxNestingDepth = maxNestingDepthOf(options);
  for (const [name, value] of Object.entries(options?.limits ?? {}) as [
    string,
    number | bigint | undefined,
  ][]) {
    if (!Object.hasOwn(DEFAULT_LIMITS, name) || name === 'maxNestingDepth') {
      throw new TsonSchemaValidationError(`'${name}' is not a limit this processor configures`);
    }
    if (value !== undefined) held[name] = heldLimit(name, value);
  }
  return held as unknown as LimitsPolicy;
}

// ── The refusals ────────────────────────────────────────────────────────────────────────────────

/**
 * The refusal every enforcement site throws when a document nests past `limit` -- [TSON-DATA]
 * §9.1's "nesting depth" limit, applying to a schema document as a document too ([TSON-SCHEMA]
 * §11.5). Named with the limit and its configured threshold, as §8.1's fifth outcome requires.
 *
 * `position`, when the throw site has one, is where the limit was reached -- the token that opened
 * one container too many; `cause`, when given, is the lower-level failure this refusal replaces.
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

/** The refusal thrown when a schema's own `!!import` closure reaches more than `limit` distinct schema documents. `documentId` is the `!!id` of the schema being resolved -- the walk's own starting point, since the closure is counted as a whole rather than link by link. */
export function importClosureLimitRefusal(
  limit: number,
  documentId: string,
): TsonLimitRefusedError {
  return new TsonLimitRefusedError(
    `resolving '${documentId}' reaches more than ${String(limit)} schema documents through ` +
      `'!!import', exceeding the configured '${IMPORT_CLOSURE_LIMIT}' limit of ` +
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

/** The refusal thrown when following an alias chain (§8.3) from `name` takes more than `limit` hops without reaching a terminal entry. */
export function aliasChainLimitRefusal(limit: number, name: string): TsonLimitRefusedError {
  return new TsonLimitRefusedError(
    `'${name}' does not reach a terminal entry within ${String(limit)} alias hops, ` +
      `exceeding the configured '${ALIAS_CHAIN_LIMIT}' limit of ${String(limit)} ` +
      '([TSON-SCHEMA] §8.3, §11.5)',
    { limit: ALIAS_CHAIN_LIMIT, configuredThreshold: limit },
  );
}

/** The refusal thrown when `name`'s own transitive supertype chain (§8.1) grows past `limit` entries. */
export function supertypeChainLimitRefusal(limit: number, name: string): TsonLimitRefusedError {
  return new TsonLimitRefusedError(
    `'${name}' accumulates more than ${String(limit)} transitive supertypes, exceeding the ` +
      `configured '${SUPERTYPE_CHAIN_LIMIT}' limit of ${String(limit)} ([TSON-SCHEMA] §8.1, §11.5)`,
    { limit: SUPERTYPE_CHAIN_LIMIT, configuredThreshold: limit },
  );
}

/**
 * The refusal thrown when resolving a schema runs a chain of more than `limit` waits, reported at
 * `entry`, the entry whose chain is too long ([TSON-SCHEMA] §11.5). Raised as the resolver makes
 * entries ready, so the verdict is the same in any declaration order.
 */
export function waitDepthLimitRefusal(limit: number, entry: string): TsonLimitRefusedError {
  return new TsonLimitRefusedError(
    `'${entry}' waits on a chain of more than ${String(limit)} entries to be ready, exceeding ` +
      `the configured '${WAIT_DEPTH_LIMIT}' limit of ${String(limit)} ([TSON-SCHEMA] §11.5)`,
    { limit: WAIT_DEPTH_LIMIT, configuredThreshold: limit },
  );
}
