/**
 * A closed record as a JSON object ([TSON-JSON] §6.1, minus §6.1.5's dispatch — see
 * `json/schema/compile.ts`'s own top note on why an ABSTRACT/member-dispatched position never
 * reaches this module at all). One member per present field, member name = field name (NFC), and
 * every rule of §6.1.1–§6.1.4/§6.1.6 applied in one loop that fills a slot per field and hands the
 * slots to a tree builder once — the port of the Java reference's `RecordPlan`/`RecordReader`/
 * `TreeRecordBuilder`, collapsed into one file since this package builds tree mode alone.
 *
 * **§3.2's reserved namespace, without §3.3's annotation object.** A member name beginning with
 * `$` never matches a declared field (§3.2: "no identifier begins with `$`"), so it is never a
 * §6.1.1 closure violation. Two cases, decided without needing §3.3's own apparatus (reading a
 * wrapper or an inline tag), which this package does not implement yet:
 *
 * - **One of the three reserved names** (`$schema`, `$type`, `$value`) needs that apparatus to
 *   interpret at all — whether the object is a redundant tag, a genuine subtype selection, or a
 *   wrapper changes what the *rest* of the object means, none of which this module can decide. It
 *   reports `NOT_IMPLEMENTED` (a gap, not a verdict) and stops judging this record's remaining
 *   members entirely — reading past it as an ordinary closed record would report false verdicts
 *   (`UNRECOGNIZED_FIELD` on a field a subtype the tag selects genuinely declares) against a
 *   shape this module never actually understood.
 * - **Any other `$`-initial name** is decidable on its own: §3.2's reserved set is closed, so a
 *   name outside the three-member table is a resolver error at this position regardless of what
 *   the rest of the object turns out to mean, and the read continues past it — it says nothing
 *   about dispatch either way.
 *
 * **A recognized field is read at `ctx.schemaField(name)`, never `ctx.field(name)` followed by a
 * second step.** `schemaField` extends both the data path and (once `inRecord` has anchored one)
 * the schema pointer in one step; `field` extends the data path alone, and is used here only for
 * an *unmatched* member, which names no field for a schema pointer to extend to.
 */
import type { SchemaLocation } from '../../core/diagnostic.js';
import type { Task } from '../../io/bytes.js';
import { terminalDefinition } from '../../link/referenceChain.js';
import {
  fieldOmission,
  isGroupMember,
  type FieldGroup,
  type FieldOmission,
  type RecordBody,
  type RecordField,
} from '../../schema/meta/bodies.js';
import type { Atom } from '../../schema/meta/typedef.js';
import { toNfc } from '../../unicode/nfc.js';
import type { JsonReadContext } from '../readContext.js';
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
import { skipNextValue, skipValue } from './eventSkip.js';
import { nameHygieneRefuses } from './nameHygiene.js';
import type { JsonTypeReader } from './types.js';
import { identityOfHost } from './valueIdentity.js';

/** A field's schema-stated `~`/`=` value, resolved once at compile time: the host value it denotes (for the FIXED comparison) and the JSON node that spells it (for injection, §6.1.3). */
interface FieldValue {
  readonly hostValue: unknown;
  readonly node: JsonValue;
}

/**
 * [TSON-JSON] §6.1.3: "rendered from the decoded value, not from the token" -- radix and digit
 * separators do not survive (§4.3); a string-content family keeps its token, since the token *is*
 * the spelling there. `tokenText` is `write(hostValue)` when the family's parser has a `write`
 * (every `number`/`number-or-string` family does -- `fieldValueOf`'s own note), so the exact and
 * approximate-numeric cases render through it rather than re-deriving a spelling from `hostValue`
 * by its JS `typeof` (which cannot render a `number` family's {@link TsonDecimal} host value at
 * all, and is why this function used to throw on one -- fixed here, not worked around).
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

/** `fieldTypeName`'s reference chain walked to the atom body it terminates at (§8.3) — the one step {@link fieldValueOf} and {@link fixedFieldReader} share. */
function resolveFieldBody(ctx: CompileContext, fieldTypeName: string): Atom {
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

/** `fieldTypeName`'s reference chain walked to an atom (§8.3), and its stated `token` resolved against it — the port of the Java reference's `FieldValue.of`. */
function fieldValueOf(
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
  if (body.kind === 'unit' && fieldTypeName === 'identifier') {
    return identifierReader(fieldTypeName, schemaLocation);
  }
  return atomReader(fieldTypeName, body, schemaLocation);
}

// ---------------------------------------------------------------------------------------------
// RecordPlan -- what the schema fixes, resolved once
// ---------------------------------------------------------------------------------------------

interface RecordPlan {
  readonly displayName: string;
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
  readonly groupSlots: readonly (readonly number[])[];
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

  const groupSlots = body.groups.map((group) =>
    group.members.map((member) => index.get(toNfc(member)) ?? -1),
  );

  return {
    displayName: name,
    schemaLocation,
    names,
    fields,
    omitted,
    schemaReaders,
    fixedReaders,
    stated,
    index,
    groups: body.groups,
    groupSlots,
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

/** §3.2's table — the only three names the reserved namespace admits. */
const RESERVED_MEMBERS: ReadonlySet<string> = new Set(['$schema', '$type', '$value']);

/** Consumes every remaining member of the object this context is inside, reporting nothing — for a record read that has learned it cannot judge the rest of this object (a reserved member requiring §3.3's own apparatus was met). Keeps the event stream balanced without drawing any further verdict. */
function* skipRestOfObject(ctx: JsonReadContext): Task<void> {
  for (;;) {
    const event = yield* ctx.next();
    if (event.kind === 'object-end') return;
    if (event.kind !== 'member-name') {
      throw new Error(`a member name or '}' was due and the stream produced '${event.kind}'`);
    }
    yield* skipNextValue(ctx);
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
): JsonTypeReader<JsonValue> {
  const plan = buildRecordPlan(name, body, schemaLocation, ctx);

  return {
    *read(readCtx: JsonReadContext): Task<JsonValue | undefined> {
      const outer = readCtx.inRecord(plan.schemaLocation);
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

      const reportedBefore = outer.reported();
      const slots: Slot[] = new Array<Slot>(plan.names.length).fill(undefined);
      let dispatchNeeded = false;

      for (;;) {
        const event = yield* outer.next();
        if (event.kind === 'object-end') break;
        if (event.kind !== 'member-name') {
          throw new Error(`a member name or '}' was due and the stream produced '${event.kind}'`);
        }
        if (event.name.startsWith('$')) {
          const at = outer.field(event.name);
          if (RESERVED_MEMBERS.has(event.name)) {
            at.report(
              'NOT_IMPLEMENTED',
              `'${event.name}' is a reserved member ([TSON-JSON] §3.2), and the annotation ` +
                'object (§3.3) that would interpret it is not built yet',
            );
            yield* skipNextValue(at);
            // Whatever this object means from here is §3.3's to decide (a redundant tag, a
            // subtype selection whose own fields this plan does not know, or a wrapper whose
            // other members are not this record's fields at all) -- so no further member of it
            // draws a verdict from this plan; only the stream stays balanced.
            yield* skipRestOfObject(outer);
            dispatchNeeded = true;
            break;
          }
          // Outside the three-member table, §3.2's closed set already answers this on its own,
          // with no dispatch apparatus needed -- decidable and reported regardless of what the
          // rest of the object turns out to mean.
          at.report(
            'UNKNOWN_TYPE_REF',
            `'${event.name}' begins with '$' and is not one of this encoding's reserved ` +
              `members ($schema, $type, $value) -- [TSON-JSON] §3.2's reserved namespace is closed`,
            'a declared field, or one of $schema/$type/$value',
            event.name,
          );
          yield* skipNextValue(at);
          continue;
        }
        const memberName = toNfc(event.name);
        const at = plan.index.get(memberName);
        if (at === undefined) {
          yield* unmatched(outer, memberName);
          continue;
        }
        if (slots[at] !== undefined) {
          outer
            .schemaField(memberName)
            .report(
              'DUPLICATE_FIELD',
              `'${memberName}' is written more than once in this record`,
              'each field written at most once',
              memberName,
            );
        }
        slots[at] = yield* readField(outer, plan, at, memberName);
      }

      if (!dispatchNeeded) {
        if (plan.groups.length > 0) {
          validateGroups(outer, plan, slots);
        }
        fillAbsent(outer, plan, slots);
      }

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
    `'${memberName}' is required and not voidable, and null is not a value here`,
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
  for (let g = 0; g < plan.groupSlots.length; g += 1) {
    const memberSlots = plan.groupSlots[g];
    const group = plan.groups[g];
    if (memberSlots === undefined || group === undefined) continue;
    let present = 0;
    for (const at of memberSlots) {
      if (at >= 0 && slots[at] !== undefined) present += 1;
    }
    if (present > 1) {
      ctx.report(
        'TYPE_MISMATCH',
        `at most one of (${group.members.join(' | ')}) may be present, and ${String(present)} are`,
        'at most one',
        String(present),
      );
    } else if (group.state === 'REQUIRED' && present === 0) {
      ctx.report(
        'FIELD_REQUIRED',
        `exactly one of (${group.members.join(' | ')}) is required, and none is present`,
        'exactly one',
        'none',
      );
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
