/**
 * A record-family position placed by `$type` alone ([TSON-JSON] §6.1.5): the OPEN-with-subtypes
 * and ABSTRACT-with-no-discriminators readings. Ported from the Java reference's
 * `DispatchTagReader` (`tson-json/.../reader/DispatchTagReader.java`); see that file's own doc for
 * the exhaustive rationale.
 *
 * Two positions share this reader, told apart by whether an untagged value has somewhere to go:
 *
 * - **OPEN with subtypes** — untagged, the value is the record itself and goes to its own concrete
 *   reader ({@link untagged}); a tag restating the record goes there too, and one naming a subtype
 *   goes to that subtype.
 * - **ABSTRACT** (closed, or a family-base template) — no direct instances, so the tag is REQUIRED
 *   and the base itself is not admissible: the failure lands before the object's shape is
 *   consulted, the same refusal TSON text gives a missing `!type-ref` at the same position
 *   (`compiler/subsumption.ts`'s own `guardSubsumption`, whose diagnostics this module matches —
 *   `VALIDATION_ERROR` throughout, not `TYPE_MISMATCH`, since §6.1.5's own wording is about a
 *   position with nothing to place an untagged value as, not about an admissibility question).
 *
 * **Every name it admits was resolved when the schema compiled** (`json/schema/route.ts`'s own
 * `routeTo`): a base's `subtypes` is its whole family, transitively (`TypeDefinition.subtypes`),
 * so a tag naming a type any number of levels down reaches that type's reader in one step, and
 * every alias meaning one of them (`link/referenceChain.ts`'s own `admitting`) reaches the same
 * reader.
 *
 * **It decides from the leading members and reads no further** (`reservedMembers.ts`'s own
 * `lead`): §3.3 puts `$type` first, after a `$schema` where one is present, so the selector is
 * known before any of the object's own members, and the reader it selects reads the object once,
 * from the start.
 */
import type { SchemaLocation } from '../../core/diagnostic.js';
import type { Task } from '../../io/bytes.js';
import type { TypeDefinition } from '../../schema/meta/typedef.js';
import { admitting, selfNames } from '../../link/referenceChain.js';
import type { JsonReadContext } from '../readContext.js';
import { skipNextValue, skipValue } from './eventSkip.js';
import { nameHygieneRefuses } from './nameHygiene.js';
import { lead as leadOf, SCHEMA, TYPE, type Lead } from './reservedMembers.js';
import { hasReadExact, routeTo, type ExactReader, type Route } from './route.js';
import type { JsonTypeReader } from './types.js';

export interface DispatchTagOptions {
  /** The base's own declared name — what a diagnostic's `expected` list starts with when it has direct instances. */
  readonly name: string;
  readonly displayName: string;
  /** The whole namespace, for alias flattening (`aliases.ts`). */
  readonly entries: ReadonlyMap<string, TypeDefinition>;
  /** The family below the base, transitive (`TypeDefinition.subtypes`), not yet alias-flattened. */
  readonly subtypes: readonly string[];
  /** The OPEN record's own concrete reader, or `undefined` for an ABSTRACT base. */
  readonly untagged: JsonTypeReader | undefined;
  readonly schemaLocation: SchemaLocation;
  readonly resolve: (name: string) => JsonTypeReader;
}

function isRecordLike(event: { kind: string }): boolean {
  return event.kind === 'object-start';
}

/** Builds the tag dispatcher for one record-family position, reachable only through `json/schema/compile.ts`'s own `build` (an ABSTRACT record with no `discriminators`, or an OPEN one with subtypes). */
export function buildTagDispatcher(options: DispatchTagOptions): JsonTypeReader & ExactReader {
  const { name, displayName, entries, subtypes, untagged, schemaLocation, resolve } = options;
  const own = selfNames(name, entries);
  const admittedSubtypes = admitting(subtypes, entries);
  const subtypeList = subtypes.join(' | ');
  const admissible = untagged !== undefined ? `${name} | ${subtypeList}` : subtypeList;

  const routes = new Map<string, Route>();
  if (untagged !== undefined) {
    const selfRoute = routeTo(() => reader);
    for (const written of own) routes.set(written, selfRoute);
  }
  for (const written of admittedSubtypes) {
    if (!routes.has(written))
      routes.set(
        written,
        routeTo(() => resolve(written)),
      );
  }

  function* refuse(
    ctx: JsonReadContext,
    message: string,
    expected: string,
    actual: string,
  ): Task<undefined> {
    ctx.report('VALIDATION_ERROR', message, expected, actual);
    yield* skipNextValue(ctx);
    return undefined;
  }

  function* dispatch(ctx: JsonReadContext, lead: Lead): Task<unknown> {
    if (
      untagged !== undefined &&
      (lead.type === undefined || (!lead.wrapper && own.has(lead.type)))
    ) {
      // Untagged, an inline restatement, or leading reserved members naming no type: all of it is
      // the record's own reader's to judge, on exactly the terms a record without subtypes judges
      // it. A restating wrapper takes its own route instead, whose `$value` may name a subtype.
      return hasReadExact(untagged)
        ? yield* untagged.readExact(ctx, reader)
        : yield* untagged.read(ctx);
    }
    if (lead.schema) {
      // [TSON-SCHEMA] §7.8, [TSON-JSON] §8.5: `$schema` at a position whose own type is not
      // scoped is `SCOPE_NOT_ADMITTED`, a resolver error.
      ctx
        .field(SCHEMA)
        .report(
          'SCOPE_NOT_ADMITTED',
          `'$schema' opens a schema scope, which [TSON-SCHEMA] §7.8 admits only at a scoped ` +
            `position -- '${displayName}' is a record`,
          'no $schema at this position',
          SCHEMA,
        );
      yield* skipNextValue(ctx);
      return undefined;
    }
    if (lead.type === undefined) {
      if (lead.wrapper) {
        // A bare `$value` with no leading `$type` (§9.4's table: resolver category, not this
        // branch's ordinary "missing tag at an abstract position" validation error below).
        ctx.report(
          'UNKNOWN_TYPE_REF',
          `an annotation object at '${displayName}' needs a leading '$type' before '$value' ` +
            `(§3.3) -- a bare '$value' names nothing to read it as`,
          `'$type' naming one of (${admissible || 'nothing'})`,
          '(no $type)',
        );
        yield* skipNextValue(ctx);
        return undefined;
      }
      // §6.1.5: nothing about the object's shape is consulted before this -- an abstract position
      // with no tag fails whatever it holds, the same refusal TSON text gives a missing type-ref.
      return yield* refuse(
        ctx,
        `a value at '${displayName}' needs a '$type' -- it is abstract and has no direct ` +
          `instances (§6.1.5), so an untagged value is never one of (${admissible || 'nothing'})`,
        admissible === '' ? `a subtype of '${displayName}'` : `one of (${admissible})`,
        '(no $type)',
      );
    }
    const route = routes.get(lead.type);
    if (route === undefined) {
      if (own.has(lead.type)) {
        // §5.2: a tag naming the base itself asserts what no value satisfies -- an ABSTRACT
        // base's own redundant-tag case, refused on the same terms as a missing tag (both are
        // "nothing to place an untagged value as"), never `TYPE_MISMATCH`'s admissibility
        // question: the name resolves, and resolves to exactly the position's own type.
        //
        // Located at the value and not at `/$type`, though the member is right there: [TSON-JSON]
        // §9.4 holds both encodings to one pointer for a rule, and TSON text's tag is an
        // annotation with no pointer step of its own, so a rule the two stacks share can only be
        // located where they both have a location (the Java reference's own `DispatchTagReader`
        // states this exact reasoning; `json-cross-encoding-parity.test.ts` pins it).
        // `dispatchMember.ts`'s own sealed-base self-tag case follows the same convention, at the
        // record's own position. Its `notAMember` case (a tag naming something outside the
        // family) and every `dispatchChoice.ts` tag-mismatch case stay at `/$type` instead -- not
        // because no shared-with-text rule is in play (`compiler/choiceReader.ts`'s own
        // UNKNOWN_TYPE_REF/TYPE_MISMATCH split applies the identical membership rule, over the
        // identical two-step resolution question), but because *this* branch's own reasoning
        // above doesn't carry over to them: this branch is reached only when `lead.type` names
        // the position's *own* type, and that position is what the tag and the text-side
        // annotation share a location with. `notAMember` and the choice cases instead name
        // something admitted nowhere this position (or this choice) knows, so there is no shared
        // position left for the two stacks to agree on -- the pointers genuinely differ, and
        // `json-cross-encoding-parity.test.ts` compares codes alone for exactly those cases.
        ctx.report(
          'VALIDATION_ERROR',
          `'$type' names '${displayName}' itself, but it is abstract and has no direct ` +
            `instances (§6.1.5) -- no value satisfies it; expected one of (${admissible})`,
          `one of (${admissible})`,
          lead.type,
        );
        yield* skipNextValue(ctx);
        return undefined;
      }
      if (!nameHygieneRefuses(ctx.field(TYPE), lead.type)) {
        const resolves = entries.has(lead.type);
        // Located at the value, not at `/$type` -- see this function's own note above.
        ctx.report(
          resolves ? 'TYPE_MISMATCH' : 'UNKNOWN_TYPE_REF',
          resolves
            ? `'$type' names '${lead.type}', which is not a known subtype of '${displayName}' ` +
                `(§7.2) -- expected one of (${admissible})`
            : `'$type' names '${lead.type}', which does not resolve in the governing schema's ` +
                `namespace (§7.2) -- expected one of (${admissible})`,
          `one of (${admissible})`,
          lead.type,
        );
      }
      yield* skipNextValue(ctx);
      return undefined;
    }
    return yield* route.read(ctx, lead);
  }

  const reader: JsonTypeReader & ExactReader = {
    *read(ctx: JsonReadContext): Task<unknown> {
      const rctx = ctx.inRecord(schemaLocation);
      const peeked = yield* rctx.peek();
      if (!isRecordLike(peeked)) {
        if (untagged !== undefined) return yield* untagged.read(rctx);
        const found = yield* rctx.next();
        rctx.report(
          'TYPE_MISMATCH',
          `'${displayName}' is a record and takes a JSON object, and this is '${found.kind}'`,
          'an object',
          found.kind,
        );
        yield* skipValue(rctx, found);
        return undefined;
      }
      const lead = yield* leadOf(rctx);
      return yield* dispatch(rctx, lead);
    },
    *readExact(ctx: JsonReadContext, _wrapped: JsonTypeReader): Task<unknown> {
      return yield* reader.read(ctx);
    },
  };
  return reader;
}
