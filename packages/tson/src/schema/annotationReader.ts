/**
 * {@link createAnnotationValueReader} — the `AnnotationValueReader` `compiler/resolverTypes.ts`
 * declares and nothing implemented, so a declaration's key annotations (§6, the `@doc` on each
 * name) resolved with their values dropped.
 *
 * **§3.3.3's one hop.** An annotation in a schema document names an *ordinary entry* of the
 * governing meta-schema's namespace, not a constructor of the meta vocabulary — which is why this
 * goes through the compiled schema's own reader for that name, where `metaReader.ts`'s
 * `DefinitionMetaReader` goes through the constructor bindings instead. The two hooks look alike
 * and are deliberately separate types for exactly that reason.
 *
 * **Deliberately outside `schema/meta`**, alongside `bindings.ts` and `metaReader.ts`: the zone
 * rule reserves `schema/meta` for the value model alone, and this module names `CompiledSchema`.
 *
 * The value a reader hands back is a `tree/nodes.ts` {@link Value}, which is what reaches
 * `schema/meta`'s own `Annotation.value` — typed `unknown` there precisely because that package
 * may not name it. A caller wanting `@doc`'s text reads the atom node's `value`.
 */
import { throwing } from '../core/diagnostic.js';
import { TsonNotImplementedError, TsonReadError } from '../core/errors.js';
import { runSync } from '../io/bytes.js';
import type { DataValue } from '../ast/value.js';
import { dataValueEvents } from '../compiler/dataValueEvents.js';
import { listEventSource } from '../stream/listSource.js';
import { createReadContext } from '../reader/context.js';
import type { CompiledSchema } from '../compiler/compile.js';
import type { AnnotationValueReader } from '../compiler/resolverTypes.js';

/**
 * Reads an annotation's value through `compiled`'s reader for the type its name refers to.
 *
 * Returns `undefined` for a name `compiled` has no reader for — the "value out of reach" answer
 * the resolver already understands, which keeps the annotation's name and drops only its value.
 * That case is a library gap ({@link TsonNotImplementedError}), never an author error: a name that
 * does not resolve at all is caught by the resolver before it gets here.
 *
 * Safe to drive with `runSync`: the source is a fixed in-memory event list, so nothing can starve
 * (`io/bytes.ts`'s own "in sync mode nothing ever suspends" guarantee).
 */
export function createAnnotationValueReader(compiled: CompiledSchema): AnnotationValueReader {
  return (type: string, value: DataValue): unknown => {
    let reader;
    try {
      reader = compiled.reader(type);
    } catch (error) {
      if (error instanceof TsonNotImplementedError) return undefined;
      throw error;
    }
    const ctx = createReadContext(
      listEventSource(dataValueEvents(value), `reading the value of annotation '@${type}'`),
      throwing((diagnostic) => new TsonReadError(diagnostic)),
    );
    return runSync(reader.read(ctx));
  };
}
