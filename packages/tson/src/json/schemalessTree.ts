/**
 * Reduces a {@link JsonEventSource} into a {@link JsonValue} tree with no schema in scope — this
 * package's own `SchemalessTreeReader`. **Genuinely schemaless**: the wire structure is the whole
 * source of truth, so an object is always a {@link JsonObject} and never resolved to a record or a
 * map here (`json/index.ts`'s own top note has the full reasoning for why that resolution has no
 * schema-free form to produce in this package at all, not only that it is out of scope).
 *
 * **Recursive over containers, and safe to be**, because `json/stream.ts` already refuses a
 * document past [TSON-JSON] §10.1's nesting bound before this ever descends into it — the same
 * property the reference implementation's own `SchemalessTreeReader` documents.
 *
 * **§3.1's duplicate-member rule lands here**, not in the event stream: the stream is grammar and
 * a repeat is not a grammar error (`json/stream.ts`'s own top note). A repeated member name is a
 * `DUPLICATE_FIELD` diagnostic reported through this read's own `DiagnosticsReceiver` at the
 * repeated occurrence's own name — not thrown directly, and not deferred until its value has been
 * read — so a *collecting* read finds every repeat in one pass and a *fail-fast* one stops at the
 * first because its receiver throws there. **Name identity for the rule is the NFC-normalized
 * decoded string** (§3.1: "matching [TSON-DATA]'s identity rules"), compared but never
 * substituted: the {@link JsonObject} this module builds keeps every member under the exact
 * decoded name its own event carried, NFC normalization applied only to decide whether two names
 * collide, never rewritten into the tree — this module's own `JsonObject` is [TSON-JSON]'s wire
 * structure held faithfully, not [TSON-DATA]'s record model, where field identity *is* the
 * NFC-normalized form. The later value wins under its own exact spelling — two members whose
 * spelling is byte-for-byte identical collapse via `Map.set` exactly as "last value wins" does
 * everywhere else in this series; two members that only collide after NFC both survive in the
 * tree, each reported once as a duplicate, since neither is a rewrite of the other.
 *
 * **The Java diverges from Part 3 here, and this port follows Part 3.** [TSON-JSON] §3.1 states
 * plainly that "Name identity for this rule is the NFC-normalized decoded string, matching
 * [TSON-DATA]'s identity rules" — but `SchemalessTreeReader.java`'s own `readObject` calls
 * `members.put(name.name(), value)`, comparing the event's already-decoded (escapes resolved, but
 * not NFC-normalized) `String` directly, so two non-NFC spellings of one name pass the Java's own
 * schemaless tree reader as distinct members with no diagnostic at all. This port instead compares
 * every member name's NFC form (`unicode/nfc.ts`'s `toNfc`) for the duplicate check, matching the
 * TSON text schemaless reader's own identity rule (`reader/schemaless/tree.ts`'s
 * `toNfc(fieldNameEvent.name)`) and the letter of §3.1 — while still keeping the original spelling
 * in the tree, per the paragraph above.
 */
import type { DiagnosticsReceiver } from '../core/diagnostic.js';
import { TsonInternalError } from '../core/errors.js';
import type { Task } from '../io/bytes.js';
import { toNfc } from '../unicode/nfc.js';
import { createJsonReadContext, type JsonReadContext } from './readContext.js';
import type { JsonEvent, JsonEventSource } from './stream.js';
import {
  jsonArray,
  jsonBoolean,
  jsonNull,
  jsonNumber,
  jsonObject,
  jsonString,
  type JsonValue,
} from './tree.js';

/** Reads one value at `ctx`'s current position, `first` being its opening event, already pulled. */
export function* readJsonValue(ctx: JsonReadContext, first: JsonEvent): Task<JsonValue> {
  switch (first.kind) {
    case 'string':
      return jsonString(first.value);
    case 'number':
      return jsonNumber(first.literal);
    case 'boolean':
      return jsonBoolean(first.value);
    case 'null':
      return jsonNull();
    case 'object-start':
      return yield* readObject(ctx);
    case 'array-start':
      return yield* readArray(ctx);
    default:
      throw new TsonInternalError(`a value was due and the stream produced '${first.kind}'`);
  }
}

/** Reads one value, pulling its opening event first — the front door's whole-document entry point plus framing. */
export function* readJsonValueFromRoot(ctx: JsonReadContext): Task<JsonValue> {
  return yield* readJsonValue(ctx, yield* ctx.next());
}

function* readObject(ctx: JsonReadContext): Task<JsonValue> {
  const members = new Map<string, JsonValue>();
  const seenIdentities = new Set<string>();
  for (;;) {
    const event = yield* ctx.next();
    if (event.kind === 'object-end') return jsonObject(members);
    if (event.kind !== 'member-name') {
      throw new TsonInternalError(
        `a member name or '}' was due and the stream produced '${event.kind}'`,
      );
    }
    // The tree keeps this member under its exact decoded spelling (`event.name`) -- NFC only
    // decides whether it collides with an earlier one (§3.1), never what gets stored.
    const name = event.name;
    const identity = toNfc(name);
    const at = ctx.field(name);
    // Reported here, at the repeated name's own position -- before its value is read at all, so
    // the diagnostic never drifts to wherever that value happens to end (§3.1, Part 1 §2.6).
    if (seenIdentities.has(identity)) {
      at.report(
        'DUPLICATE_FIELD',
        `'${name}' is already a member of this object, and a member name appears once (§3.1)`,
        'each member stated once',
        `'${name}' stated again`,
      );
    } else {
      seenIdentities.add(identity);
    }
    const value = yield* readJsonValue(at, yield* at.next());
    members.set(name, value);
  }
}

function* readArray(ctx: JsonReadContext): Task<JsonValue> {
  const elements: JsonValue[] = [];
  for (;;) {
    const event = yield* ctx.next();
    if (event.kind === 'array-end') return jsonArray(elements);
    elements.push(yield* readJsonValue(ctx.index(elements.length), event));
  }
}

/**
 * Reads a whole JSON document from `events` into a {@link JsonValue}, reporting through `receiver`
 * and rejecting trailing content (pulling past the root value, per `json/stream.ts`'s own
 * `end-of-document` note).
 */
export function* readJsonDocument(
  events: JsonEventSource,
  receiver: DiagnosticsReceiver,
): Task<JsonValue> {
  const ctx = createJsonReadContext(events, receiver);
  const value = yield* readJsonValueFromRoot(ctx);
  const end = yield* ctx.next();
  if (end.kind !== 'end-of-document') {
    throw new TsonInternalError(
      `the document's root value ended and the stream produced '${end.kind}'`,
    );
  }
  return value;
}
