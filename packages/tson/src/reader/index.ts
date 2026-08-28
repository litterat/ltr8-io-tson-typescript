/**
 * The compiled reader base: the frozen `TypeReader`/`ReadContext`/`ValueReaderFactory` contracts
 * plus `context.ts`'s one implementation of them. The three concrete reader families (tree, bind,
 * schemaless) build on this, never on a reader stack of their own.
 *
 * `contracts.ts` states `createReadContext`/`lookingAhead` as `declare function` -- a contract
 * with no runtime body of its own, exactly as `TypeReader`/`ReadContext`/`ValueReaderFactory`/
 * `ValueReaderFactoryRegistry` state shapes with none. `context.ts` is what actually implements
 * the two functions; re-exporting both files' same-named declarations here would leave a consumer
 * of this subpath free to land on the body-less stub instead. Only the types come from
 * `contracts.ts` here -- the functions come from `context.ts`, the only place they have a body.
 */
export type {
  TypeReader,
  ReadContext,
  ValueReaderFactory,
  ValueReaderFactoryRegistry,
} from './contracts.js';
export * from './context.js';
export * from './bind.js';
export * from './schemaless/index.js';
