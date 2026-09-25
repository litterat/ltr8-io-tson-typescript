/**
 * A SEALED record position ([TSON-JSON] §6.1.5's third reading): the base declares one or more
 * discriminator fields, every member of the family pins them, and a value here is placed by
 * reading those members rather than by carrying a tag. Ported from the Java reference's
 * `DispatchMemberReader` (`tson-json/.../reader/DispatchMemberReader.java`); see that file's own
 * doc for the exhaustive rationale.
 *
 * **The mapping is built when the schema compiles and never at read time.** Each subtype's own
 * pins are decoded once, at the fields' declared types *in the base* — the one set of types known
 * before a subtype is selected — and keyed by what they compare as
 * (`json/schema/valueIdentity.ts`'s `identityOfHost`), so a read is one map lookup. §4.3 makes
 * `255` and `0xFF` one pin and §5.5 makes `1` and `1.0` one, and the same rule decides both sides
 * here: the schema's token and the document's literal are decoded by the same parser before either
 * is compared.
 *
 * **It reads the leading members and no others.** §6.1.5 puts the discriminators first, after any
 * reserved members (§3.3), in any order among themselves, so `reservedMembers.ts`'s own `lead`
 * answers both the tag and the selectors from as many members as the family declares
 * discriminators — a count the schema fixes, whatever the document holds (§10.1).
 *
 * **The tag can only assert, and the selected reader is what holds it to that.** `$type` MAY be
 * present and MUST name the dispatched member or a subtype of it. The discriminators are still
 * required with it, and the value goes where the tag names; the selected reader re-reads the whole
 * object and re-verifies each pin as an ordinary FIXED check (`json/schema/record.ts`'s own
 * `verifyFixed`), so a tag disagreeing with the discriminator meets a pinned field the document
 * contradicts. One selector per position, and the dispatch read and the validation read agree by
 * construction.
 */
import type { SchemaLocation } from '../../core/diagnostic.js';
import type { Task } from '../../io/bytes.js';
import { directMembers, type Member } from '../../link/recordExtension.js';
import type { RecordField } from '../../schema/meta/bodies.js';
import type { TypeDefinition } from '../../schema/meta/typedef.js';
import { admitting, selfNames } from '../../link/referenceChain.js';
import { toNfc } from '../../unicode/nfc.js';
import type { JsonReadContext } from '../readContext.js';
import type { JsonEvent } from '../stream.js';
import { contentOf, describeEvent, fieldValueParser, type AtomForm } from './atoms.js';
import type { CompileContext } from './compile.js';
import { skipNextValue, skipValue } from './eventSkip.js';
import { nameHygieneRefuses } from './nameHygiene.js';
import { fieldValueOf, resolveFieldBody } from './record.js';
import { lead as leadOf, SCHEMA, TYPE, type Lead } from './reservedMembers.js';
import { routeTo, type ExactReader, type Route } from './route.js';
import type { JsonTypeReader } from './types.js';
import { identityOfHost } from './valueIdentity.js';

interface Selector {
  readonly name: string;
  readonly form: AtomForm;
  readonly parse: (content: string) => unknown;
}

export interface DispatchMemberOptions {
  readonly name: string;
  readonly displayName: string;
  /** The discriminator field names, in declaration order (`RecordBody.discriminators`/`TemplateBody.discriminators`). */
  readonly discriminators: readonly string[];
  /** The base's own declared fields, when it has any of its own (a closed record); `undefined` for a record-bodied template family base, whose selectors are read off any member instead (§5.10 never reads the held body). */
  readonly baseFields: readonly RecordField[] | undefined;
  readonly entries: ReadonlyMap<string, TypeDefinition>;
  readonly schemaLocation: SchemaLocation;
  readonly ctx: CompileContext;
}

function fieldTypeOf(
  fieldName: string,
  baseFields: readonly RecordField[] | undefined,
  members: readonly Member[],
): string {
  const own = baseFields?.find((f) => f.name === fieldName);
  if (own !== undefined) return own.type.name;
  for (const member of members) {
    const field = member.body.fields.find((f) => f.name === fieldName);
    if (field !== undefined) return field.type.name;
  }
  throw new Error(
    `'${fieldName}' names a discriminator but neither the base nor any of its members declares such a field`,
  );
}

function selectorsOf(
  ctx: CompileContext,
  discriminators: readonly string[],
  baseFields: readonly RecordField[] | undefined,
  members: readonly Member[],
): readonly Selector[] {
  return discriminators.map((fieldName) => {
    const typeName = fieldTypeOf(fieldName, baseFields, members);
    const body = resolveFieldBody(ctx, typeName);
    const { form, parse } = fieldValueParser(typeName, body);
    return { name: toNfc(fieldName), form, parse };
  });
}

/** One direct member's own pin tuple, decoded through `selectors` -- `undefined` where the member fails to pin every discriminator (already refused at link time, `link/recordExtension.ts`; a reader reaching this point trusts that verdict rather than re-deriving it). */
function pinsOf(
  ctx: CompileContext,
  member: Member,
  selectors: readonly Selector[],
): readonly string[] | undefined {
  const key: string[] = [];
  for (const selector of selectors) {
    const field = member.body.fields.find((f) => toNfc(f.name) === selector.name);
    if (field?.role !== 'FIXED' || field.value === undefined) return undefined;
    try {
      key.push(identityOfHost(fieldValueOf(ctx, field.type.name, field.value).hostValue));
    } catch {
      return undefined;
    }
  }
  return key;
}

function decodeSelector(selector: Selector, event: JsonEvent): string | undefined {
  const content = contentOf(selector.form, event);
  if (content === undefined) return undefined;
  try {
    return identityOfHost(selector.parse(content));
  } catch {
    return undefined;
  }
}

function tupleLabel(discriminators: readonly string[]): string {
  return discriminators.length > 1
    ? `discriminators (${discriminators.join(', ')})`
    : `discriminator '${discriminators[0] ?? ''}'`;
}

/** Builds the member-dispatch reader for one sealed record-family position -- reachable only through `json/schema/compile.ts`'s own `build` (an ABSTRACT record or family-base template naming `discriminators`). */
export function buildMemberDispatcher(
  options: DispatchMemberOptions,
): JsonTypeReader & ExactReader {
  const { name, displayName, discriminators, baseFields, entries, schemaLocation, ctx } = options;
  const own = selfNames(name, entries);
  const members = directMembers(name, entries);
  const selectors = selectorsOf(ctx, discriminators, baseFields, members);
  const selectorNames = new Set(selectors.map((s) => s.name));

  const membersByKey = new Map<string, string>();
  for (const member of members) {
    const pins = pinsOf(ctx, member, selectors);
    if (pins !== undefined) {
      const key = pins.join('\u0000');
      if (!membersByKey.has(key)) membersByKey.set(key, member.name);
    }
  }
  const pinnedList = Array.from(new Set(membersByKey.values())).join(' | ') || '(none)';

  const routes = new Map<string, Route>();
  for (const member of members) {
    const definition = entries.get(member.name);
    const under = [member.name, ...(definition?.subtypes ?? [])];
    for (const written of admitting(under, entries)) {
      if (!routes.has(written))
        routes.set(
          written,
          routeTo(() => ctx.resolve(written)),
        );
    }
  }

  const tuple = tupleLabel(discriminators);
  const memberList = Array.from(new Set(members.map((m) => m.name))).join(', ') || '(none)';

  function* notAMember(rctx: JsonReadContext, type: string): Task<undefined> {
    if (!nameHygieneRefuses(rctx.field(TYPE), type)) {
      // §7.2's own two-step resolution rule, the same split `json/schema/dispatchTag.ts` and
      // `json/schema/dispatchChoice.ts` both apply: a name `entries` declares nothing under is
      // `UNKNOWN_TYPE_REF`; a name that resolves to a real entry that just isn't a member of this
      // sealed family is `TYPE_MISMATCH`.
      const resolves = entries.has(type);
      rctx
        .field(TYPE)
        .report(
          resolves ? 'TYPE_MISMATCH' : 'UNKNOWN_TYPE_REF',
          resolves
            ? `'$type' names '${type}', which is not a member of the sealed '${displayName}'`
            : `'$type' names '${type}', which does not resolve in the governing schema's ` +
                `namespace (§7.2) -- expected one of (${pinnedList})`,
          pinnedList,
          type,
        );
    }
    yield* skipNextValue(rctx);
    return undefined;
  }

  function* dispatch(rctx: JsonReadContext, lead: Lead): Task<unknown> {
    if (lead.schema) {
      // §3.3, §9.4: resolver category, not `UNRECOGNIZED_FIELD` -- see `reservedMembers.ts`'s top
      // note.
      rctx
        .field(SCHEMA)
        .report(
          'UNKNOWN_TYPE_REF',
          `'$schema' opens a schema scope, which [TSON-SCHEMA] §7.8 admits only at a scoped ` +
            `position -- '${displayName}' is a record`,
          'no $schema at this position',
          SCHEMA,
        );
      yield* skipNextValue(rctx);
      return undefined;
    }
    if (lead.wrapper) {
      // §3.3's wrapper puts the record inside `$value`, so the discriminators are not at this
      // level to read and the tag is the only thing that can place it -- the ordinary wrapper
      // rule, not a second dispatch.
      if (lead.type === undefined) {
        // §9.4's table: "a `$value` in an object not led by `$type`" is resolver category, not
        // `VALIDATION_ERROR` -- the same divergence `reservedMembers.ts`'s top note records.
        rctx.report(
          'UNKNOWN_TYPE_REF',
          `'${displayName}' is sealed, and a '$value' wrapper with no '$type' has nothing to ` +
            `place it as -- expected one of (${memberList})`,
          `one of (${memberList})`,
          '(no $type)',
        );
        yield* skipNextValue(rctx);
        return undefined;
      }
      const route = routes.get(lead.type);
      return route !== undefined
        ? yield* route.read(rctx, lead)
        : yield* notAMember(rctx, lead.type);
    }

    const key: string[] = [];
    for (const selector of selectors) {
      const raw = lead.selectors.get(selector.name);
      if (raw === undefined) {
        // FIELD_REQUIRED, not VALIDATION_ERROR: the reference's own `RecordExtensionDiagnostics
        // .discriminatorMissing` (`tson-base`) files this code, and so does this port's own text
        // stack (`compiler/subsumption.ts`'s member-dispatch reader, whose fallback to the base's
        // ordinary record reader surfaces this same field's own required-field check) -- a
        // discriminator is an ordinary required field of the base with one more consequence
        // (selection) layered on, not a rule of its own. A discriminator this package's own
        // bounded lookahead did not find "leading" is the identical case: the field is absent from
        // what a decoder may hold before dispatch, whether the document omitted it entirely or
        // simply wrote it after another member (§6.1.5's own bound, and a genuine, acknowledged
        // difference from the text encoding's full-record lookahead -- but not one this code
        // reports differently for).
        rctx
          .field(selector.name)
          .report(
            'FIELD_REQUIRED',
            `missing ${tupleLabel([selector.name])} for '${displayName}' -- a sealed family selects ` +
              `its member by reading it, so its discriminators lead the object, after any '$type' ` +
              `(§6.1.5), and '${selector.name}' is absent or follows another member`,
            `'${selector.name}' as a leading member`,
            '(missing)',
          );
        yield* skipNextValue(rctx);
        return undefined;
      }
      const decoded = decodeSelector(selector, raw);
      if (decoded === undefined) {
        rctx
          .field(selector.name)
          .report(
            'VALIDATION_ERROR',
            `'${selector.name}' is ${describeEvent(raw)}, which matches no member of '${displayName}' ` +
              `-- expected one of (${pinnedList})`,
            pinnedList,
            describeEvent(raw),
          );
        yield* skipNextValue(rctx);
        return undefined;
      }
      key.push(decoded);
    }
    const selected = membersByKey.get(key.join('\u0000'));
    if (selected === undefined) {
      rctx.report(
        'VALIDATION_ERROR',
        `no member of '${displayName}' pins its ${tuple} to the value this record states -- ` +
          `expected one of (${pinnedList})`,
        pinnedList,
        `${tuple} as stated`,
      );
      yield* skipNextValue(rctx);
      return undefined;
    }
    if (lead.type !== undefined && own.has(lead.type)) {
      // §8.1's redundant-tag rule assumes a type with direct instances; a sealed base has none.
      // Reported at `rctx` (the record's own position), not at `/$type`, matching the Java
      // reference's own `DispatchMemberReader.dispatch` -- see `dispatchTag.ts`'s top note on why
      // (this is that same pointer convention, not `notAMember`'s own opposite one below).
      rctx.report(
        'VALIDATION_ERROR',
        `'$type' names '${displayName}' itself, but it is sealed and has no direct instances ` +
          `(§6.1.5) -- no value satisfies it; expected one of (${memberList})`,
        `one of (${memberList})`,
        lead.type,
      );
      yield* skipNextValue(rctx);
      return undefined;
    }
    if (lead.type === undefined) {
      const route = routes.get(selected);
      if (route === undefined) {
        throw new Error(
          `'${selected}' was matched by pins but has no route -- this is a library bug`,
        );
      }
      return yield* route.read(rctx, lead);
    }
    const route = routes.get(lead.type);
    return route !== undefined ? yield* route.read(rctx, lead) : yield* notAMember(rctx, lead.type);
  }

  const reader: JsonTypeReader & ExactReader = {
    *read(ctx: JsonReadContext): Task<unknown> {
      const rctx = ctx.inRecord(schemaLocation);
      const peeked = yield* rctx.peek();
      if (peeked.kind !== 'object-start') {
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
      const lead = yield* leadOf(rctx, selectorNames);
      return yield* dispatch(rctx, lead);
    },
    *readExact(ctx: JsonReadContext, _wrapped: JsonTypeReader): Task<unknown> {
      return yield* reader.read(ctx);
    },
  };
  return reader;
}
