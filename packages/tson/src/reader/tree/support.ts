/**
 * Small pieces every tree reader in this directory shares but that don't belong to any one of them:
 * a name -> compiled tree reader lookup ({@link TreeTypeResolver}, the port of Java's
 * `TsonTypeReaderResolver`, scoped to tree mode), a synthetic single-event source for resolving a
 * field/element's schema-composed default once at construction (`RecordAbstractReader.readSchemaDefault`),
 * and a short renderer for a {@link Value} used only in diagnostic `expected`/`actual` text.
 */
import { TsonReadError } from '../../core/errors.js';
import { throwing } from '../../core/diagnostic.js';
import { runSync } from '../../io/bytes.js';
import { START } from '../../core/position.js';
import type { Task } from '../../io/bytes.js';
import type { EventSource, TokenEvent, TsonEvent } from '../../stream/event.js';
import type { TokenForm as EventTokenForm } from '../../lexer/token.js';
import type { Token, TokenForm as SchemaTokenForm } from '../../schema/meta/typedef.js';
import { createReadContext } from '../context.js';
import type { TypeReader } from '../contracts.js';
import type { AtomValue, Value } from '../../tree/nodes.js';

/**
 * `typeName -> the compiled tree reader for it`, resolved once per record/map/array/tuple body at
 * construction -- the tree-mode instance of Java's `TsonTypeReaderResolver`. Supplied by whoever wires
 * a whole schema's worth of readers together (Wave 5's compiler); this directory only consumes one.
 */
export type TreeTypeResolver = (typeName: string) => TypeReader<Value>;

/** A fixed, in-memory {@link EventSource} over `events` -- the port of Java's `ListEventSource`, used only to replay a schema-composed literal through its own field's parser. */
function listEventSource(events: readonly TsonEvent[]): EventSource {
  let index = 0;
  // eslint-disable-next-line require-yield -- this source is a fixed in-memory list; it can never starve, so it never yields NEED_INPUT.
  function* pull(consume: boolean): Task<TsonEvent> {
    const event = events[index];
    if (event === undefined) {
      throw new Error(
        'listEventSource: no more events -- a schema default must be exactly one token',
      );
    }
    if (consume) index += 1;
    return event;
  }
  return {
    next: () => pull(true),
    peek: () => pull(false),
  };
}

const TOKEN_FORM: Record<SchemaTokenForm, EventTokenForm> = {
  UNQUOTED: 'unquoted',
  SINGLE_LINE_QUOTED: 'single-line',
  MULTI_LINE_QUOTED: 'multi-line',
};

/**
 * Reads a field/element's schema-composed literal ({@link Token}) through `parser`, the same field's
 * own type reader -- run eagerly and synchronously at construction, exactly as
 * `RecordAbstractReader.readSchemaDefault` does. Safe to drive with {@link runSync} rather than
 * suspending the whole factory function into a `Task`: the source is one in-memory token, never real
 * I/O, so nothing here can ever yield `NEED_INPUT` (`io/bytes.ts`'s own "in sync mode nothing ever
 * suspends" guarantee).
 */
export function readSchemaLiteral(token: Token, parser: TypeReader<Value>): Value {
  const event: TokenEvent = {
    kind: 'token',
    text: token.text,
    form: TOKEN_FORM[token.form],
    position: START,
  };
  const ctx = createReadContext(
    listEventSource([event]),
    throwing((d) => new TsonReadError(d)),
  );
  return runSync(parser.read(ctx));
}

function renderAtomValue(value: AtomValue): string {
  if (typeof value === 'bigint' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Uint8Array) {
    return `<${String(value.length)} bytes>`;
  }
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
}

/** A short rendering of a {@link Value}, for a diagnostic's `expected`/`actual` text only -- never asserted by the conformance suite, which checks `category` alone. */
export function renderValue(value: Value): string {
  switch (value.kind) {
    case 'atom':
      return renderAtomValue(value.value);
    case 'absent':
      return "the absent sentinel '_'";
    case 'record':
      return `a record${value.typeRef !== undefined ? ` '${value.typeRef}'` : ''}`;
    case 'map':
      return 'a map';
    case 'array':
      return 'an array';
    case 'tuple':
      return 'a tuple';
    case 'missing':
      return '(missing)';
  }
}
