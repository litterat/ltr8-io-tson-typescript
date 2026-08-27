/**
 * The compiled reader contracts -- the TypeScript port of `tson-compiler`'s `TsonTypeReader`,
 * `TsonReadContext`, and the `reader/` package's own `ValueReaderFactory`/registry interfaces
 * (`docs/readers-and-diagnostics.md`).
 *
 * Every reader in this stack pulls {@link TsonEvent}s directly off an {@link EventSource} via a
 * {@link ReadContext} -- no reader ever requires a materialised value tree first, so
 * schema-validated reading and diagnostics can begin before a whole document is parsed. Per
 * PORT-PLAN.md's first architectural decision, the whole read stack is suspendable-but-sync-shaped:
 * {@link ReadContext.next}/{@link ReadContext.peek} and {@link TypeReader.read} all return {@link
 * Task}, because retrofitting suspension after readers exist would mean touching every one of
 * them. `atom/`, `base/`, `resolver/` and `link/` run on already-lexed text and stay ordinary sync
 * code -- see `atom/contract.ts`'s own note on exactly where that boundary falls.
 */

import type { Task } from '../io/bytes.js';
import type { Position } from '../core/position.js';
import type { DiagnosticCode, DiagnosticsReceiver, SchemaLocation } from '../core/diagnostic.js';
import type { EventSource, TsonEvent } from '../stream/event.js';

// ---------------------------------------------------------------------------------------------
// TypeReader
// ---------------------------------------------------------------------------------------------

/**
 * Reads a value at one compiled, schema-known position -- the port of `TsonTypeReader<T>`.
 *
 * Strictly one method, and no source or policy overloads: this reads one value at `ctx`'s cursor
 * and nothing more. Whole-document reading -- consuming the leading document-start event, and
 * pulling *past* the root value so a lazy {@link EventSource} actually checks for trailing content
 * -- is not this interface's job; it belongs to whoever owns the document (a tree reader / object
 * reader built on top of this contract), exactly as `TsonTreeReader`/`TsonObjectReader` own it in
 * Java rather than `TsonTypeReader` itself.
 *
 * `read` returns {@link Task} unconditionally -- see this file's own top comment. A reader that
 * happens never to suspend in practice (e.g. one that only inspects already-decoded atom text)
 * still declares `Task<T>`, because the caller composing readers cannot know which ones might
 * starve and must `yield*` through all of them uniformly.
 */
export interface TypeReader<T> {
  read(ctx: ReadContext): Task<T>;
}

// ---------------------------------------------------------------------------------------------
// ReadContext
// ---------------------------------------------------------------------------------------------

/**
 * The pull cursor over one {@link EventSource}, shared across an entire read -- the port of
 * `TsonReadContext`.
 *
 * Every scoped copy this interface hands back ({@link field}/{@link index}/{@link schemaField}/
 * {@link inRecord}/{@link underDeclaration}/{@link withPosition}) points at the *same* underlying
 * event source and diagnostics receiver as the context it was scoped from -- pulling an event
 * through any one copy is visible to all of them, and {@link position} always reflects whichever
 * event was most recently peeked or consumed on *any* copy, because there is only ever one real
 * cursor per read.
 *
 * **This context holds no error policy of its own.** {@link report} builds a `Diagnostic` from the
 * path/position/schema-location this context tracks and hands it to the {@link DiagnosticsReceiver}
 * it was constructed with, which decides that diagnostic's fate: a fail-fast receiver throws
 * immediately, a collecting one accumulates and lets the read continue. Every reader calls `report`
 * identically either way and never branches on which receiver is in play; a reader needing to know
 * whether its own children reported anything asks {@link reported}, which works uniformly for any
 * receiver, including one that streams diagnostics elsewhere and keeps no list at all.
 *
 * The "offer my own declaration" convention: a record re-anchors the schema identity and position
 * on itself via {@link inRecord}, because it declares the field the schema pointer ends with; every
 * other reader offers its own declaration only as a seed, via {@link underDeclaration}, taken only
 * when nothing already encloses it.
 */
export interface ReadContext {
  /** The next event, without consuming it -- repeated calls with no intervening {@link next} return the same event. */
  peek(): Task<TsonEvent>;
  /** Consumes and returns the next event, advancing {@link position} to reflect it. */
  next(): Task<TsonEvent>;
  /** The position of whichever event was most recently peeked or consumed, on any copy of this context sharing the same read. `undefined` before anything has been pulled. */
  position(): Position | undefined;
  /** The declaration currently governing this read. `undefined` for a read with no schema behind it at all. */
  schemaLocation(): SchemaLocation | undefined;
  /** The path to the value currently being read, as an RFC 6901 JSON Pointer accumulated by {@link field}/{@link index}/{@link schemaField}. */
  path(): string;
  /**
   * A copy of this context scoped one step deeper in the *data* only -- `name` is RFC
   * 6901-escaped into the path. For a map entry, or a field the schema does not declare; a
   * declared record field uses {@link schemaField} instead so both ends descend together.
   */
  field(name: string): ReadContext;
  /** A copy of this context scoped one array/tuple element deeper -- a data step, with no schema step. */
  index(i: number): ReadContext;
  /**
   * A copy of this context scoped one *declared record field* deeper, stepping the data path and
   * the schema pointer together -- the one descent where the schema has a name of its own for
   * where the read went.
   */
  schemaField(name: string): ReadContext;
  /**
   * A copy of this context anchored on the record now reading: `declaration`'s identity and
   * position replace whatever was there, and its pointer is taken only if none has been
   * established yet. See this interface's own "offer my own declaration" note.
   */
  inRecord(declaration: SchemaLocation): ReadContext;
  /**
   * A copy of this context with `declaration` taken *only* if no schema location has been
   * established yet -- what every non-record reader offers, so its own declaration locates a
   * value read at the root of a document without displacing an enclosing record's declaration
   * when there is one.
   */
  underDeclaration(declaration: SchemaLocation): ReadContext;
  /**
   * A copy of this context whose {@link position} is pinned to `position` rather than following
   * the shared cursor. For a problem noticed only after its enclosing container has already been
   * consumed (a required field the data never mentioned at all has no event of its own to report
   * against) -- {@link peek}/{@link next} on the returned copy still pull from the same live,
   * shared cursor as always; only {@link position} itself is overridden.
   */
  withPosition(position: Position | undefined): ReadContext;
  /**
   * Builds a `Diagnostic` for one problem at the current {@link path}/{@link position}/{@link
   * schemaLocation} and hands it to this read's {@link DiagnosticsReceiver}, which decides its
   * fate -- a fail-fast receiver throws from here and never returns.
   */
  report(code: DiagnosticCode, message: string, expected?: string, actual?: string): void;
  /**
   * How many problems have been reported through this read so far, counting every scoped copy
   * since they share one cursor. Monotonic, and independent of what the receiver does with each
   * one, so a reader can checkpoint around a child read (`const before = ctx.reported(); ...; if
   * (ctx.reported() > before) { ... }`) regardless of whether the receiver collects, streams, or
   * throws.
   */
  reported(): number;
}

/**
 * A context over a *raw* {@link EventSource}, reporting through `receiver` -- the port of
 * `TsonReadContext.of`.
 *
 * Raw: no document-level framing is assumed or performed, so a caller passing a mid-document or
 * replay source gets exactly the events it supplied. **Not a whole-document read** -- see {@link
 * TypeReader}'s own note on why that framing belongs one layer up.
 */
export declare function createReadContext(
  events: EventSource,
  receiver: DiagnosticsReceiver,
): ReadContext;

/**
 * Runs `lookahead` against `ctx`'s cursor and then rewinds every event it consumed, so whatever
 * reads next sees a stream nothing has touched -- the port of `TsonReadContext.lookingAhead`.
 *
 * **Why one event of lookahead is not enough.** {@link ReadContext.peek} answers "what is here".
 * A reader that must *dispatch* -- choose a variant, or pick a root reader -- needs to answer a
 * different question, because the grammar is `data-value = *annotation [type-ref] core-value`: the
 * type-ref a dispatch decision needs sits behind a run of annotations of any length. Reading past
 * those annotations to reach the type-ref is not a substitute for leaving them alone: they belong
 * to the value, and whichever reader is dispatched to would never see them again, a silent loss
 * rather than a failure. Looking and rewinding lets the dispatcher decide while leaving the
 * delegate able to read the whole value -- framing included -- exactly as it would if nothing had
 * dispatched to it first.
 *
 * Consumed events are replayed from a buffer rather than re-lexed, so a lookahead costs only what
 * it looked past, never the document. {@link ReadContext.position} is deliberately left where the
 * lookahead reached rather than restored: a caller looks ahead in order to say something about what
 * it found, and that is where the saying belongs.
 *
 * Declared to return {@link Task} because `lookahead` itself pulls events through `ctx`, which can
 * suspend -- per this file's own top comment, every generator-returning signature in this stack is
 * `Task<...>` from the start.
 */
export declare function lookingAhead<T>(
  ctx: ReadContext,
  lookahead: (ctx: ReadContext) => Task<T>,
): Task<T>;

// ---------------------------------------------------------------------------------------------
// ValueReaderFactory and the factory-registry interfaces
// ---------------------------------------------------------------------------------------------

/**
 * Builds the {@link TypeReader} for one compiled schema entry -- the port of `ValueReaderFactory`.
 *
 * Generic over the schema-entry shape (`Def`, Java's resolved `TypeDefinition`) and the
 * compilation environment (`Context`, Java's `ValueReaderContext`) rather than naming
 * `schema/meta`'s concrete types directly: this layer is upstream of `schema/meta` in the module
 * layering (see `eslint.config.js`'s zone list -- `schema/meta` may only be imported from itself,
 * `core/`, and `annotations/`), and the compiler package that supplies those concrete types is
 * built later, against this contract. A later work package instantiates `Def`/`Context` with the
 * real schema types once they exist.
 */
export interface ValueReaderFactory<Def = unknown, Context = unknown> {
  create(name: string, definition: Def, context: Context): TypeReader<unknown>;
}

/**
 * A `constructor name -> ValueReaderFactory` table -- the port of `ValueReaderFactoryRegistry`.
 *
 * One instance per reading mode (Java's tree mode / bind mode); `resolve` throws when `name` has no
 * registered factory, exactly as the Java original does, rather than returning `undefined` -- an
 * unregistered constructor name is a compilation-time authoring bug in the reader stack itself, not
 * a recoverable per-read condition the way a missing {@link BindingRegistry} entry is (see
 * `bind/binding.ts`'s `TsonMissingBindingError` note for that contrast).
 */
export interface ValueReaderFactoryRegistry<Def = unknown, Context = unknown> {
  resolve(name: string): ValueReaderFactory<Def, Context>;
}
