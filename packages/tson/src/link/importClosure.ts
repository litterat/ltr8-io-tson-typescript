/**
 * The one namespace a document's `!!import`s merge into ([TSON-DATA] §2.2, [TSON-SCHEMA] §2.2.3): what a data
 * document naming several schemas is read under, in either encoding. One import (in any number of spellings) is
 * that schema's own namespace. Several are a schema of no entries of its own importing each of them, with the
 * collision rule a schema's imports are judged by -- a name two of them declare differently refuses the whole
 * namespace -- linked under an identity derived from theirs that is never registered.
 *
 * It lives in `link/` so the JSON encoding's `$import` list, which stands for the same `!!import`s, reaches the
 * rule through the paths `src/json` may import.
 */
import type { ImportResolver } from '../compiler/schemaResolver.js';
import { encodeUtf8 } from '../io/utf8.js';
import type { IdentifierPolicy } from '../unicode/policy.js';
import { sha256HexSync } from './contentHash.js';
import { canonicalizeIdentity } from './identity.js';
import { linkSchema, type LinkedSchema } from './link.js';

/** The canonical identities `imports` name, each once, in header order. */
export function importIdentities(imports: readonly string[]): readonly string[] {
  return [...new Set(imports.map((uri) => canonicalizeIdentity(uri)))];
}

/**
 * The identity a set of imports is linked under: a path-only identity ([TSON-DATA] §2.2.1) named by a digest of
 * the canonical identities in header order, so one set always names one namespace.
 */
export function closureIdentity(identities: readonly string[]): string {
  return `/imports/${sha256HexSync(encodeUtf8(identities.join('\n')))}`;
}

/**
 * Links the schema of no entries of its own that imports each of `imports`, which `resolveImport` supplies
 * already linked.
 *
 * @throws TsonSchemaValidationError where two imports declare one name differently (§2.2.3).
 */
export function linkImportClosure(
  imports: readonly string[],
  resolveImport: ImportResolver,
  identifierPolicy?: IdentifierPolicy,
): LinkedSchema {
  return linkSchema(
    {
      id: closureIdentity(importIdentities(imports)),
      imports: [...imports],
      entries: new Map(),
      keyAnnotations: new Map(),
      facts: new Map(),
      bootstrap: false,
    },
    { resolveImport, ...(identifierPolicy === undefined ? {} : { identifierPolicy }) },
  );
}
