/**
 * A record as a JSON object ([TSON-JSON] §6.1), in every position that reaches this module: a
 * closed (non-family, or FINAL/OPEN-with-no-local-subtype) record read directly, and every
 * record-family position's own *concrete* reading (`json/schema/dispatchTag.ts`'s `untagged`,
 * `json/schema/dispatchMember.ts`'s dispatched member) — one member per present field, member
 * name = field name (NFC), and every rule of §6.1.1–§6.1.4/§6.1.6 applied in one loop that fills a
 * slot per field and hands the slots to a tree builder once. The port of the Java reference's
 * `RecordPlan`/`RecordReader`/`TreeRecordBuilder`, collapsed into one file since this package
 * builds tree mode alone.
 *
 * **§3.3's annotation object, read with no lookahead of its own.** A record position's own reader
 * is the one place §3.3's leading members are read *sequentially*, as the ordinary member loop
 * meets them, rather than peeked ahead (`json/schema/reservedMembers.ts`'s `lead`, which every
 * dispatcher in this directory uses instead): this reader is reached only once a dispatcher has
 * already decided the object is its own type to read (or reached directly, at a non-family
 * position, where nothing dispatches at all), so there is nothing left to decide from a peek —
 * only whether the leading members it meets are placed and spelled correctly.
 *
 * - **`$type` at the object's first member** MAY restate this record's own type (itself, or an
 *   alias whose reference chain terminates at it, `link/referenceChain.ts`'s `selfNames`) — never
 *   anything else, since a value reaching this reader has already been placed at exactly this
 *   type by whichever dispatcher (if any) sits in front of it. Admitted, the read continues to
 *   this record's own fields (the inline form) or, immediately following, to a lone `$value` (the
 *   wrapper form, below).
 * - **`$value`, immediately after a leading, admitted `$type`,** makes the object a wrapper: read
 *   at `wrapped` — the reader an enclosing dispatcher chose for this position ({@link
 *   ExactReader.readExact}'s own `wrapped` parameter; `read` passes this reader itself, since a
 *   record reached with no dispatcher in front of it is its own wrapper target too) — because the
 *   value inside may itself carry a tag selecting a subtype, which only `wrapped` (not this
 *   record's own, subtype-blind fields) knows how to place. This record's own fields are never
 *   read in this branch: a wrapper is apparatus, not a record (§3.3).
 * - **Anything else `$`-initial** — `$schema` at any position (never admitted: no record position
 *   is scoped, §7.8), `$type` anywhere but first, `$value` with no leading, admitted `$type`
 *   before it, or a name outside the closed three-member table — is a resolver error, and the
 *   whole record is abandoned: reading past it as ordinary fields would report false verdicts
 *   against a shape a misplaced or unknown selector has already made unreadable.
 *
 * **A recognized field is read at `ctx.schemaField(name)`, never `ctx.field(name)` followed by a
 * second step.** `schemaField` extends both the data path and (once `inRecord` has anchored one)
 * the schema pointer in one step; `field` extends the data path alone, and is used here only for
 * an *unmatched* member (§6.1.1's closure test never reaches a name §3.2 already claimed) or a
 * misplaced/unknown reserved one, neither of which names a field for a schema pointer to extend to.
 */
import type { SchemaLocation } from '../../core/diagnostic.js';
import type { Task } from '../../io/bytes.js';
import { selfNames, terminalDefinition } from '../../link/referenceChain.js';
import {
  fieldOmission,
  groupRefusals,
  isGroupMember,
  type FieldGroup,
  type FieldOmission,
  type RecordBody,
  type RecordField,
} from '../../schema/meta/bodies.js';
import type { Atom, TypeDefinition } from '../../schema/meta/typedef.js';
import { toNfc } from '../../unicode/nfc.js';
import type { JsonReadContext } from '../readContext.js';
import type { JsonEvent } from '../stream.js';
import {
  jsonBoolean,
  jsonNull,
  jsonNumber,
  jsonObject,
  jsonString,
  type JsonValue,
} from '../tree.js';
import {
  atomReader,
  describeEvent,
  enumReader,
  fieldValueParser,
  identifierReader,
  type AtomForm,
} from './atoms.js';
import type { CompileContext } from './compile.js';
import { skipNextValue, skipRestOfObject, skipValue } from './eventSkip.js';
import { nameHygieneRefuses } from './nameHygiene.js';
import {
  readWrappedValue,
  refuseMisplaced,
  refuseUnknown,
  SCHEMA,
  TYPE,
  VALUE,
} from './reservedMembers.js';
import type { ExactReader } from './route.js';
import type { JsonTypeReader } from './types.js';
import { identityOfHost } from './valueIdentity.js';

/** A field's schema-stated `~`/`=` value, resolved once at compile time: the host value it denotes (for the FIXED comparison) and the JSON node that spells it (for injection, §6.1.3). */
export interface FieldValue {
  readonly hostValue: unknown;
  readonly node: JsonValue;
}

/**
 * [TSON-JSON] §6.1.3: "rendered from the decoded value, not from the token" -- radix and digit
 * separators do not survive (§4.3); a string-content family keeps its token, since the token *is*
 * the spelling there. `tokenText` is `write(hostValue)` when the family's parser has a `write`
 * (every `number`/`number-or-string` family does -- `fieldValueOf`'s own note), so the exact and
 * approximate-numeric cases render through it rather than re-deriving a spelling from `hostValue`
 * by its JS `typeof`, which cannot render a `number` family's {@link TsonDecimal} host value at
 * all.
 */
function fieldValueNode(form: AtomForm, hostValue: unknown, tokenText: string): JsonValue {
  switch (form) {
    case 'boolean':
      return jsonBoolean(hostValue as boolean);
    case 'number':
      return jsonNumber(tokenText);
    case 'number-or-string': {
      // The float specials have no JSON number spelling (§5.4); `write`'s own TSON spelling
      // (`+.inf`) isn't the JSON one either, so this is computed directly from `hostValue`,
      // never from `tokenText`. Only a `float_type` family reaches this case (`atomFormOf`), so
      // `hostValue` is always a plain JS `number` here.
      if (typeof hostValue === 'number' && !Number.isFinite(hostValue)) {
        return jsonString(Number.isNaN(hostValue) ? '.nan' : hostValue > 0 ? '.inf' : '-.inf');
      }
      return jsonNumber(tokenText);
    }
    case 'string':
      return jsonString(tokenText);
    case 'enum':
      return tokenText === 'true' || tokenText === 'false'
        ? jsonBoolean(tokenText === 'true')
        : jsonString(tokenText);
  }
}

/**
 * `fieldTypeName`'s reference chain walked to the atom body it terminates at (§8.3) — the one step
 * {@link fieldValueOf} and {@link fixedFieldReader} share. Exported for
 * `json/schema/dispatchMember.ts`'s own use: a sealed family's discriminator fields are read at
 * the BASE's own declared type ([TSON-JSON] §6.1.5, "the one set of types known before dispatch"),
 * which is exactly this walk applied to a discriminator field's `type.name`.
 */
export function resolveFieldBody(ctx: CompileContext, fieldTypeName: string): Atom {
  const entries = ctx.linkedSchema.entries;
  const definition = terminalDefinition(fieldTypeName, (name) => entries.get(name));
  if (definition === undefined) {
    throw new Error(
      `'${fieldTypeName}' does not resolve -- linking should have refused this before compilation`,
    );
  }
  const body = definition.body;
  if ('template' in body && 'parameters' in body) {
    throw new Error(`'${fieldTypeName}' is an open template, and carries no atom parser`);
  }
  if (body.kind === 'reference') {
    throw new Error(
      `'${fieldTypeName}'s reference chain did not collapse -- this is a library bug`,
    );
  }
  return body as Atom;
}

/**
 * `fieldTypeName`'s reference chain walked to an atom (§8.3), and its stated `token` resolved
 * against it — the port of the Java reference's `FieldValue.of`. Exported for
 * `json/schema/dispatchMember.ts`'s own use: a sealed member's own pin for a discriminator field is
 * exactly this, applied to that field's stated `~`/`=` token at the base's own declared type.
 */
export function fieldValueOf(
  ctx: CompileContext,
  fieldTypeName: string,
  token: { readonly text: string },
): FieldValue {
  const body = resolveFieldBody(ctx, fieldTypeName);
  const { form, parse, write } = fieldValueParser(fieldTypeName, body);
  const hostValue = parse(token.text);
  const text = write === undefined ? token.text : write(hostValue);
  return { hostValue, node: fieldValueNode(form, hostValue, text) };
}

/**
 * A FIXED field's own **decoding** reader (never `treeAtomReader`-wrapped, unlike
 * `plan.schemaReaders`): {@link verifyFixed} needs the document's actual decoded host value to
 * compare against the schema's own pin ({@link fieldValueOf}'s `hostValue`) — a `JsonValue` tree
 * node cannot answer that (it is the document's own *spelling*, exactly the thing §6.1.3 says a
 * FIXED comparison must not go by). Built from the same chain walk {@link fieldValueOf} uses, and
 * dispatched the same way `json/schema/compile.ts`'s own `build` dispatches an atom-kind entry —
 * `atomReader`/`enumReader`/`identifierReader` are exactly its non-composite cases, minus the
 * `void`/`value` branches §5.2 already rules out for a stated `~`/`=` value (`fieldValueParser`'s
 * own top note).
 */
function fixedFieldReader(
  ctx: CompileContext,
  fieldTypeName: string,
  schemaLocation: SchemaLocation,
): JsonTypeReader {
  const body = resolveFieldBody(ctx, fieldTypeName);
  if (body.kind === 'enum') return enumReader(fieldTypeName, body, schemaLocation);
  if (body.kind === 'identifier_type') {
    return identifierReader(fieldTypeName, schemaLocation);
  }
  return atomReader(fieldTypeName, body, schemaLocation);
}

// ---------------------------------------------------------------------------------------------
// RecordPlan -- what the schema fixes, resolved once
// ---------------------------------------------------------------------------------------------

interface RecordPlan {
  readonly displayName: string;
  /** Every written name a leading `$type` may restate here — this record's own name, plus every alias whose reference chain terminates at it (`link/referenceChain.ts`'s `selfNames`). */
  readonly own: ReadonlySet<string>;
  /** The whole linked schema's namespace, for {@link admissibleTag}'s own two-step resolution question ("does the name resolve at all"). */
  readonly entries: ReadonlyMap<string, TypeDefinition>;
  readonly schemaLocation: SchemaLocation;
  readonly names: readonly string[];
  readonly fields: readonly RecordField[];
  readonly omitted: readonly FieldOmission[];
  readonly schemaReaders: readonly JsonTypeReader[];
  /** A FIXED field's own decoding reader ({@link fixedFieldReader}); `undefined` at every other field's slot. */
  readonly fixedReaders: readonly (JsonTypeReader | undefined)[];
  readonly stated: readonly (FieldValue | undefined)[];
  readonly index: ReadonlyMap<string, number>;
  readonly groups: readonly FieldGroup[];
}

function buildRecordPlan(
  name: string,
  body: RecordBody,
  schemaLocation: SchemaLocation,
  ctx: CompileContext,
): RecordPlan {
  const fields = body.fields;
  const names: string[] = [];
  const omitted: FieldOmission[] = [];
  const schemaReaders: JsonTypeReader[] = [];
  const fixedReaders: (JsonTypeReader | undefined)[] = [];
  const stated: (FieldValue | undefined)[] = [];
  const index = new Map<string, number>();

  fields.forEach((field, i) => {
    const fieldName = toNfc(field.name);
    names.push(fieldName);
    index.set(fieldName, i);
    omitted.push(fieldOmission(field, isGroupMember(body.groups, field.name)));
    schemaReaders.push(ctx.resolve(field.type.name));
    fixedReaders.push(
      field.role === 'FIXED'
        ? fixedFieldReader(ctx, field.type.name, ctx.locationOf(field.type.name))
        : undefined,
    );
    stated.push(
      field.value === undefined ? undefined : fieldValueOf(ctx, field.type.name, field.value),
    );
  });

  return {
    displayName: name,
    own: selfNames(name, ctx.linkedSchema.entries),
    entries: ctx.linkedSchema.entries,
    schemaLocation,
    names,
    fields,
    omitted,
    schemaReaders,
    fixedReaders,
    stated,
    index,
    groups: body.groups,
  };
}

// ---------------------------------------------------------------------------------------------
// Slots -- what a field's slot in the read loop holds
// ---------------------------------------------------------------------------------------------

const ABSENT = Symbol('json.record.absent');
const REFUSED = Symbol('json.record.refused');
type Slot = JsonValue | typeof ABSENT | typeof REFUSED | undefined;

function slotToNode(slot: Slot): JsonValue | undefined {
  if (slot === undefined || slot === REFUSED) return undefined;
  return slot === ABSENT ? jsonNull() : slot;
}

/**
 * Whether `content` (the value peeked right after a leading `$type` member) admits this record's
 * own type: a JSON string whose content is one of `plan.own`. Reports the appropriate refusal and
 * answers `false` when it does not — never a second report on top of one {@link
 * ./nameHygiene.js#nameHygieneRefuses} already made.
 */
function admissibleTag(ctx: JsonReadContext, plan: RecordPlan, content: JsonEvent): boolean {
  const admissible = Array.from(plan.own).join(' | ');
  // Every refusal below is reported at `ctx` (the record's own position), never at `/$type`
  // though the member is right there: [TSON-JSON] §9.4 holds both encodings to one pointer for a
  // rule they share, and TSON text's tag is an annotation with no pointer step of its own, so a
  // rule the two stacks share can only be located where they both have a location (the Java
  // reference's own `RecordPlan.admitsTag` states this exact reasoning;
  // `json-cross-encoding-parity.test.ts` pins it). This is `dispatchMember.ts`/`dispatchChoice.ts`'s
  // own opposite choice, deliberately: there `$type` is genuinely the only carrier of a sealed or
  // choice tag, so those two report at `/$type`.
  if (content.kind !== 'string') {
    ctx.report(
      'TYPE_MISMATCH',
      `'$type' is a string naming a type, and this is ${describeEvent(content)}`,
      admissible,
      describeEvent(content),
    );
    return false;
  }
  if (plan.own.has(content.value)) return true;
  if (nameHygieneRefuses(ctx.field(TYPE), content.value)) return false;
  const resolves = plan.entries.has(content.value);
  ctx.report(
    resolves ? 'TYPE_MISMATCH' : 'UNKNOWN_TYPE_REF',
    resolves
      ? `'$type' names '${content.value}', which is not '${plan.displayName}' or an alias of it ` +
          `(§7.2) -- expected ${admissible}`
      : `'$type' names '${content.value}', which does not resolve in the governing schema's ` +
          `namespace (§7.2) -- expected ${admissible}`,
    admissible,
    content.value,
  );
  return false;
}

/**
 * §3.3's `$schema`/misplaced-`$type`/misplaced-`$value`/unknown-`$`-name refusal, at a record
 * position: `$schema` is never admitted (no record position is scoped, [TSON-SCHEMA] §7.8), and
 * the rest are `reservedMembers.ts`'s own leading-member rules restated at whichever member this
 * loop actually met. Always a resolver error, and always abandons the whole record: reading past
 * a misplaced or unknown selector as ordinary fields would report false verdicts against a shape
 * it has already made unreadable.
 */
function refuseReserved(ctx: JsonReadContext, name: string, displayName: string): void {
  if (name === SCHEMA) {
    // §3.3's closing paragraph states this directly: `$schema` "is a resolver error at any
    // position whose effective type is not a `scoped` instance" -- §9.4 file drawer, not
    // `UNRECOGNIZED_FIELD`'s validation category, even though it does not appear itemised in
    // §9.4's table row by row.
    ctx
      .field(SCHEMA)
      .report(
        'UNKNOWN_TYPE_REF',
        `'$schema' opens a schema scope, which [TSON-SCHEMA] §7.8 admits only at a scoped ` +
          `position -- '${displayName}' is a record`,
        'no $schema at this position',
        SCHEMA,
      );
  } else if (name === TYPE) {
    refuseMisplaced(ctx, TYPE);
  } else if (name === VALUE) {
    // §9.4: "a `$value` in an object not led by `$type`" is resolver category.
    ctx
      .field(VALUE)
      .report(
        'UNKNOWN_TYPE_REF',
        "'$value' stands in an object not led by an admitted '$type' (§3.3) -- a wrapper's " +
          "'$value' follows its own leading, admitted '$type' and nothing else",
        "'$value' immediately after a leading '$type'",
        VALUE,
      );
  } else {
    refuseUnknown(ctx, name);
  }
}

// ---------------------------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------------------------

export function buildRecordReader(
  name: string,
  body: RecordBody,
  schemaLocation: SchemaLocation,
  ctx: CompileContext,
): JsonTypeReader<JsonValue> & ExactReader {
  const plan = buildRecordPlan(name, body, schemaLocation, ctx);

  const reader: JsonTypeReader<JsonValue> & ExactReader = {
    *read(readCtx: JsonReadContext): Task<JsonValue | undefined> {
      return (yield* reader.readExact(readCtx, reader)) as JsonValue | undefined;
    },
    *readExact(readCtx: JsonReadContext, wrapped: JsonTypeReader, opened = false): Task<unknown> {
      const outer = readCtx.inRecord(plan.schemaLocation);
      // `opened`: a choice-routed continuation (`json/schema/dispatchMember.ts`'s own top note,
      // `json/schema/route.ts`'s) has already consumed this object's opening brace and its own
      // leading tag for real; there is nothing left to recognize before this record's own fields,
      // so this skips straight to reading them.
      if (!opened) {
        const opening = yield* outer.next();
        if (opening.kind !== 'object-start') {
          outer.report(
            'TYPE_MISMATCH',
            `'${plan.displayName}' is a record and takes a JSON object, and this is ${describeEvent(opening)}`,
            'an object',
            describeEvent(opening),
          );
          yield* skipValue(outer, opening);
          return undefined;
        }
      }

      const reportedBefore = outer.reported();
      const slots: Slot[] = new Array<Slot>(plan.names.length).fill(undefined);
      // Every ordinary (non-`$`) member name seen so far, NFC-normalized -- tracked whether or
      // not it matches a declared field. §3.1/§9.4's table puts a repeated member name at a
      // record position under the resolver category unconditionally: identity is name identity,
      // not "identity among declared fields", so a repeated *undeclared* member is the same
      // `DUPLICATE_FIELD` error at its second occurrence, not a second `UNRECOGNIZED_FIELD`
      // (closure is validation-category and asks a different question -- does this name denote a
      // field at all -- answered once, at the name's first occurrence).
      const seen = new Set<string>();
      let position = 0;
      let tagged = false;

      for (;;) {
        const event = yield* outer.next();
        if (event.kind === 'object-end') break;
        if (event.kind !== 'member-name') {
          throw new Error(`a member name or '}' was due and the stream produced '${event.kind}'`);
        }
        const rawName = event.name;
        if (rawName.startsWith('$')) {
          if (tagged && position === 1 && rawName === VALUE) {
            const value = yield* readWrappedValue(outer, wrapped);
            return value;
          }
          if (position === 0 && rawName === TYPE) {
            const content = yield* outer.peek();
            if (admissibleTag(outer, plan, content)) {
              yield* outer.next();
              tagged = true;
              position += 1;
              continue;
            }
            yield* skipRestOfObject(outer);
            return undefined;
          }
          refuseReserved(outer, rawName, plan.displayName);
          yield* skipRestOfObject(outer);
          return undefined;
        }
        position += 1;
        const memberName = toNfc(rawName);
        const at = plan.index.get(memberName);
        if (seen.has(memberName)) {
          yield* duplicateField(outer, memberName, at !== undefined);
          continue;
        }
        seen.add(memberName);
        if (at === undefined) {
          yield* unmatched(outer, memberName);
          continue;
        }
        slots[at] = yield* readField(outer, plan, at, memberName);
      }

      if (plan.groups.length > 0) {
        validateGroups(outer, plan, slots);
      }
      fillAbsent(outer, plan, slots);

      if (outer.reported() !== reportedBefore) return undefined;
      const members = new Map<string, JsonValue>();
      for (let i = 0; i < slots.length; i += 1) {
        const node = slotToNode(slots[i]);
        const fieldName = plan.names[i];
        if (node !== undefined && fieldName !== undefined) members.set(fieldName, node);
      }
      return jsonObject(members);
    },
  };
  return reader;
}

/**
 * §3.1/§9.4: a member name (declared or not) repeated within one record, NFC identity, reported at
 * its second and every later occurrence -- resolver category throughout, unlike the
 * validation-category closure test `unmatched` runs for a name's first, undeclared occurrence.
 * `declared` picks `schemaField` over `field` exactly where `unmatched`/`readField` would have --
 * a repeated declared field still has a schema position to descend the pointer through.
 */
function* duplicateField(ctx: JsonReadContext, memberName: string, declared: boolean): Task<void> {
  const at = declared ? ctx.schemaField(memberName) : ctx.field(memberName);
  at.report(
    'DUPLICATE_FIELD',
    `'${memberName}' is written more than once in this record`,
    'each field written at most once',
    memberName,
  );
  yield* skipNextValue(at);
}

function* unmatched(ctx: JsonReadContext, memberName: string): Task<void> {
  const at = ctx.field(memberName);
  if (!nameHygieneRefuses(at, memberName)) {
    at.report(
      'UNRECOGNIZED_FIELD',
      `'${memberName}' is not a declared field of this record`,
      'a declared field',
      memberName,
    );
  }
  yield* skipNextValue(at);
}

function* readField(
  ctx: JsonReadContext,
  plan: RecordPlan,
  at: number,
  memberName: string,
): Task<Slot> {
  const field = plan.fields[at];
  if (field === undefined) throw new Error('unreachable: slot index out of range');
  const fctx = ctx.schemaField(memberName);
  if (field.role === 'FIXED') {
    return yield* verifyFixed(fctx, plan, at, memberName);
  }
  const peeked = yield* fctx.peek();
  if (peeked.kind === 'null') {
    return yield* statedNull(fctx, plan, at, memberName);
  }
  return yield* readValue(fctx, plan, at);
}

function* readValue(fctx: JsonReadContext, plan: RecordPlan, at: number): Task<Slot> {
  const reader = plan.schemaReaders[at];
  if (reader === undefined) throw new Error('unreachable: reader index out of range');
  const value = yield* reader.read(fctx);
  return value === undefined ? REFUSED : (value as JsonValue);
}

function* statedNull(
  fctx: JsonReadContext,
  plan: RecordPlan,
  at: number,
  memberName: string,
): Task<Slot> {
  yield* fctx.next();
  const field = plan.fields[at];
  if (field === undefined) throw new Error('unreachable');
  if (field.voidable) {
    return ABSENT;
  }
  if (field.role === 'DEFAULT') {
    fctx.report(
      'ATOM_CONSTRAINT_VIOLATION',
      `'${memberName}' is defaulted and not voidable, so null disclaims a value the schema ` +
        'always fills -- omit the member to take the default',
      'omission (to take the default)',
      'null',
    );
    return plan.stated[at]?.node ?? REFUSED;
  }
  fctx.report(
    'FIELD_REQUIRED',
    field.optional
      ? `'${memberName}' is not voidable, so null is not a value here -- omit the member instead`
      : `'${memberName}' is required and not voidable, and null is not a value here`,
    'a value',
    'null',
  );
  return REFUSED;
}

function* verifyFixed(
  fctx: JsonReadContext,
  plan: RecordPlan,
  at: number,
  memberName: string,
): Task<Slot> {
  const pin = plan.stated[at];
  if (pin === undefined) throw new Error('unreachable: a FIXED field with no stated value');
  const peeked = yield* fctx.peek();
  if (peeked.kind === 'null') {
    yield* fctx.next();
    fctx.report(
      'FIELD_FIXED',
      `'${memberName}' is fixed to a value, and null is never the pin`,
      identityOfHost(pin.hostValue),
      'null',
    );
    return REFUSED;
  }
  const reader = plan.fixedReaders[at];
  if (reader === undefined) throw new Error('unreachable: a FIXED field with no decoding reader');
  const before = fctx.reported();
  // Decoded, not `treeAtomReader`-wrapped: `reader` hands back the document's own host value
  // (`fixedFieldReader`'s own note on why `plan.schemaReaders[at]`, built for every other field,
  // cannot serve here), so the comparison below is value against value (§6.1.3: "against the
  // decoded value and not the spelling") -- `1`, `1.0` and `0xFF`/`255` at an `integer` field are
  // one pin, never three.
  const decoded = yield* reader.read(fctx);
  if (fctx.reported() > before) return REFUSED;
  const writtenIdentity = identityOfHost(decoded);
  const pinnedIdentity = identityOfHost(pin.hostValue);
  if (writtenIdentity !== pinnedIdentity) {
    fctx.report(
      'FIELD_FIXED',
      `'${memberName}' is fixed and this document's value contradicts it`,
      pinnedIdentity,
      writtenIdentity,
    );
  }
  return pin.node;
}

function validateGroups(ctx: JsonReadContext, plan: RecordPlan, slots: readonly Slot[]): void {
  const isPresent = (member: string): boolean => {
    const at = plan.index.get(toNfc(member));
    return at !== undefined && slots[at] !== undefined;
  };
  for (const group of plan.groups) {
    for (const refusal of groupRefusals(group, isPresent, plan.displayName)) {
      ctx.report(refusal.code, refusal.message, refusal.expected, refusal.found);
    }
  }
}

function fillAbsent(ctx: JsonReadContext, plan: RecordPlan, slots: Slot[]): void {
  for (let i = 0; i < slots.length; i += 1) {
    if (slots[i] !== undefined) continue;
    const omission = plan.omitted[i];
    const field = plan.fields[i];
    if (field === undefined) continue;
    if (omission === 'MISSING') {
      ctx
        .schemaField(field.name)
        .report(
          'FIELD_REQUIRED',
          `'${field.name}' is required and was not written`,
          'a value',
          'nothing',
        );
    } else if (omission === 'INJECTED') {
      slots[i] = plan.stated[i]?.node ?? ABSENT;
    }
  }
}
