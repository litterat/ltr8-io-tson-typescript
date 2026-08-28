/**
 * An {@link EventSource} over a fixed, in-memory list of events — the port of the reference
 * implementation's `ListEventSource`.
 *
 * Exists so a reader, which only knows how to pull from an event stream, can be run over events
 * that were never lexed: a schema-composed default literal, or an already-built `DataValue` being
 * replayed through the compiled reader for the type it belongs to
 * (`compiler/dataValueEvents.ts`). A reader cannot tell the difference, which is the point — there
 * is one reader stack, not one for documents and another for values the resolver already holds.
 *
 * It can never starve, so it never yields `NEED_INPUT`, which is what makes it safe to drive with
 * `runSync` from ordinary synchronous code.
 */
import { TsonInternalError } from '../core/errors.js';
import type { Task } from '../io/bytes.js';
import type { EventSource, TsonEvent } from './event.js';

/**
 * A source that hands back `events` in order.
 *
 * Running past the end is a {@link TsonInternalError}, not an end-of-input condition: the list is
 * a complete value by construction, so a reader asking for more has been given the wrong events,
 * which is a bug here rather than anything a document can cause.
 */
export function listEventSource(events: readonly TsonEvent[], what: string): EventSource {
  let index = 0;
  // eslint-disable-next-line require-yield -- a fixed in-memory list can never starve.
  function* pull(consume: boolean): Task<TsonEvent> {
    const event = events[index];
    if (event === undefined) {
      throw new TsonInternalError(`${what}: the replayed event list ran out before the read did`);
    }
    if (consume) index += 1;
    return event;
  }
  return { next: () => pull(true), peek: () => pull(false) };
}
