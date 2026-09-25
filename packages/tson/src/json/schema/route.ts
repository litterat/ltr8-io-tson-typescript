/**
 * Where a dispatcher sends a value whose `$type` it has matched — the port of the Java reference's
 * `Route`/`ExactReader` (`tson-json/.../reader/{Route,ExactReader}.java`), collapsed into one
 * module since TypeScript's structural typing needs no separate marker interface to ask "does this
 * reader know how to read exactly its own type, without a further dispatch in front of it".
 *
 * **Two readers, because §3.3's two forms want two different things.** In the **inline** form the
 * object *is* the selected type's own value, so it is read at exactly that type; in the
 * **wrapper** form the tag names the type of `$value`, and that value may carry a tag of its own,
 * so it is read at the type's own entry reader, which dispatches again if the type has subtypes.
 *
 * **`entry` is resolved lazily, by name, every time a `Route` is read** — deliberately, rather than
 * capturing the `JsonTypeReader` object `json/schema/compile.ts`'s `resolve(name)` hands back at
 * construction time. A dispatcher is built while other entries in the same schema may still be
 * compiling (`compile.ts`'s own cycle-breaking `building` set), so the reader `resolve` returns for
 * a not-yet-finished entry is a lazy proxy that only becomes the real, finished reader once
 * compilation completes; resolving again at read time (`compile.ts`'s `resolve` is a plain
 * `Map.get` once a compile has finished, and every read happens after one has) always reaches the
 * real reader, with no separate deferred-reader class needed for this module's own purposes.
 */
import type { Task } from '../../io/bytes.js';
import type { JsonReadContext } from '../readContext.js';
import { type Lead, readWrapped } from './reservedMembers.js';
import type { JsonTypeReader } from './types.js';

/**
 * A reader that knows how to read exactly its own type when reached directly (no further
 * dispatch): a plain record reader (`json/schema/record.ts`) and every dispatcher in this
 * directory implement it. `wrapped` is the reader for a wrapper's `$value`, should the object this
 * call reads turn out to be one after all -- see `json/schema/record.ts`'s own use.
 */
export interface ExactReader extends JsonTypeReader {
  readExact(ctx: JsonReadContext, wrapped: JsonTypeReader, opened?: boolean): Task<unknown>;
}

/** Whether `reader` implements {@link ExactReader} — every dispatcher in this directory does, and so does `json/schema/record.ts`'s own plain record reader; an atom, array, tuple or map reader does not, so a `$type`/wrapper reaching one of those can only be read as a wrapper (`json/schema/route.ts`'s own `routeTo`). */
export function hasReadExact(reader: JsonTypeReader): reader is ExactReader {
  return typeof (reader as Partial<ExactReader>).readExact === 'function';
}

/**
 * A reader that can additionally be entered when an enclosing choice
 * (`json/schema/dispatchChoice.ts`) has already consumed, for real, the object's opening brace
 * and a leading `$type` naming this reader's own sealed family -- admissible there because it is
 * a declared variant, even though the base has no direct instances of its own (§6.1.5) and no
 * more specific name is admissible at a choice's own tag (`dispatchChoice.ts`'s own top note).
 * `json/schema/dispatchMember.ts`'s own reader is the one implementation; every other reader in
 * this directory has no such case to handle and leaves this capability unimplemented.
 */
export interface ChoiceSelfTagReadable extends JsonTypeReader {
  readChoiceSelfTag(ctx: JsonReadContext): Task<unknown>;
}

/** Whether `reader` implements {@link ChoiceSelfTagReadable} -- only `json/schema/dispatchMember.ts`'s own sealed-family reader ever does. */
export function hasChoiceSelfTag(reader: JsonTypeReader): reader is ChoiceSelfTagReadable {
  return typeof (reader as Partial<ChoiceSelfTagReadable>).readChoiceSelfTag === 'function';
}

export interface Route {
  /**
   * The reader for `name`, whatever it is -- what reads a wrapper's `$value`. `opened`
   * (`json/schema/dispatchMember.ts`'s own top note) forwards a choice-routed continuation past
   * this route; it never applies to a wrapper's `$value`, which is always a fresh object of its
   * own.
   */
  read(ctx: JsonReadContext, lead: Lead, opened?: boolean): Task<unknown>;
}

/** Builds the route to `resolve(name)`: the wrapper form reads its `$value` at the entry reader; the inline form reads exactly `name`'s own type, through {@link ExactReader.readExact} where the resolved reader offers one and through the wrapper reading otherwise (a type that never reads a bare object as its own value can only be a wrapper). */
export function routeTo(resolve: () => JsonTypeReader): Route {
  return {
    *read(ctx: JsonReadContext, lead: Lead, opened = false): Task<unknown> {
      const entry = resolve();
      if (lead.wrapper || !hasReadExact(entry)) {
        return yield* readWrapped(ctx, entry);
      }
      return yield* entry.readExact(ctx, entry, opened);
    },
  };
}
