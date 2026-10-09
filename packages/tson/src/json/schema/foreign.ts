/**
 * How a read reaches a schema the document names *inside* itself -- [TSON-JSON] §8.5's scope push,
 * where a value at a scoped position leads with its own `$schema` and the type its `$type` names
 * has to be compiled before that value can be read.
 *
 * **Read-time, unlike every other name a reader resolves.** A compiled reader's children are wired
 * when the schema compiles, because the schema names all of them. A foreign schema is named by the
 * *document*, so which one it is cannot be known until the value arrives. What can be fixed in
 * advance is where to ask: {@link ForeignSchemas}, handed to the compile, is that lookup. Each
 * distinct identity a read pushes is compiled once per compile and cached from then on.
 *
 * A compile with no lookup behind it reports `SCHEMA_NOT_PERMITTED`: nothing was configured to
 * supply a foreign schema, which is a fact about this deployment and not a verdict on the
 * document. A lookup that answers `undefined` reports `SCHEMA_NOT_FOUND`; one that throws a fetch
 * failure reports that failure's own code. None of the five is a verdict (§8.1).
 */
import { diagnosticCodeForFetch, type DiagnosticCode } from '../../core/diagnostic.js';
import {
  TsonContentHashMismatchError,
  TsonNotImplementedError,
  TsonSchemaFetchError,
  TsonSchemaValidationError,
} from '../../core/errors.js';
import { canonicalizeIdentity } from '../../link/identity.js';
import type { LinkedSchema } from '../../link/link.js';
import type { JsonReadContext } from '../readContext.js';
import type { JsonCompiledSchema } from './compile.js';

/**
 * The linked schema registered under `uri`, or `undefined` where nothing supplies it. May throw
 * {@link TsonSchemaFetchError} to say *why* it could not (the failure's own `SCHEMA_*` code is
 * reported), or {@link TsonSchemaValidationError} for a schema that was supplied and is wrong.
 */
export type ForeignSchemas = (uri: string) => LinkedSchema | undefined;

/** What a scoped reader asks of the compile it belongs to. */
export interface ForeignLookup {
  /**
   * The compiled schema at `uri`, or `undefined` after reporting through `ctx` why it could not be
   * had. A fault in this library propagates as itself.
   */
  get(uri: string, ctx: JsonReadContext): JsonCompiledSchema | undefined;
}

/** Builds the lookup for one compile: `foreign` supplies linked schemas, `compile` turns one into readers. */
export function createForeignLookup(
  foreign: ForeignSchemas | undefined,
  compile: (linked: LinkedSchema) => JsonCompiledSchema,
): ForeignLookup {
  const compiled = new Map<string, JsonCompiledSchema>();

  function fail(
    ctx: JsonReadContext,
    code: DiagnosticCode,
    message: string,
    expected: string,
    uri: string,
  ): undefined {
    ctx.report(code, message, expected, uri);
    return undefined;
  }

  return {
    get(uri: string, ctx: JsonReadContext): JsonCompiledSchema | undefined {
      if (foreign === undefined) {
        fail(
          ctx,
          'SCHEMA_NOT_PERMITTED',
          `this read has no foreign-schema lookup configured, so the scope onto '${uri}' cannot ` +
            'be resolved (§8.5) -- compile through a registry that supplies one',
          'a schema this processor can obtain',
          uri,
        );
        return;
      }
      try {
        const identity = canonicalizeIdentity(uri);
        const cached = compiled.get(identity);
        if (cached !== undefined) return cached;
        const linked = foreign(uri);
        if (linked === undefined) {
          fail(
            ctx,
            'SCHEMA_NOT_FOUND',
            `no schema was supplied for '${uri}' (§8.5)`,
            'a schema this processor can obtain',
            uri,
          );
          return;
        }
        const built = compile(linked);
        compiled.set(identity, built);
        return built;
      } catch (error) {
        if (error instanceof TsonSchemaFetchError) {
          fail(
            ctx,
            diagnosticCodeForFetch(error.reason),
            error.message,
            'a schema this processor can obtain',
            uri,
          );
          return;
        }
        if (error instanceof TsonNotImplementedError) {
          fail(ctx, 'NOT_IMPLEMENTED', error.message, 'a schema this library can compile', uri);
          return;
        }
        if (
          error instanceof TsonSchemaValidationError ||
          error instanceof TsonContentHashMismatchError
        ) {
          fail(ctx, 'SCHEMA_ERROR', error.message, 'a resolvable schema', uri);
          return;
        }
        throw error;
      }
    },
  };
}
