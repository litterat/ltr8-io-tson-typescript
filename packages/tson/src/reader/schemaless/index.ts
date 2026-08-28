/**
 * Class 1 (schemaless) reading: the readers that work with no compiled schema in scope, plus the
 * wire type-ref checking every one of them applies (`typeRefCheck.ts`, ported from `reader/
 * TypeRefCheck.java`). `reader/bind.ts`'s `bindReader` is this package's other schemaless reader
 * -- a `Binding` is authored independently of any schema (`PORT-PLAN.md`'s second architectural
 * decision) -- and is exported from `reader/index.ts` directly rather than from here, since it
 * predates this directory; both are equally schema-free.
 */
export { schemalessTreeReader, type SchemalessTreeReaderOptions } from './tree.js';
export { lookupBuiltinAtom } from './vocabulary.js';
export {
  describeEvent,
  reportAtomViolation,
  reportNotScalar,
  reportUnknownTypeRef,
} from './typeRefCheck.js';
