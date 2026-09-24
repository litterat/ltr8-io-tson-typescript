/**
 * The pull cursor over one {@link JsonEventSource}, shared across an entire JSON read, schemaless
 * or schema-directed — this encoding's own analogue of `reader/context.ts`'s `ReadContext`, kept
 * as a **separate, self-contained implementation** rather than an import: the `src/json/**`
 * ESLint zone (`eslint.config.js`) forbids reaching into `reader/` at all, mirroring the
 * reference's "no dependency on tson-compiler" (`design/json-encoding.md`).
 *
 * Considerably smaller than its TSON-text counterpart, for a structural reason rather than a
 * missing feature: every recursive descent this package's JSON readers make corresponds 1:1 with
 * an object or array container the event stream itself opened, and `json/stream.ts` already
 * refuses a document past [TSON-JSON] §10.1's nesting bound *before* a consumer descends into it
 * (`push` in that module). The TSON text `ReadContext` carries its own depth guard because an
 * annotation's value recurses with no container event to bound it; nothing here does, so this
 * context adds no second bound of its own and needs no `lookingAhead`/rewind machinery either —
 * every reader in `json/schema/**` reads at most one event of lookahead at a time (the readers
 * that need dispatch -- an annotation object, an untagged choice, a scoped position -- would
 * need more, and are `NOT_IMPLEMENTED` here instead — see `json/schema/compile.ts`'s own top
 * note).
 *
 * **Schema-location tracking** (`inRecord`/`underDeclaration`/`schemaField`/`schemaLocation`)
 * mirrors `reader/context.ts`'s identically named methods, for a schema-directed read only: it
 * anchors a `SchemaLocation` once, at the declaration it entered through (`underDeclaration`, or
 * `inRecord` for a record, whose own pointer replaces rather than extends whatever anchor was
 * already in scope — see that method's own doc), and every `schemaField` descent from there
 * extends the schema pointer alongside the data one. A schemaless read never calls any of the
 * four, so {@link JsonReadContext.report} omits every schema-side `Diagnostic` field exactly as
 * it always has.
 *
 * Holds no error policy of its own: {@link JsonReadContext.report} builds a `Diagnostic` from the
 * RFC 6901 path (and, once anchored, the schema pointer) this context is tracking and the position
 * `json/stream.ts` last produced, and hands it to the read's own `DiagnosticsReceiver` — which
 * decides whether that is fatal, exactly as `core/diagnostic.ts`'s own `throwing`/`collector` do
 * for every other reader in this package.
 */
import type {
  Diagnostic,
  DiagnosticCode,
  DiagnosticsReceiver,
  SchemaLocation,
} from '../core/diagnostic.js';
import type { Position } from '../core/position.js';
import type { Task } from '../io/bytes.js';
import { DEFAULT_NAME_POLICY, type NamePolicy } from '../unicode/policy.js';
import type { JsonEvent, JsonEventSource } from './stream.js';

/**
 * One step of the RFC 6901 pointer: a member name, or an array index where `name` is `undefined`.
 * `schemaToo` marks a step that also extends the schema pointer (only {@link
 * JsonReadContext.schemaField} ever sets it) — `reader/context.ts`'s own `PathStep.schemaToo`.
 */
interface PathStep {
  readonly parent: PathStep | undefined;
  readonly name: string | undefined;
  readonly index: number;
  readonly schemaToo: boolean;
}

/**
 * Where the accumulated schema pointer is anchored — `reader/context.ts`'s own `SchemaAnchor`,
 * ported unchanged: "no schema established yet" is a single `undefined` rather than three fields
 * that must agree.
 */
interface SchemaAnchor {
  readonly schemaId: string;
  /** The declaration's own pointer, verbatim — `undefined` at the schema's own root. */
  readonly pointer: string | undefined;
  readonly position: Position | undefined;
}

interface Cursor {
  readonly events: JsonEventSource;
  readonly receiver: DiagnosticsReceiver;
  readonly identifierPolicy: NamePolicy;
  position: Position | undefined;
  reported: number;
}

/** A context over one {@link JsonEventSource}, scoped by {@link field}/{@link index} as a read descends. */
export interface JsonReadContext {
  /** Consumes and returns the next event, advancing {@link position} to reflect it. */
  next(): Task<JsonEvent>;
  /** The next event, without consuming it — repeated calls with no intervening {@link next} return the same event. */
  peek(): Task<JsonEvent>;
  /** The position of whichever event was most recently peeked or consumed, on any copy sharing this read. */
  position(): Position | undefined;
  /** The RFC 6901 pointer to where this context sits; `''` at the root. */
  path(): string;
  /** This context at member `name` — a new context, sharing this read's cursor. */
  field(name: string): JsonReadContext;
  /** This context at element `i`. */
  index(i: number): JsonReadContext;
  /**
   * This context's accumulated {@link SchemaLocation}, or `undefined` before any of
   * {@link inRecord}/{@link underDeclaration} has anchored one.
   */
  schemaLocation(): SchemaLocation | undefined;
  /**
   * This context anchored on `declaration` for a **record** position: the schema id and position
   * update to `declaration`'s own, but the *pointer* survives from whatever anchor was already in
   * scope — a nested record's own problems are still reported at the schema position the read
   * actually took to reach it (the field that named it), not reset to that record's own root.
   * Only the outermost record, reached with no anchor yet in scope, contributes `declaration`'s
   * own pointer as the path's starting point. Every `schemaField` call after this extends the
   * (possibly inherited) pointer one step further.
   */
  inRecord(declaration: SchemaLocation): JsonReadContext;
  /**
   * This context anchored on `declaration`, but only when nothing has anchored one yet — an atom,
   * array, tuple or map position's own entry point, which (unlike a record) never replaces an
   * anchor a caller already established (`json/schema/record.ts`'s field reads pass their own
   * field's `SchemaLocation` through `schemaField`, not through this method, precisely so a
   * nested atom field doesn't reset the pointer to its own type's root).
   */
  underDeclaration(declaration: SchemaLocation): JsonReadContext;
  /** This context one declared field deeper: extends both the data path and, once anchored, the schema pointer. */
  schemaField(name: string): JsonReadContext;
  /** This read's identifier-hygiene policy ([TSON-DATA] §8.2), for a reader judging a name. */
  identifierPolicy(): NamePolicy;
  /** Hands one problem to this read's receiver, located at this context's pointer and position. */
  report(code: DiagnosticCode, message: string, expected?: string, actual?: string): void;
  /** How many problems this read has reported so far, counting every context derived from it. */
  reported(): number;
}

function collectSteps(tail: PathStep | undefined): readonly PathStep[] {
  const steps: PathStep[] = [];
  for (let step = tail; step !== undefined; step = step.parent) steps.push(step);
  steps.reverse();
  return steps;
}

function appendStep(out: string, step: PathStep): string {
  return `${out}/${step.name !== undefined ? escapePointerToken(step.name) : String(step.index)}`;
}

/** The data path: every step, unconditionally. `''` at the root. */
function renderPath(tail: PathStep | undefined): string {
  let out = '';
  for (const step of collectSteps(tail)) out = appendStep(out, step);
  return out;
}

/** The schema pointer: the anchor's own pointer, plus every `schemaToo` step since it was set. */
function renderSchemaPointer(anchor: SchemaAnchor | undefined, tail: PathStep | undefined): string {
  let out = anchor?.pointer ?? '';
  for (const step of collectSteps(tail)) {
    if (step.schemaToo) out = appendStep(out, step);
  }
  return out;
}

/** RFC 6901 §3: `~` is `~0` and `/` is `~1`, in that order or the escape eats itself. */
function escapePointerToken(name: string): string {
  return !name.includes('~') && !name.includes('/')
    ? name
    : name.replace(/~/g, '~0').replace(/\//g, '~1');
}

function makeContext(
  cursor: Cursor,
  tail: PathStep | undefined,
  schemaAnchor: SchemaAnchor | undefined,
): JsonReadContext {
  function anchoredOn(
    pointer: string | undefined,
    schemaId: string,
    position: Position | undefined,
  ): JsonReadContext {
    return makeContext(cursor, tail, { schemaId, pointer, position });
  }

  const ctx: JsonReadContext = {
    *next(): Task<JsonEvent> {
      const event = yield* cursor.events.next();
      cursor.position = event.position;
      return event;
    },
    *peek(): Task<JsonEvent> {
      const event = yield* cursor.events.peek();
      cursor.position = event.position;
      return event;
    },
    position(): Position | undefined {
      return cursor.position;
    },
    path(): string {
      return renderPath(tail);
    },
    field(name: string): JsonReadContext {
      return makeContext(cursor, { parent: tail, name, index: -1, schemaToo: false }, schemaAnchor);
    },
    index(i: number): JsonReadContext {
      return makeContext(
        cursor,
        { parent: tail, name: undefined, index: i, schemaToo: false },
        schemaAnchor,
      );
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
    inRecord(declaration: SchemaLocation): JsonReadContext {
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
    underDeclaration(declaration: SchemaLocation): JsonReadContext {
      return schemaAnchor !== undefined
        ? ctx
        : anchoredOn(declaration.pointer, declaration.schemaId, declaration.position);
    },
    schemaField(name: string): JsonReadContext {
      return makeContext(
        cursor,
        { parent: tail, name, index: -1, schemaToo: schemaAnchor !== undefined },
        schemaAnchor,
      );
    },
    identifierPolicy(): NamePolicy {
      return cursor.identifierPolicy;
    },
    report(code: DiagnosticCode, message: string, expected?: string, actual?: string): void {
      const path = renderPath(tail);
      const schemaPointer =
        schemaAnchor === undefined ? undefined : renderSchemaPointer(schemaAnchor, tail);
      cursor.reported += 1;
      const diagnostic: Diagnostic = {
        code,
        message,
        path,
        ...(schemaAnchor === undefined ? {} : { schemaId: schemaAnchor.schemaId }),
        ...(schemaPointer === undefined || schemaPointer === '' ? {} : { schemaPointer }),
        ...(expected === undefined ? {} : { expected }),
        ...(actual === undefined ? {} : { actual }),
        ...(cursor.position === undefined ? {} : { dataPosition: cursor.position }),
        ...(schemaAnchor?.position === undefined ? {} : { schemaPosition: schemaAnchor.position }),
      };
      cursor.receiver.report(diagnostic);
    },
    reported(): number {
      return cursor.reported;
    },
  };
  return ctx;
}

/** A context over `events`, reporting through `receiver`, judging names under `identifierPolicy` (default {@link DEFAULT_NAME_POLICY}). */
export function createJsonReadContext(
  events: JsonEventSource,
  receiver: DiagnosticsReceiver,
  identifierPolicy: NamePolicy = DEFAULT_NAME_POLICY,
): JsonReadContext {
  return makeContext(
    { events, receiver, identifierPolicy, position: undefined, reported: 0 },
    undefined,
    undefined,
  );
}
