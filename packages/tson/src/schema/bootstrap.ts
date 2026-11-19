/**
 * The kernel's pre-load (Part 2 §3.4): `meta.tn` is the one document no import chain can resolve, since it
 * imports nothing and every construction head it applies is one of its own entries -- `!meta.set_type { ...
 * }`, `!numeric.integer_type {}`, `!enum [...]` -- so there is no imported vocabulary to read its
 * instances through. The kernel is therefore resolved from its own source, in the order its entries wait
 * on one another, and registered ahead of every document that imports it.
 *
 * **The order is the waits'** (§3.4.1, rule 1), never the order entries are written in. An entry is made
 * ready the first time anything asks for it, through the one on-demand lookup every schema's resolution
 * runs (`compiler/schemaResolver.ts`): an instance waits on its head and each nested vocabulary record its
 * payload is read against, a composition on its operands, a refinement on its source. A reference to a type
 * (a field's type, an element) orders nothing, so the mutual references among the kernel's records -- the
 * cycle the reference implementation's bootstrap closes by hand-building a set of entries -- are
 * never a wait here: this port reads an instance through hand-written bindings (`schema/bindings.ts`), which
 * need no compiled reader of the type a payload is read against. A wait that does cycle is a resolver error
 * naming the cycle, and only an edit of the kernel could introduce one.
 *
 * **Zero I/O, by design.** `source` is a parameter rather than a hard-coded fetch: the caller (a test, or
 * the front door) hands this function the kernel's own real, bundled bytes (`spec/m/meta.tn`, vendored
 * verbatim), unread and unmodified. This keeps the module import-clean for a browser bundle: no
 * `node:fs`, no conditional export.
 */
import { TsonInternalError } from '../core/errors.js';
import { fromBytes, runSync } from '../io/bytes.js';
import { toCoreValue } from '../bind/encode.js';
import { parseSchemaDocument } from '../compiler/schemaParser.js';
import { resolveSchema, type Schema } from '../compiler/schemaResolver.js';
import { defaultAtomEncoder } from '../write/bindingWriter.js';
import { createDefinitionMetaReader } from './metaReader.js';
import { createDefinitionValueReader } from './namespaceReader.js';
import { topBinding } from './bindings.js';

/** Parses and resolves the kernel's own source text (see this module's own doc). */
export function bootstrapKernel(source: Uint8Array): Schema {
  const document = runSync(parseSchemaDocument(fromBytes(source)));
  if (document.id === undefined) {
    throw new TsonInternalError(
      'meta.tn has no !!id -- this should never happen for the real, bundled kernel',
    );
  }
  if (document.imports.length > 0) {
    throw new TsonInternalError('the kernel imports nothing (§3.4), and this document does');
  }
  const resolved = resolveSchema(document, {
    readers: (lookup) => ({
      meta: createDefinitionMetaReader(lookup),
      value: createDefinitionValueReader(lookup),
    }),
    // §5.7: an atom refinement merges onto its source's wire record before binding, and the kernel has
    // several. A `Binding` is bidirectional by construction, so the merge runs through `bind/encode.ts`
    // rather than through a writer the resolver would otherwise have to hold.
    encodeSourceBody: (body) => toCoreValue(topBinding, body, defaultAtomEncoder),
  });
  return { ...resolved, bootstrap: true };
}
