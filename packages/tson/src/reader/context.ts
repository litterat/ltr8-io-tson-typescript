/**
 * The one implementation of {@link ReadContext} -- the port of `DefaultTsonReadContext`
 * (`tson-compiler/.../DefaultTsonReadContext.java`). Every scoped copy `field`/`index`/
 * `schemaField`/`inRecord`/`underDeclaration`/`withPosition` hands back shares the same
 * {@link Cursor}: one real pull cursor, one diagnostics receiver, one running report count, no
 * matter how many copies a read has made of the context it descends through.
 *
 * **Memory stays proportional to nesting depth.** A path step links to its parent rather than
 * concatenating a string at every descent (`PathStep`, mirroring the Java's own `record PathStep`)
 * -- a read that reports nothing, which is every read of a valid document, pays one linked node
 * per open container and renders no string at all. `path()`/`schemaLocation()` walk the chain only
 * when asked, exactly once per diagnostic.
 *
 * **`peek`/`next` update the shared cursor's position on every pull, `peek` included** -- matching
 * the Java original, whose {@link Cursor}-equivalent doc calls this out explicitly: a lookahead
 * that only peeks still moves {@link ReadContext.position} to reflect what it saw.
 */
import type { Task } from '../io/bytes.js';
import type { Position } from '../core/position.js';
import type {
  Diagnostic,
  DiagnosticCode,
  DiagnosticsReceiver,
  SchemaLocation,
} from '../core/diagnostic.js';
import { TsonInternalError, TsonReadError } from '../core/errors.js';
import {
  DEFAULT_MAX_NESTING_DEPTH,
  maxNestingDepthOf,
  nestingLimitExpectation,
  nestingLimitMessage,
  type NestingLimitOptions,
} from '../core/limits.js';
import type { EventSource, TsonEvent } from '../stream/event.js';
import type { ReadContext } from './contracts.js';

// ---------------------------------------------------------------------------------------------
// RFC 6901 escaping -- `~` before `/`, matching `tree/accessors.ts`'s own (unexported) helper.
// Duplicated rather than imported: this is a two-line pure function, and `reader/` has no reason
// to couple its own path rendering to `tree/`'s module boundary for it.
// ---------------------------------------------------------------------------------------------

function escapePointerToken(name: string): string {
  return name.replace(/~/g, '~0').replace(/\//g, '~1');
}

// ---------------------------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------------------------

/**
 * One step of the descent, linked to the step before it -- the port of the Java's own
 * `PathStep`. `name` is `undefined` for an array/tuple index, in which case `index` is
 * meaningful. `schemaToo` marks a step that also extends the schema pointer (only
 * {@link ReadContext.schemaField} ever sets it).
 */
interface PathStep {
  readonly parent: PathStep | undefined;
  readonly name: string | undefined;
  readonly index: number;
  readonly schemaToo: boolean;
  /**
   * How many levels of *data* nesting are open at this step -- the length of the chain built by
   * {@link ReadContext.field}/{@link ReadContext.index}, which are the two scopings that mean
   * "descend into a value". The schema-side scopings (`schemaField`, `inRecord`,
   * `underDeclaration`) carry it through unchanged: they move within a schema, not into a
   * document.
   */
  readonly depth: number;
}

/**
 * Where the accumulated schema pointer is anchored -- the port of the Java's own
 * `(schemaRoot, schemaId, schemaPosition)` triple, bundled into one value so "no schema
 * established yet" is a single `undefined` rather than three fields that must agree.
 */
interface SchemaAnchor {
  readonly schemaId: string;
  /** The declaration's own pointer, verbatim -- `undefined` at the schema's own root. */
  readonly pointer: string | undefined;
  readonly position: Position | undefined;
}

/**
 * Shared by every scoped copy of one read -- the port of the Java's own `Cursor`. Held apart
 * from the per-copy path/schema/position-override state so pulling an event through any one
 * copy is visible to all of them.
 */
interface Cursor {
  readonly events: EventSource;
  readonly receiver: DiagnosticsReceiver;
  /** The position of whatever {@link ReadContext.peek}/{@link ReadContext.next} last returned, on any copy. */
  position: Position | undefined;
  reported: number;
  /**
   * Events a {@link lookingAhead} pass consumed and rewound, replayed ahead of `events` until
   * they run out. Empty for the whole of an ordinary read.
   */
  readonly rewound: TsonEvent[];
  /** Where `next()` records what it consumes while a lookahead is running, else `undefined`. */
  recording: TsonEvent[] | undefined;
  /** §9.1's nesting bound for this read, checked by {@link ReadContext.field}/{@link ReadContext.index}. */
  readonly maxNestingDepth: number;
}

/**
 * Maps every {@link ReadContext} this module creates back to the {@link Cursor} it shares --
 * what lets {@link lookingAhead} reach the cursor without the public {@link ReadContext} shape
 * carrying an implementation-only property. A context this module did not create (there is no
 * other implementation) simply has no entry, which {@link lookingAhead} treats as a usage error.
 */
const cursorOf = new WeakMap<ReadContext, Cursor>();

// ---------------------------------------------------------------------------------------------
// Path/pointer rendering
// ---------------------------------------------------------------------------------------------

/** `tail`'s chain, root first -- the order a pointer reads in, not the order the chain links in. */
function collectSteps(tail: PathStep | undefined): readonly PathStep[] {
  const steps: PathStep[] = [];
  for (let step = tail; step !== undefined; step = step.parent) steps.push(step);
  steps.reverse();
  return steps;
}

function appendStep(out: string, step: PathStep): string {
  return `${out}/${step.name !== undefined ? escapePointerToken(step.name) : String(step.index)}`;
}

/** The data path: every step, unconditionally. `''` at the root -- never `undefined`, matching {@link ReadContext.path}'s own signature. */
function renderPath(tail: PathStep | undefined): string {
  let out = '';
  for (const step of collectSteps(tail)) out = appendStep(out, step);
  return out;
}

/** The schema pointer: the anchor's own pointer (verbatim, already `/`-prefixed by whoever built it), plus every `schemaToo` step. */
function renderSchemaPointer(anchor: SchemaAnchor | undefined, tail: PathStep | undefined): string {
  let out = anchor?.pointer ?? '';
  for (const step of collectSteps(tail)) {
    if (step.schemaToo) out = appendStep(out, step);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The context itself
// ---------------------------------------------------------------------------------------------

/**
 * The depth one level below `tail`, refusing a document that nests past this read's limit (§9.1).
 *
 * Thrown rather than reported, even under a collecting receiver -- `reader/schemaless/tree.ts`
 * states the reasoning and it holds identically here: a nesting bound is a resource limit, not a
 * finding about one value, and everything below the point it fires is unreachable, so there is
 * nothing further to collect.
 *
 * This is the only bound the *compiled* reader stack has. Without it a recursive schema type
 * (`node => { children: [node] }`) reading a deeply nested document exhausted the host call stack
 * and escaped `readTree`/`validate` as an uncaught `RangeError` -- the same failure the schemaless
 * reader was bounded against, on the path a schema-governed read actually takes.
 */
function descend(cursor: Cursor, tail: PathStep | undefined): number {
  const depth = (tail?.depth ?? 0) + 1;
  if (depth > cursor.maxNestingDepth) {
    throw new TsonReadError({
      code: 'TYPE_MISMATCH',
      message: nestingLimitMessage(cursor.maxNestingDepth),
      expected: nestingLimitExpectation(cursor.maxNestingDepth),
      actual: 'deeper',
      ...(cursor.position === undefined ? {} : { dataPosition: cursor.position }),
    });
  }
  return depth;
}

/**
 * This read's nesting bound (§9.1), for a reader that descends without going through
 * {@link ReadContext.field}/{@link ReadContext.index} and so must count for itself.
 *
 * The structural annotation readers are the case: an annotation's value is a data value in its
 * own right, so `@a:@a:@a:...` recurses once per annotation with no path step to scope it. They
 * read the limit here rather than hard-coding the default, so a caller's configured limit governs
 * every descent in a read and not only the ones with a path step attached.
 *
 * Falls back to the default for a context this module did not create -- there is no other
 * implementation, so this is unreachable rather than a supported case.
 */
export function nestingLimitOf(ctx: ReadContext): number {
  return cursorOf.get(ctx)?.maxNestingDepth ?? DEFAULT_MAX_NESTING_DEPTH;
}

function makeContext(
  cursor: Cursor,
  tail: PathStep | undefined,
  schemaAnchor: SchemaAnchor | undefined,
  positionOverride: Position | undefined,
): ReadContext {
  function currentPosition(): Position | undefined {
    return positionOverride ?? cursor.position;
  }

  function anchoredOn(
    pointer: string | undefined,
    schemaId: string,
    position: Position | undefined,
  ): ReadContext {
    return makeContext(cursor, tail, { schemaId, pointer, position }, positionOverride);
  }

  const ctx: ReadContext = {
    *peek(): Task<TsonEvent> {
      const event = cursor.rewound.at(0) ?? (yield* cursor.events.peek());
      cursor.position = event.position;
      return event;
    },

    *next(): Task<TsonEvent> {
      const event = cursor.rewound.shift() ?? (yield* cursor.events.next());
      cursor.position = event.position;
      cursor.recording?.push(event);
      return event;
    },

    position(): Position | undefined {
      return currentPosition();
    },

    schemaLocation(): SchemaLocation | undefined {
      if (schemaAnchor === undefined) return undefined;
      const pointer = renderSchemaPointer(schemaAnchor, tail);
      return {
        schemaId: schemaAnchor.schemaId,
        ...(pointer === '' ? {} : { pointer }),
        ...(schemaAnchor.position === undefined ? {} : { position: schemaAnchor.position }),
      };
    },

    path(): string {
      return renderPath(tail);
    },

    field(name: string): ReadContext {
      return makeContext(
        cursor,
        { parent: tail, name, index: -1, schemaToo: false, depth: descend(cursor, tail) },
        schemaAnchor,
        positionOverride,
      );
    },

    index(i: number): ReadContext {
      return makeContext(
        cursor,
        {
          parent: tail,
          name: undefined,
          index: i,
          schemaToo: false,
          depth: descend(cursor, tail),
        },
        schemaAnchor,
        positionOverride,
      );
    },

    schemaField(name: string): ReadContext {
      return makeContext(
        cursor,
        {
          parent: tail,
          name,
          index: -1,
          schemaToo: schemaAnchor !== undefined,
          // A schema-side scoping moves within a schema, not into a document: same depth.
          depth: tail?.depth ?? 0,
        },
        schemaAnchor,
        positionOverride,
      );
    },

    inRecord(declaration: SchemaLocation): ReadContext {
      // The pointer survives, the anchor does not: this record declares the field the pointer
      // now ends with. Only an outermost record -- nothing established yet -- contributes its
      // own name as the path's root; see this file's own top comment.
      if (schemaAnchor === undefined) {
        return anchoredOn(declaration.pointer, declaration.schemaId, declaration.position);
      }
      return anchoredOn(
        schemaAnchor.pointer,
        declaration.schemaId,
        declaration.position ?? schemaAnchor.position,
      );
    },

    underDeclaration(declaration: SchemaLocation): ReadContext {
      return schemaAnchor !== undefined
        ? ctx
        : anchoredOn(declaration.pointer, declaration.schemaId, declaration.position);
    },

    withPosition(position: Position | undefined): ReadContext {
      return makeContext(cursor, tail, schemaAnchor, position);
    },

    report(code: DiagnosticCode, message: string, expected?: string, actual?: string): void {
      const path = renderPath(tail);
      const schemaPointer =
        schemaAnchor === undefined ? undefined : renderSchemaPointer(schemaAnchor, tail);
      const position = currentPosition();
      const diagnostic: Diagnostic = {
        code,
        message,
        ...(path === '' ? {} : { path }),
        ...(schemaAnchor === undefined ? {} : { schemaId: schemaAnchor.schemaId }),
        ...(schemaPointer === undefined || schemaPointer === '' ? {} : { schemaPointer }),
        ...(expected === undefined ? {} : { expected }),
        ...(actual === undefined ? {} : { actual }),
        ...(position === undefined ? {} : { dataPosition: position }),
        ...(schemaAnchor?.position === undefined ? {} : { schemaPosition: schemaAnchor.position }),
      };
      cursor.reported += 1;
      cursor.receiver.report(diagnostic);
    },

    reported(): number {
      return cursor.reported;
    },
  };

  cursorOf.set(ctx, cursor);
  return ctx;
}

/**
 * A context over a raw {@link EventSource}, reporting through `receiver` -- the port of
 * `TsonReadContext.of`. See `contracts.ts`'s own doc on {@link createReadContext}: this performs
 * no document-level framing.
 */
export function createReadContext(
  events: EventSource,
  receiver: DiagnosticsReceiver,
  options?: NestingLimitOptions,
): ReadContext {
  const cursor: Cursor = {
    events,
    receiver,
    position: undefined,
    reported: 0,
    rewound: [],
    recording: undefined,
    maxNestingDepth: maxNestingDepthOf(options),
  };
  return makeContext(cursor, undefined, undefined, undefined);
}

/**
 * The port of `DefaultTsonReadContext.lookingAhead` -- see `contracts.ts`'s own doc on
 * {@link lookingAhead} for the full contract. Every {@link ReadContext} `lookahead` might be
 * called with was created by {@link makeContext} above (there is no other implementation of this
 * interface in the package), so the {@link cursorOf} lookup cannot fail for a context this
 * library made -- exactly the invariant the Java original's own comment states about its cast.
 */
export function* lookingAhead<T>(
  ctx: ReadContext,
  lookahead: (ctx: ReadContext) => Task<T>,
): Task<T> {
  const cursor = cursorOf.get(ctx);
  if (cursor === undefined) {
    throw new TsonInternalError(
      'lookingAhead was called with a ReadContext this module did not create -- ' +
        'reader/context.ts is the only implementation of the interface',
    );
  }
  const consumed: TsonEvent[] = [];
  const outer = cursor.recording;
  cursor.recording = consumed;
  try {
    return yield* lookahead(ctx);
  } finally {
    cursor.recording = outer;
    // Front of the queue, in read order: these events precede whatever is still unread, and a
    // nested lookahead's rewind must land ahead of the enclosing one's. An enclosing lookahead
    // does not also record these as its own -- they leave `consumed` here and re-enter
    // `recording` only if the enclosing pass reads through them itself.
    //
    // Rebuilt front-to-back rather than `unshift(...consumed)`. Spreading an array into arguments
    // passes one argument per element, so a long lookahead — a variant dispatch skipping a large
    // annotation run is how this was found — threw a raw `RangeError: Maximum call stack size
    // exceeded`, a host error out of a reader whose contract is to report diagnostics. Unshifting
    // one at a time avoids that but is quadratic, since each shifts the whole array. Draining the
    // queue once and pushing both halves back is linear, and `rewound` is `readonly` as a binding
    // rather than as an array, so it keeps its identity.
    if (consumed.length > 0) {
      const pending = cursor.rewound.splice(0, cursor.rewound.length);
      for (const event of consumed) cursor.rewound.push(event);
      for (const event of pending) cursor.rewound.push(event);
    }
  }
}
