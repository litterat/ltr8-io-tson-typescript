/**
 * `write` -- the inverse of `readTree`/`validate`: one canonical-form {@link Value} tree back to
 * TSON text (`write/treeWriter.ts`'s own `writeTreeValue`/`writeTree`). The paired writer for the
 * front door's recommended default read, exactly as `write/index.ts`'s own top note describes the
 * canonical/readable-form identity -- there is no separate "pretty" mode to choose between.
 *
 * Depends on `write/`, which per that module's own top note reaches `ast/`, `atom/`, `bind/`,
 * `lexer/`, `reader/schemaless/vocabulary.ts` and `tree/` -- never `compiler/`. A caller wanting
 * to write the parse-preserving AST `parse` produces, or a bound host object, reaches for
 * `writeDocument`/`writeBinding` on the narrower `@ltr8/tson/write` subpath directly; this
 * function only ever writes a `tree/nodes.ts` {@link Value}.
 */
import { writeTree, writeTreeValue } from '../write/treeWriter.js';
import { tsonDocument } from '../tree/nodes.js';
import type { Value } from '../tree/nodes.js';

/** The document-level header directives {@link write} attaches (§2.2) -- omitted entirely means a plain, headerless Class 1 document. */
export interface WriteOptions {
  /** The document's own identity (`!!id`). */
  readonly id?: string;
  /** The schema governing this document's value (`!!schema`). */
  readonly schema?: string;
}

/** Writes `value` to TSON text, canonical form. With `options.id`/`options.schema`, writes the `!!id`/`!!schema` header directives (§2.2) ahead of it; with neither, writes a plain, headerless document. */
export function write(value: Value, options?: WriteOptions): string {
  if (options?.id === undefined && options?.schema === undefined) {
    return writeTreeValue(value);
  }
  return writeTree(tsonDocument(value, options.id, options.schema));
}
