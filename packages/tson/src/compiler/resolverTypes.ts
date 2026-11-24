/**
 * The dependencies `definitionResolver.ts` takes rather than reaches for itself — every one of
 * them is a plain function type, matching the Java original's `@FunctionalInterface` resolver
 * dependencies (`DefinitionGetter`, `DefinitionMetaReader`, `AnnotationValueReader`,
 * `ApplicationCloser`) one for one, plus {@link SourceBodyEncoder}, this port's own replacement
 * for the Java's `TsonObjectWriter` field (see this file's own note on it below).
 */
import type { CoreValue, DataValue } from '../ast/value.js';
import type { EntryFacts, MetaValue, Top } from '../schema/meta/typedef.js';

/**
 * A single-name entry lookup -- the entry's value (§8.1: an entry is its value), `undefined` when
 * `name` isn't resolved (yet or at all) -- the TypeScript idiom for the Java original's
 * `Map.get`-shaped `DefinitionGetter`.
 *
 * `definitionResolver.ts` holds two of these, one per namespace Part 2 §3.3.1 distinguishes:
 * the type-name namespace (a supertype/refinement-source/atom-refinement-source lookup) and the
 * structure namespace (a constructor-application target lookup, one hop via `!!meta`). Both are
 * genuinely different namespaces that happen to share this shape, not two names for one thing.
 *
 * Every real implementation closes over some caller's own growing `Map<string, Top>`
 * — `entries.get.bind(entries)` for a namespace still being populated one declaration at a time,
 * or a fully-resolved schema's own entry table for one that's already fixed (true of the
 * structure namespace always: a governing meta-schema is compiled before anything asks it a
 * constructor-target question). `definitionResolver.ts` never mutates the map behind this
 * function, only reads through it — a caller resolving declarations one at a time in a loop still
 * has to record each result itself.
 */
export type DefinitionGetter = (name: string) => Top | undefined;

/**
 * Each entry's facts as resolution learns them (§8.1's {@link EntryFacts}): where it was declared,
 * the annotations written on its value, and the constructor its tag names. Shared and mutable,
 * written by the definition resolver as each declaration resolves and read by the schema resolver
 * when it assembles the result; it holds imported entries' facts too, so an atom refinement finds
 * the constructor of a source another schema declared.
 */
export type EntryFactsTable = Map<string, EntryFacts>;

/**
 * Reads a constructor-application/atom-refinement value against `type`'s own compiled reader —
 * `type` is the constructor name (already attached to `value.typeRef`), `value` the
 * already-normalised (record-form) data to read.
 *
 * A required dependency of `definitionResolver.ts`'s own resolver factory, not threaded per call:
 * the resolver has no dependency on `bind/` or a reader implementation at all (`compiler/`'s own
 * `import/no-restricted-paths` zone forbids the former outright); a caller with a real compiled
 * reader (the eventual `SchemaResolver`) supplies one wrapping it. A caller with no compiled
 * governing meta to read through at all (the meta-kernel bootstrap, which is producing the very
 * entries such a reader would need) supplies one that throws if ever invoked, rather than
 * `undefined` — see `neverCalled` in this package's own tests for the pattern.
 *
 * Throws to report a read failure; `definitionResolver.ts`'s own `bindAtomInstance` distinguishes
 * a `TsonReadError` (the body is not valid data for the constructor's vocabulary — the author's
 * error) from a `TsonBindMismatchError`/`TsonMissingBindingError` (the consumer's own binding
 * configuration disagrees with or omits this constructor) and rethrows each under its own
 * classification; anything else is wrapped as `TsonNotImplementedError`.
 */
export type DefinitionMetaReader = (type: string, value: DataValue) => Top;

/**
 * Reads the payload of a value entry, `name => !T { ... }` with `T` an ordinary type (§4.1), against `T`'s
 * own declaration -- a record's fields, a namespace type's keys -- into the generic value model this port
 * holds a value in (`schema/meta`'s `MetaValue`): this model binds nothing to host classes. `type` is the
 * type's name in the schema's one namespace and `value` the payload, already tagged with it.
 *
 * Throws to report a read failure, as {@link DefinitionMetaReader} does.
 */
export type DefinitionValueReader = (type: string, value: DataValue) => MetaValue;

/**
 * The declarations of the document being resolved that may be the member of the family `base` a value's pins
 * select, `pins` the value's written selector tokens by field (§3.4.1, §5.2; `familyJoiners.ts`): what a read
 * placing a value by its pins waits on, beside the members the closure already records.
 */
export type MemberJoiners = (base: string, pins: ReadonlyMap<string, string>) => readonly string[];

/**
 * Reads an annotation's value through the type its name refers to (Part 2 §6: "an annotation
 * `@T` (or `@T:value`) names a type `T`", with the value "validated against `T`'s contract").
 * `type` is the annotation's own name, already resolved one hop against the governing target's
 * namespace by the caller; `value` is the authored data value.
 *
 * Distinct from {@link DefinitionMetaReader} despite the identical shape, because the two read
 * genuinely different things and only one has a bounded return: a constructor body always binds
 * to a `schema.meta` type (`Top`), while an annotation binds to whatever its name resolves to —
 * `@doc:"..."` yields a `string`. Widening one hook to cover both would take the type information
 * away from the constructor case to accommodate the annotation case, which cannot offer it.
 *
 * A resolver with no compiled reader to offer omits this dependency entirely, which
 * `definitionResolver.ts` treats as "every annotation name is out of reach" — see its own
 * `annotationsResolve` note.
 */
export type AnnotationValueReader = (type: string, value: DataValue) => unknown;

/**
 * Converts an already-bound `Top` body back to a bare wire `CoreValue` — this port's own
 * replacement for the Java original's `TsonObjectWriter` field, needed for exactly one thing:
 * §5.6's chained atom-refinement merge (`mergeWithSource` in `definitionResolver.ts`), which has
 * to fold a refinement's newly-written bindings *over* its source's own already-bound constraint
 * fields, and can only do that by getting the source's fields back into wire-record shape first.
 *
 * **Why this is a dependency and not a call to `bind/encode.ts`'s `toCoreValue` directly.**
 * `compiler/`'s own `import/no-restricted-paths` zone forbids `compiler/**` from importing
 * `bind/**` at all — precisely the boundary this port draws instead of the Java's
 * compiler-holds-a-writer design (see `definitionResolver.ts`'s own module doc). A caller
 * assembling a resolver from a place that *can* see both (`schema/`, which carries no such
 * restriction) closes over `(body) => toCoreValue(topBinding, body)` using `schema/bindings.ts`'s
 * own `topBinding` and a real `AtomEncoder`, and passes the closure in here. `definitionResolver.ts`
 * never sees a `Binding` or an `AtomEncoder` type, only this plain function signature.
 *
 * Optional, matching `ApplicationCloser`: a caller that never resolves an atom refinement (most
 * hand-built tests, the meta-kernel bootstrap's own record/composition-only declarations) has no
 * need to supply one, and `definitionResolver.ts` reports `TsonNotImplementedError` if it is ever
 * needed with none given.
 */
export type SourceBodyEncoder = (body: Top) => CoreValue;
