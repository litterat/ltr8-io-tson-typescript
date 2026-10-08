/**
 * meta.tn's `scoped` constructor ([TSON-SCHEMA] §7.8): the open sum, where the value names its own
 * type and the instance names the namespaces that name may be drawn from ([TSON-JSON] §8.5). One
 * reader serves every instance -- core's `declared`, `extern` and `dynamic`, and every narrowing
 * `extern_of` or `extern_type` materialises -- because what separates them is two constraint
 * values, `scope` and `schemas`, and not a shape. It selects a reader and builds nothing.
 *
 * **The leading members pick the cell** ({@link lead}). An annotation object leading with
 * `$schema` is EXTERN; one leading with `$type` alone is LOCAL; any other value -- a bare scalar,
 * an array, an object with no reserved member -- names no type, and is a validation error in every
 * mode, the position promising no type for it to be read as. A cell the instance's `scope` does not
 * hold refuses the value it would have taken, as a validation error: §8.5 owns the cell rule at a
 * scoped position, and the resolver error for a `$schema` (`SCOPE_NOT_ADMITTED`) reaches only
 * positions that are not scoped.
 *
 * **LOCAL is wired at compile and EXTERN is not.** A `scoped` entry belongs to one schema, so every
 * name its governing namespace holds is a route resolved when the schema compiles. Which foreign
 * schema an EXTERN value names is the document's choice, so it is looked up as the value arrives
 * ({@link ForeignLookup}) -- a schema nothing would supply is one of the five `SCHEMA_*` codes,
 * never a verdict.
 *
 * **Opening the scope consumes `$schema`** ({@link consumeLeadingMember}). What is left is an
 * annotation object led by `$type` in the foreign namespace, which the foreign type's reader reads
 * as it reads any tagged value of its own; everything below it resolves in that schema by
 * construction, and the scope pops by returning. A `$schema` anywhere inside the value is refused
 * by the reader that meets it, exactly as at any position that is not scoped.
 *
 * **Streaming holds.** The lead rule bounds what is buffered: at most `$schema`, `$type` and their
 * two scalar values are held before dispatch.
 */
import type { SchemaLocation } from '../../core/diagnostic.js';
import type { Task } from '../../io/bytes.js';
import { canonicalizeIdentity } from '../../link/identity.js';
import type { Scoped } from '../../schema/meta/typedef.js';
import { consumeLeadingMember, type JsonReadContext } from '../readContext.js';
import { skipNextValue } from './eventSkip.js';
import type { ForeignLookup } from './foreign.js';
import { nameHygieneRefuses } from './nameHygiene.js';
import { lead as leadOf, leadPresent, SCHEMA, type Lead } from './reservedMembers.js';
import { routeTo, type Route } from './route.js';
import type { JsonTypeReader } from './types.js';

const UNTYPED_EXPECTED = 'an annotation object naming the value’s type';

export interface ScopedOptions {
  readonly displayName: string;
  readonly body: Scoped;
  /** Every name the governing namespace holds. */
  readonly entries: ReadonlyMap<string, unknown>;
  readonly schemaLocation: SchemaLocation;
  readonly resolve: (name: string) => JsonTypeReader;
  readonly foreign: ForeignLookup;
}

/**
 * `uri`'s canonical identity, or `uri` itself where it is not one: an uninstantiated template's
 * parameter name stands in a `schemas` key, and no document can name it, so it simply never matches.
 */
function identityOrSelf(uri: string): string {
  try {
    return canonicalizeIdentity(uri);
  } catch {
    return uri;
  }
}

/** Builds the reader for one `scoped` entry. */
export function buildScopedReader(options: ScopedOptions): JsonTypeReader {
  const { displayName, body, entries, schemaLocation, resolve, foreign } = options;

  const local = new Map<string, Route>();
  if (body.scope.includes('LOCAL')) {
    for (const name of entries.keys())
      local.set(
        name,
        routeTo(() => resolve(name)),
      );
  }

  // `schemas`, keyed by canonical identity ([TSON-DATA] §2.2.1): an empty map means "any type".
  const admittedSchemas = new Map<string, readonly string[]>();
  for (const [uri, types] of body.schemas ?? []) {
    admittedSchemas.set(identityOrSelf(uri), types);
  }
  const admittedNames = (): string => [...admittedSchemas.keys()].join(', ');

  function* abandon(
    ctx: JsonReadContext,
    code: 'VALIDATION_ERROR' | 'UNKNOWN_TYPE',
    message: string,
    expected: string,
    actual: string,
  ): Task<undefined> {
    ctx.report(code, message, expected, actual);
    yield* skipNextValue(ctx);
    return undefined;
  }

  const untyped =
    `'${displayName}' is a scoped type -- the value names its own type, so it must be an ` +
    "annotation object leading with '$type' (§8.5)";

  /** §8.5: a value at a scoped position names its own type, and an annotation object with no `$type` does not. */
  function* missingType(ctx: JsonReadContext): Task<undefined> {
    return yield* abandon(
      ctx,
      'VALIDATION_ERROR',
      `'${displayName}' is a scoped type -- the value names its own type, so its annotation ` +
        "object requires a '$type' (§8.5)",
      "a '$type' naming the value’s own type",
      'no $type',
    );
  }

  /** A value naming a type in the governing namespace: `$type` alone, resolved as at any other position. */
  function* readLocal(ctx: JsonReadContext, lead: Lead): Task<unknown> {
    if (!body.scope.includes('LOCAL')) {
      return yield* abandon(
        ctx,
        'VALIDATION_ERROR',
        `'${displayName}' takes a value from a foreign schema, so the value must lead with ` +
          "'$schema' naming the schema its type comes from (§8.5)",
        "an annotation object leading with '$schema'",
        'no $schema',
      );
    }
    if (lead.type === undefined) return yield* missingType(ctx);
    const route = local.get(lead.type);
    if (route === undefined) {
      if (!nameHygieneRefuses(ctx, lead.type)) {
        ctx.report(
          'UNKNOWN_TYPE',
          `'${lead.type}' is not a type this schema declares or imports, and '${displayName}' ` +
            "resolves a value's own type name there (§8.5)",
          'a type declared by the governing schema',
          lead.type,
        );
      }
      yield* skipNextValue(ctx);
      return undefined;
    }
    return yield* route.read(ctx, lead);
  }

  /** §8.5's EXTERN cell: `$schema` names the schema, `$type` the type within it, and the foreign schema's compiled reader validates the value in full. */
  function* readExtern(ctx: JsonReadContext, lead: Lead): Task<unknown> {
    const uri = lead.schemaRef;
    if (!body.scope.includes('EXTERN')) {
      return yield* abandon(
        ctx,
        'VALIDATION_ERROR',
        `'${displayName}' takes a type this schema declares or imports, so a value here cannot ` +
          `open a scope${uri === undefined ? '' : ` onto '${uri}'`} (§8.5)`,
        "an annotation object carrying no '$schema'",
        SCHEMA,
      );
    }
    if (uri === undefined) {
      ctx
        .field(SCHEMA)
        .report(
          'TYPE_MISMATCH',
          "'$schema' holds a schema reference, which is a string (§3.2)",
          'a string',
          'not a string',
        );
      yield* skipNextValue(ctx);
      return undefined;
    }
    let identity: string;
    try {
      identity = canonicalizeIdentity(uri);
    } catch {
      return yield* abandon(
        ctx,
        'VALIDATION_ERROR',
        `'${uri}' is not a schema identity (§8.5, [TSON-DATA] §2.2.1)`,
        'a schema identity',
        uri,
      );
    }
    // Missing, `schemas` is "any foreign schema"; present, it is a closed set, matched by
    // canonical identity so a pinned key and an unpinned reference are one schema (§2.2.1).
    if (admittedSchemas.size > 0 && !admittedSchemas.has(identity)) {
      return yield* abandon(
        ctx,
        'VALIDATION_ERROR',
        `'${displayName}' admits values from ${admittedNames()}, and '${uri}' is not one of them`,
        `one of ${admittedNames()}`,
        uri,
      );
    }
    if (lead.type === undefined) return yield* missingType(ctx);
    const admittedTypes = admittedSchemas.get(identity);
    if (
      admittedTypes !== undefined &&
      admittedTypes.length > 0 &&
      !admittedTypes.includes(lead.type)
    ) {
      const names = admittedTypes.join(', ');
      return yield* abandon(
        ctx,
        'VALIDATION_ERROR',
        `'${displayName}' admits ${names} from '${uri}', and '${lead.type}' is not one of them`,
        `one of ${names}`,
        lead.type,
      );
    }
    const compiled = foreign.get(uri, ctx);
    if (compiled === undefined) {
      // Reported by the lookup, with the code that says whose problem it is. Only this value goes
      // without a verdict; the containing record or array reads on.
      yield* skipNextValue(ctx);
      return undefined;
    }
    const reader = compiled.find(lead.type);
    if (reader === undefined) {
      if (!nameHygieneRefuses(ctx, lead.type)) {
        ctx.report(
          'UNKNOWN_TYPE',
          `'${lead.type}' is not a type '${uri}' declares or imports`,
          [...compiled.linkedSchema.entries.keys()].join(' | '),
          lead.type,
        );
      }
      yield* skipNextValue(ctx);
      return undefined;
    }
    yield* consumeLeadingMember(ctx);
    // No location threading: the foreign reader offers its own declaration on entry like every
    // other reader, so a diagnostic from inside the pushed value names the schema that judged it.
    return yield* routeTo(() => reader).read(ctx, { ...lead, schema: false, schemaRef: undefined });
  }

  return {
    *read(rawCtx: JsonReadContext): Task<unknown> {
      const ctx = rawCtx.underDeclaration(schemaLocation);
      const first = yield* ctx.peek();
      if (first.kind !== 'object-start') {
        return yield* abandon(ctx, 'VALIDATION_ERROR', untyped, UNTYPED_EXPECTED, first.kind);
      }
      const found = yield* leadOf(ctx);
      if (!leadPresent(found)) {
        return yield* abandon(
          ctx,
          'VALIDATION_ERROR',
          untyped,
          UNTYPED_EXPECTED,
          'an object naming no type',
        );
      }
      return found.schema ? yield* readExtern(ctx, found) : yield* readLocal(ctx, found);
    },
  };
}
