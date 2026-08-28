/**
 * Fetches a schema document's raw bytes from beyond wherever a caller has already registered one
 * — the two hardened `SchemaSource` implementations this package ships, published as
 * `@ltr8/tson/source` and **never** from the package's default entry (`CLAUDE.md`: "Neither
 * source may be reachable by default from a browser build").
 *
 * A schema reference is attacker-controlled (a data document names its own schema, so in a
 * server the string reaching either source came out of a request body), so both are deny-by-
 * default, and every policy control each one documents is load-bearing, not a default worth
 * relaxing: see `httpSchemaSource.ts` and `fileSchemaSource.ts`'s own module docs for the
 * exhaustive list.
 *
 * **Node-only.** Both implementations use platform surfaces (`fetch`/`URL`/`AbortController` for
 * the HTTPS source, `node:fs`/`node:path` for the file source) that this package's own type
 * configuration deliberately excludes everywhere else (`CLAUDE.md`'s "no DOM lib, no Node
 * built-ins in code that must run in a browser") — `src/source/tsconfig.json` is this
 * subdirectory's own project, scoped to just these files, with `types: ["node"]` set. A consumer
 * targeting a browser simply never imports this subpath; `config.ts`'s `SchemaSource` interface
 * is the structural shape a caller supplies instead, satisfied by either of these or by anything
 * else with a matching `fetch` method — a mock in a test, an in-memory map for a browser build
 * that ships its schemas as static assets.
 *
 * Neither verifies a fetched document's `?sha256=` pin or cross-checks its embedded `!!id` —
 * `reference.ts`'s own top note says why that stays the loader's job (`config.ts`'s
 * `resolveSchema`/`register`).
 */
export type { SchemaSource } from '../config.js';
export {
  httpSchemaSource,
  DEFAULT_MAX_DOCUMENT_BYTES as HTTP_DEFAULT_MAX_DOCUMENT_BYTES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_CACHED_SCHEMAS as HTTP_DEFAULT_MAX_CACHED_SCHEMAS,
  type HttpSchemaSource,
  type HttpSchemaSourceOptions,
} from './httpSchemaSource.js';
export {
  fileSchemaSource,
  DEFAULT_MAX_DOCUMENT_BYTES as FILE_DEFAULT_MAX_DOCUMENT_BYTES,
  DEFAULT_MAX_CACHED_SCHEMAS as FILE_DEFAULT_MAX_CACHED_SCHEMAS,
  type FileSchemaSource,
  type FileSchemaSourceOptions,
} from './fileSchemaSource.js';
export type { PermittedReference } from './reference.js';
export { permittedReference } from './reference.js';
