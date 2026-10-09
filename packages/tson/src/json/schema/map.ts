/**
 * A map in one of its two JSON forms ([TSON-JSON] §6.4), selected by the key type and never by
 * inspecting the value:
 *
 * - **Object form** — `K` resolves, after its reference chain, to an atom-family instance,
 *   `identifier`, or an enum (never `value` or `void`, neither of which reads token content). The
 *   map is a JSON object; each member name is a key token, faced to `K`'s own parsing contract
 *   exactly as §5.1 hands value strings, and identity is over the decoded key's value space —
 *   `"1"`/`"1.0"` under a `number` key are one key.
 * - **Pairs form** — every other `K` (a record, tuple, array, map, or choice). The map is a JSON
 *   array of two-element arrays, each key read at `K`'s own reader; a compound key compares by the
 *   `JsonValue` tree its reader produced, reduced the same way (§6.1.6: member order carries none).
 *
 * `{K => V?}` admits JSON null as an entry's void value in either form — present, counting
 * toward the size bounds, carrying none; `{K => V}` refuses one, as with an array element (§7).
 */
import { diagnosticCodeForAtomError, type SchemaLocation } from '../../core/diagnostic.js';
import { TsonAtomParseError, TsonAtomValidationError } from '../../core/errors.js';
import type { Task } from '../../io/bytes.js';
import { terminal, terminalDefinition } from '../../link/referenceChain.js';
import type { MapBody } from '../../schema/meta/bodies.js';
import type { Atom } from '../../schema/meta/typedef.js';
import type { JsonReadContext } from '../readContext.js';
import type { JsonEvent } from '../stream.js';
import { jsonArray, jsonNull, jsonObject, type JsonValue } from '../tree.js';
import { describeEvent, enumFormOf, fieldValueParser, type FieldValueParser } from './atoms.js';
import { reportConfusablePair, valueNameRefuses } from './nameHygiene.js';
import { createConfusableScope } from '../../unicode/skeleton.js';
import type { CompileContext } from './compile.js';
import { skipNextValue, skipValue } from './eventSkip.js';
import { tokenHygieneRefuses } from './tokenHygiene.js';
import type { JsonTypeReader } from './types.js';
import { declareOrder } from '../../value/orderedness.js';
import { identityOfHost, identityOfNode } from './valueIdentity.js';

const VOID = Symbol('json.map.void');
const REFUSED = Symbol('json.map.refused');
type Slot = JsonValue | typeof VOID | typeof REFUSED;

function slotNode(slot: Slot | undefined): JsonValue | undefined {
  if (slot === undefined || slot === REFUSED) return undefined;
  return slot === VOID ? jsonNull() : slot;
}

/** `K`'s own scalar parser, when `K`'s reference chain ends at a type a single scalar token denotes — `undefined` for every other `K`, which takes the pairs form. */
function scalarKeyParser(ctx: CompileContext, keyTypeName: string): FieldValueParser | undefined {
  const entries = ctx.linkedSchema.entries;
  const lookup = (name: string) => entries.get(name);
  const definition = terminalDefinition(keyTypeName, lookup);
  if (definition === undefined) return undefined;
  const terminalName = terminal(keyTypeName, lookup);
  const body = definition.body;
  if ('template' in body && 'parameters' in body) return undefined;
  if (body.kind === 'reference') return undefined;
  if (body.kind === 'value_type' || body.kind === 'void_type') return undefined; // no content grammar
  if (!isAtomKind(body.kind)) return undefined; // record/array/map/tuple/choice/scoped/Data
  try {
    return fieldValueParser(terminalName, body as Atom, enumFormOf(ctx.linkedSchema, terminalName));
  } catch {
    return undefined;
  }
}

const ATOM_KINDS: ReadonlySet<string> = new Set([
  'value_type',
  'void_type',
  'enum',
  'integer_type',
  'text_type',
  'identifier_type',
  'uri_type',
  'iri_type',
  'regex_type',
  'decimal_type',
  'float_type',
  'rational_type',
  'uuid_type',
  'bytes_type',
  'date_type',
  'time_type',
  'datetime_type',
  'duration_type',
  'period_type',
  'cidr4_type',
  'cidr6_type',
  'email_type',
  'mac_type',
  'ipv4_type',
  'ipv6_type',
  'complex_type',
]);

function isAtomKind(kind: string): boolean {
  return ATOM_KINDS.has(kind);
}

export function buildMapReader(
  name: string,
  body: MapBody,
  schemaLocation: SchemaLocation,
  ctx: CompileContext,
): JsonTypeReader<JsonValue> {
  const optionalValues = body.voidable;
  const minItems = body.minItems;
  const maxItems = body.maxItems;
  const valueReader = ctx.resolve(body.valueType.name);
  const keyParser = scalarKeyParser(ctx, body.keyType.name);

  return keyParser !== undefined
    ? objectFormReader(
        name,
        schemaLocation,
        keyParser,
        valueReader,
        optionalValues,
        body.ordered,
        minItems,
        maxItems,
      )
    : pairsFormReader(
        name,
        schemaLocation,
        ctx.resolve(body.keyType.name),
        valueReader,
        optionalValues,
        body.ordered,
        minItems,
        maxItems,
      );
}

/**
 * An object-form map's keys. Where the key type is an identifier family the keys are names
 * ([TSON-DATA] §8.2): each is judged under the family's profile, and they are one naming scope
 * ([TSON-SCHEMA] §11.4), so a key reading alike with an earlier one is reported at its own member
 * (`CONFUSABLE_NAMES`) and its entry read normally. A key whose reading reported -- its policy
 * refusal included -- is no name of the scope, for the reason it is not in the duplicate check.
 */
function objectFormReader(
  name: string,
  schemaLocation: SchemaLocation,
  keyParser: FieldValueParser,
  valueReader: JsonTypeReader,
  optionalValues: boolean,
  ordered: boolean,
  minItems: bigint | undefined,
  maxItems: bigint | undefined,
): JsonTypeReader<JsonValue> {
  return {
    *read(readCtx: JsonReadContext): Task<JsonValue | undefined> {
      const outer = readCtx.underDeclaration(schemaLocation);
      const first = yield* outer.next();
      if (first.kind !== 'object-start') {
        yield* wrongShape(outer, name, first);
        return undefined;
      }
      const reportedBefore = outer.reported();
      const names: string[] = [];
      const values: Slot[] = [];
      const byIdentity = new Map<string, number>();
      const scope =
        keyParser.profile !== undefined && readCtx.identifierPolicy().skeletonDistinctness
          ? createConfusableScope()
          : undefined;
      let count = 0;

      for (;;) {
        const event = yield* outer.next();
        if (event.kind === 'object-end') break;
        if (event.kind !== 'member-name') {
          throw new Error(`a member name or '}' was due and the stream produced '${event.kind}'`);
        }
        count += 1;
        const at = outer.field(event.name);
        // [TSON-JSON] §9.4: the token policy, when a deployment sets one, reaches map keys -- an
        // object-form key never reaches `keyParser`'s own reader (it is read straight off the
        // member-name event, not through a nested value), so this is the one place object-form
        // keys need their own check; a pairs-form key reads through `keyReader.read` (an ordinary
        // `AtomReader`), which `atoms.ts`'s own `makeAtomReader` already covers.
        if (tokenHygieneRefuses(at, event.name)) {
          yield* entryValue(at, valueReader, optionalValues, event.name);
          continue;
        }
        let hostKey: unknown;
        try {
          hostKey = keyParser.parse(event.name);
        } catch (error) {
          // §9.4: a name the key type's parsing contract rejects outright is a resolver error
          // (`ATOM_FORM_INVALID`); a name that parses but violates a declared constraint is a
          // validation error (`ATOM_CONSTRAINT_VIOLATION`) -- the same split `atoms.ts`'s own
          // `makeAtomReader` applies to a value, via the same `diagnosticCodeForAtomError`.
          // Anything else is a library bug and must not be swallowed.
          if (error instanceof TsonAtomParseError || error instanceof TsonAtomValidationError) {
            at.report(diagnosticCodeForAtomError(error), error.message, error.expected, event.name);
          } else {
            throw error;
          }
          yield* entryValue(at, valueReader, optionalValues, event.name);
          continue;
        }
        if (
          keyParser.profile !== undefined &&
          typeof hostKey === 'string' &&
          valueNameRefuses(at, hostKey, keyParser.profile)
        ) {
          yield* entryValue(at, valueReader, optionalValues, event.name);
          continue;
        }
        const entry = yield* entryValue(at, valueReader, optionalValues, event.name);
        const identity = identityOfHost(hostKey);
        const slot = byIdentity.get(identity);
        if (slot !== undefined) {
          at.report(
            'DUPLICATE_MAP_KEY',
            `'${event.name}' repeats a key already present in '${name}'`,
            'each key present once',
            event.name,
          );
          values[slot] = entry;
          continue;
        }
        byIdentity.set(identity, names.length);
        if (scope !== undefined && typeof hostKey === 'string') {
          const collision = scope.add(hostKey);
          if (collision !== undefined) reportConfusablePair(at, collision, 'keys');
        }
        names.push(event.name);
        values.push(entry);
      }
      checkSize(outer, name, count, minItems, maxItems);

      if (outer.reported() !== reportedBefore) return undefined;
      const members = new Map<string, JsonValue>();
      for (let i = 0; i < names.length; i += 1) {
        const memberName = names[i];
        const node = slotNode(values[i]);
        if (memberName !== undefined && node !== undefined) members.set(memberName, node);
      }
      return declareOrder(jsonObject(members), ordered);
    },
  };
}

function pairsFormReader(
  name: string,
  schemaLocation: SchemaLocation,
  keyReader: JsonTypeReader,
  valueReader: JsonTypeReader,
  optionalValues: boolean,
  ordered: boolean,
  minItems: bigint | undefined,
  maxItems: bigint | undefined,
): JsonTypeReader<JsonValue> {
  return {
    *read(readCtx: JsonReadContext): Task<JsonValue | undefined> {
      const outer = readCtx.underDeclaration(schemaLocation);
      const first = yield* outer.next();
      if (first.kind !== 'array-start') {
        yield* wrongShape(outer, name, first);
        return undefined;
      }
      const reportedBefore = outer.reported();
      const keys: Slot[] = [];
      const values: Slot[] = [];
      const byIdentity = new Map<string, number>();
      let count = 0;

      for (;;) {
        const peeked = yield* outer.peek();
        if (peeked.kind === 'array-end') break;
        const at = outer.index(count);
        yield* readPair(
          at,
          count,
          name,
          keyReader,
          valueReader,
          optionalValues,
          byIdentity,
          keys,
          values,
        );
        count += 1;
      }
      yield* outer.next(); // array-end
      checkSize(outer, name, count, minItems, maxItems);

      if (outer.reported() !== reportedBefore) return undefined;
      const pairs: JsonValue[] = [];
      for (let i = 0; i < keys.length; i += 1) {
        const k = slotNode(keys[i]);
        const v = slotNode(values[i]);
        if (k !== undefined && v !== undefined) pairs.push(jsonArray([k, v]));
      }
      return declareOrder(jsonArray(pairs), ordered);
    },
  };
}

function* readPair(
  at: JsonReadContext,
  index: number,
  name: string,
  keyReader: JsonTypeReader,
  valueReader: JsonTypeReader,
  optionalValues: boolean,
  byIdentity: Map<string, number>,
  keys: Slot[],
  values: Slot[],
): Task<void> {
  const opening = yield* at.next();
  if (opening.kind !== 'array-start') {
    at.report(
      'TYPE_MISMATCH',
      `'${name}' is in pairs form, whose every element is a two-element array, and this is ${describeEvent(opening)}`,
      'a two-element array',
      describeEvent(opening),
    );
    yield* skipValue(at, opening);
    return;
  }
  const afterOpen = yield* at.peek();
  if (afterOpen.kind === 'array-end') {
    yield* at.next();
    at.report(
      'WRONG_ARITY',
      `'${name}' is in pairs form and this entry has no key`,
      'a two-element array',
      'an empty array',
    );
    return;
  }
  const before = at.reported();
  const decodedKey = yield* keyReader.read(at.index(0));
  const afterKey = yield* at.peek();
  if (afterKey.kind === 'array-end') {
    yield* at.next();
    at.report(
      'WRONG_ARITY',
      `'${name}' is in pairs form and this entry has no value`,
      'a two-element array',
      'a one-element array',
    );
    return;
  }
  const entry = yield* entryValue(at.index(1), valueReader, optionalValues, String(index));
  if (decodedKey !== undefined && at.reported() === before) {
    const identity = identityOfNode(decodedKey as JsonValue);
    if (byIdentity.has(identity)) {
      at.report(
        'DUPLICATE_MAP_KEY',
        `entry ${String(index)} of '${name}' repeats a key already present`,
        'each key present once',
        String(index),
      );
    } else {
      byIdentity.set(identity, index);
    }
  }
  const afterValue = yield* at.peek();
  if (afterValue.kind !== 'array-end') {
    at.report(
      'WRONG_ARITY',
      `'${name}' is in pairs form and this entry has more than a key and a value`,
      'a two-element array',
      'a longer array',
    );
    for (;;) {
      const p = yield* at.peek();
      if (p.kind === 'array-end') break;
      yield* skipNextValue(at);
    }
  }
  yield* at.next(); // the pair's own array-end
  keys.push(decodedKey === undefined ? REFUSED : (decodedKey as JsonValue));
  values.push(entry);
}

function* entryValue(
  at: JsonReadContext,
  valueReader: JsonTypeReader,
  optionalValues: boolean,
  keySegment: string,
): Task<Slot> {
  const peeked = yield* at.peek();
  if (peeked.kind === 'null') {
    yield* at.next();
    if (!optionalValues) {
      at.report(
        'FIELD_REQUIRED',
        `the value at '${keySegment}' is required, and null is not a value here`,
        'a value',
        'null',
      );
    }
    return VOID;
  }
  const value = yield* valueReader.read(at);
  return value === undefined ? REFUSED : (value as JsonValue);
}

function* wrongShape(ctx: JsonReadContext, name: string, found: JsonEvent): Task<void> {
  ctx.report(
    'TYPE_MISMATCH',
    `'${name}' takes ${found.kind === 'array-start' || found.kind === 'object-start' ? 'the other JSON container kind for its key type' : 'an object or an array'}, and this is a ${found.kind}`,
    'the wire form this key type selects',
    found.kind,
  );
  yield* skipValue(ctx, found);
}

function checkSize(
  ctx: JsonReadContext,
  name: string,
  count: number,
  minItems: bigint | undefined,
  maxItems: bigint | undefined,
): void {
  const size = BigInt(count);
  if (minItems !== undefined && size < minItems) {
    ctx.report(
      'TYPE_MISMATCH',
      `'${name}' takes at least ${minItems.toString()} entries, and this has ${String(count)}`,
      `>= ${minItems.toString()}`,
      String(count),
    );
  }
  if (maxItems !== undefined && size > maxItems) {
    ctx.report(
      'TYPE_MISMATCH',
      `'${name}' takes at most ${maxItems.toString()} entries, and this has ${String(count)}`,
      `<= ${maxItems.toString()}`,
      String(count),
    );
  }
}
