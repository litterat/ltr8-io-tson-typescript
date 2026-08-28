/**
 * The schema-driven readers that build `tree/nodes.ts` {@link Value} nodes from a compiled schema
 * entry's own event sequence -- the port of `tson-compiler/.../reader/*TreeReader.java`. Layered on
 * `reader/contracts.ts` (frozen) and `reader/context.ts`'s one `ReadContext` implementation; produces
 * `tree/` nodes without `tree/` ever having to import the event stream or the schema layer itself (see
 * `eslint.config.js`'s `tree/**` zone).
 *
 * Not yet wired into `reader/index.ts` or the package's public subpath exports: `factory.ts`'s
 * {@link TreeReaderContext} needs a whole-schema `name -> reader` table (recursive/cyclic resolution
 * included) that only Wave 5's compiler builds. Import from `reader/tree/*.js` directly until then.
 */
export { recordTreeReader } from './record.js';
export { mapTreeReader } from './map.js';
export { arrayTreeReader } from './array.js';
export { tupleTreeReader } from './tuple.js';
export { atomTreeReader, atomTypeReader } from './atom.js';
export { absentTreeReader } from './absent.js';
export { captureAnnotations } from './annotations.js';
export {
  describeEvent,
  skipAnnotations,
  skipAnnotationsAndTypeRef,
  skipCoreValue,
  skipDataValue,
  skipScopedValue,
  skipTypeRef,
} from './grammar.js';
export { deepEqual, valuesEqual } from './equality.js';
export { readSchemaLiteral, renderValue, type TreeTypeResolver } from './support.js';
export {
  recordReaderFactory,
  mapReaderFactory,
  arrayReaderFactory,
  tupleReaderFactory,
  type TreeReaderContext,
} from './factory.js';
