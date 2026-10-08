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
import { lookingAhead, type JsonReadContext } from '../readContext.js';
import type { JsonEvent } from '../stream.js';
import { contentOf, describeEvent, enumFormOf, fieldValueParser, type AtomForm } from './atoms.js';
import type { CompileContext } from './compile.js';
import { skipNextValue, skipRestOfObject, skipValue } from './eventSkip.js';
import { nameHygieneRefuses } from './nameHygiene.js';
import { fieldValueOf, resolveFieldBody } from './record.js';
import { lead as leadOf, SCHEMA, TYPE, type Lead } from './reservedMembers.js';
import { routeTo, type ChoiceSelfTagReadable, type ExactReader, type Route } from './route.js';
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
    const { form, parse } = fieldValueParser(
      typeName,
      body,
      enumFormOf(ctx.linkedSchema, typeName),
    );
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

  /**
   * `skipNextValue` assumes `rctx` sits at an unconsumed value's own opening event, which
   * holds for every ordinary (`opened: false`) call below -- `rctx` is still at this
   * object's own `object-start`, since nothing before this point ever truly consumes it
   * (every dispatcher's own lookahead peeks and rewinds). It does not hold for `readAt`'s own
   * `opened` branch: there, the caller has already consumed the opening brace and the leading
   * tag for real, so `rctx` sits mid-object, and discarding "the rest of this record" means
   * `skipRestOfObject`'s own depth-1 loop, not `skipNextValue`'s depth-from-`first` one.
   */
  function* skipRest(rctx: JsonReadContext, opened: boolean): Task<void> {
    if (opened) {
      yield* skipRestOfObject(rctx);
    } else {
      yield* skipNextValue(rctx);
    }
  }

  function* dispatch(rctx: JsonReadContext, lead: Lead, opened: boolean): Task<unknown> {
    if (lead.schema) {
      // §3.3, §9.4: resolver category, not `UNRECOGNIZED_FIELD` -- see `reservedMembers.ts`'s top
      // note.
      rctx
        .field(SCHEMA)
        .report(
          'SCOPE_NOT_ADMITTED',
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
        ? yield* route.read(rctx, lead, opened)
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
        // bounded lookahead did not find "leading" is the identical case: the field is missing from
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
              `(§6.1.5), and '${selector.name}' is missing or follows another member`,
            `'${selector.name}' as a leading member`,
            '(missing)',
          );
        yield* skipRest(rctx, opened);
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
        yield* skipRest(rctx, opened);
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
      yield* skipRest(rctx, opened);
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
      return yield* route.read(rctx, lead, opened);
    }
    const route = routes.get(lead.type);
    return route !== undefined
      ? yield* route.read(rctx, lead, opened)
      : yield* notAMember(rctx, lead.type);
  }

  function* readAt(rctx: JsonReadContext, opened: boolean): Task<unknown> {
    if (!opened) {
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
      return yield* dispatch(rctx, lead, false);
    }
    // `opened` (`json/schema/route.ts`'s own top note): the caller has already consumed the
    // object's opening brace and a leading tag naming this family's own base for real -- nothing
    // reserved remains to recognize, so only the discriminators are read, from wherever the
    // stream now sits.
    const selectors = yield* leadingSelectors(rctx, selectorNames);
    const lead: Lead = {
      schema: false,
      schemaRef: undefined,
      typed: false,
      type: undefined,
      wrapper: false,
      selectors,
    };
    return yield* dispatch(rctx, lead, true);
  }

  const reader: JsonTypeReader & ExactReader & ChoiceSelfTagReadable = {
    *read(ctx: JsonReadContext): Task<unknown> {
      return yield* readAt(ctx.inRecord(schemaLocation), false);
    },
    *readExact(ctx: JsonReadContext, _wrapped: JsonTypeReader, opened = false): Task<unknown> {
      return yield* readAt(ctx.inRecord(schemaLocation), opened);
    },
    *readChoiceSelfTag(ctx: JsonReadContext): Task<unknown> {
      // Called only by `json/schema/dispatchChoice.ts`, and only when this sealed family is a
      // choice variant and the document's own `$type` names the family's own base -- admissible
      // there (it is a declared variant, §8.1) though the base has no direct instances of its own
      // (§6.1.5), and no more specific name is admissible at a choice's own tag (no subtype
      // admission, `dispatchChoice.ts`'s own top note). `ctx` sits unconsumed at the object's own
      // opening brace; this consumes it and that leading tag for real -- the caller has already
      // judged the tag admissible, so neither is re-checked -- then dispatches on the
      // discriminators exactly as the untagged route would: the choice mechanism finishing what
      // it started, not a second, looser admissibility rule (`compiler/subsumption.ts`'s own
      // `readChoiceSelfTag` is the text-stack analogue).
      const rctx = ctx.inRecord(schemaLocation);
      const opening = yield* rctx.next();
      if (opening.kind !== 'object-start') {
        rctx.report(
          'TYPE_MISMATCH',
          `'${displayName}' is a record and takes a JSON object, and this is '${opening.kind}'`,
          'an object',
          opening.kind,
        );
        yield* skipValue(rctx, opening);
        return undefined;
      }
      yield* rctx.next(); // '$type' member-name
      yield* rctx.next(); // the tag's own scalar value
      return yield* readAt(rctx, true);
    },
  };
  return reader;
}

/** Whether `event` is one `leadingSelectors` may capture -- `reservedMembers.ts`'s own `isScalarEvent`, restated locally rather than exported for this module's one use. */
function isScalarEvent(event: JsonEvent): boolean {
  return (
    event.kind === 'string' ||
    event.kind === 'number' ||
    event.kind === 'boolean' ||
    event.kind === 'null'
  );
}

/**
 * `reservedMembers.ts`'s own `lead` selector loop, restated for a cursor that is already
 * positioned at the family's own leading members with nothing reserved before them to recognize
 * (`readAt`'s own `opened` branch, above) -- a bounded peek, rewound, exactly like `lead` itself.
 */
function* leadingSelectors(
  rctx: JsonReadContext,
  wanted: ReadonlySet<string>,
): Task<ReadonlyMap<string, JsonEvent>> {
  return yield* lookingAhead(rctx, function* (ahead): Task<ReadonlyMap<string, JsonEvent>> {
    const selectors = new Map<string, JsonEvent>();
    let event = yield* ahead.peek();
    while (selectors.size < wanted.size && event.kind === 'member-name') {
      const name = toNfc(event.name);
      yield* ahead.next(); // the member-name just peeked
      const value = yield* ahead.peek();
      if (!wanted.has(name) || selectors.has(name) || !isScalarEvent(value)) break;
      selectors.set(name, value);
      yield* ahead.next(); // the value
      event = yield* ahead.next(); // the next member-name, or whatever follows
    }
    return selectors;
  });
}
