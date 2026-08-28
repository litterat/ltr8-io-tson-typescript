/**
 * Replays an already-built `ast/value.ts` {@link DataValue} as the exact {@link TsonEvent}
 * sequence a real `stream/dataStream.ts` would have produced for the same source text — the port
 * of the reference implementation's `DataValueEvents`.
 *
 * **Why a value that is already a tree gets turned back into events.** The compiled readers are
 * streaming-only by construction (`reader/contracts.ts`: `TypeReader.read(ctx)` pulls from an
 * {@link EventSource} and nothing else), and the resolver holds values it built without ever
 * lexing them — an annotation's value, a constructor application's payload. Replaying is what lets
 * one reader stack serve both, instead of a second, tree-shaped reader stack existing only for the
 * resolver's benefit and drifting from the first.
 *
 * Every synthesized event carries the same placeholder position. There is no real source position
 * for a value that was never re-lexed, and nothing downstream depends on one being meaningful —
 * a diagnostic raised while reading a replayed value is attributed by its caller, which knows the
 * declaration it came from.
 */
import type {
  ArrayValue,
  CoreValue,
  DataValue,
  MapValue,
  RecordValue,
  ScopedValue,
} from '../ast/value.js';
import { START, type Position } from '../core/position.js';
import type { TsonEvent } from '../stream/event.js';

const PLACEHOLDER: Position = START;

/** `value`'s events, in the order a real read of the same text would have produced them. */
export function dataValueEvents(value: DataValue): readonly TsonEvent[] {
  const events: TsonEvent[] = [];
  emitDataValue(value, events);
  return events;
}

function emitDataValue(value: DataValue, events: TsonEvent[]): void {
  for (const annotation of value.annotations) {
    events.push({ kind: 'annotation-start', name: annotation.name, position: PLACEHOLDER });
    if (annotation.value !== undefined) emitDataValue(annotation.value, events);
    events.push({ kind: 'annotation-end', position: PLACEHOLDER });
  }
  if (value.typeRef !== undefined) {
    events.push({ kind: 'type-ref', name: value.typeRef, position: PLACEHOLDER });
  }
  emitCoreValue(value.coreValue, events);
}

function emitScopedValue(scoped: ScopedValue, events: TsonEvent[]): void {
  if (scoped.schemaRef !== undefined) {
    events.push({ kind: 'schema-ref', uri: scoped.schemaRef, position: PLACEHOLDER });
  }
  emitDataValue(scoped.value, events);
}

function emitRecord(record: RecordValue, events: TsonEvent[]): void {
  events.push({ kind: 'record-start', position: PLACEHOLDER });
  for (const field of record.fields) {
    events.push({ kind: 'field-name', name: field.name, position: PLACEHOLDER });
    emitScopedValue(field.value, events);
  }
  events.push({ kind: 'record-end', position: PLACEHOLDER });
}

function emitMap(map: MapValue, events: TsonEvent[]): void {
  events.push({ kind: 'map-start', position: PLACEHOLDER });
  for (const entry of map.entries) {
    emitDataValue(entry.key, events);
    events.push({ kind: 'map-arrow', position: PLACEHOLDER });
    emitScopedValue(entry.value, events);
  }
  events.push({ kind: 'map-end', position: PLACEHOLDER });
}

function emitArray(array: ArrayValue, events: TsonEvent[]): void {
  events.push({ kind: 'array-start', position: PLACEHOLDER });
  for (const element of array.elements) emitScopedValue(element, events);
  events.push({ kind: 'array-end', position: PLACEHOLDER });
}

function emitCoreValue(core: CoreValue, events: TsonEvent[]): void {
  switch (core.kind) {
    case 'record':
      emitRecord(core, events);
      return;
    case 'map':
      emitMap(core, events);
      return;
    case 'array':
      emitArray(core, events);
      return;
    case 'empty-brace':
      events.push({ kind: 'empty-brace', position: PLACEHOLDER });
      return;
    case 'absent':
      events.push({ kind: 'absent', position: PLACEHOLDER });
      return;
    case 'token':
      events.push({ kind: 'token', text: core.text, form: core.form, position: PLACEHOLDER });
      return;
  }
}
