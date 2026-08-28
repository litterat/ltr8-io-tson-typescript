/**
 * Streaming emit -- the write-side counterpart to the read stack, covering all three value
 * models this package produces: the parse-preserving `ast/value.ts` tree (`astWriter.ts`), the
 * queryable `tree/nodes.ts` tree (`treeWriter.ts`), and a bound host object graph
 * (`bindingWriter.ts`), all built on one grammar-level `Emitter` (`emitter.ts`).
 *
 * **Depends on `ast/`, `atom/`, `bind/`, `lexer/`, `reader/schemaless/vocabulary.ts` and `tree/`
 * -- never `compiler/`.** `bindingWriter.ts`'s own top note explains why that dependency is gone
 * by construction rather than merely avoided: `bind/encode.ts` already turns a bound value into
 * an `ast.DataValue` with no writer involved, so the writers can live here instead of inside
 * `tson-compiler` the way the Java reference's `DefinitionResolver`/`TsonObjectWriter`
 * circularity forces them to.
 *
 * **Canonical form vs. readable form.** Every writer here produces the same, single spelling for
 * a given input -- one space between elements, vocabulary atoms always quoted, numeric atoms
 * always bare -- which is what makes {@link writeDocument}/{@link writeTree}/{@link writeBinding}
 * suitable as the byte-stable input a content hash is taken over (`link/contentHash.ts`, §2.2.1):
 * there is no separate "pretty" mode with a different amount of whitespace or indentation to pick
 * between, so a given value's canonical text and its human-readable text are the same call.
 * `astWriter.ts` is the one exception worth calling out: it reproduces a *parsed* document's own
 * token choices (quoted vs. unquoted, original field order) rather than normalising them, so two
 * different byte streams that parse to the same value can still write back as two different byte
 * streams through it -- exactly the property `write/*.test.ts`'s round-trip tests need (parse,
 * write, re-parse), and exactly why it is not the writer a content hash should be taken over.
 */
export type { Emitter, TextSink } from './emitter.js';
export { createEmitter, stringSink } from './emitter.js';

export {
  writeDocument,
  writeDocumentTo,
  writeDocumentToSink,
  writeDataValue,
  writeDataValueTo,
} from './astWriter.js';

export {
  writeTree,
  writeTreeTo,
  writeTreeToSink,
  writeTreeValue,
  writeTreeValueTo,
} from './treeWriter.js';

export {
  writeBinding,
  writeBindingTo,
  writeBindingToSink,
  defaultAtomEncoder,
} from './bindingWriter.js';

export type { AtomText } from './atomFraming.js';
export { formatKnownAtom, formatDefaultAtom } from './atomFraming.js';
