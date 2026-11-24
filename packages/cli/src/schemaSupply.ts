/**
 * The schema documents a run was handed on its command line, served by the `!!id` each declares.
 *
 * `Tson.loadSchema` fetches a schema's imports and its externs' schemas through
 * `Config.schemaSource` ([TSON-SCHEMA] §5.13, §7.8), so a schema that names anything beyond the
 * bundled library loads only when something supplies the rest. What supplies it here is the
 * command line and nothing else: the files given are the run's whole configuration, and a
 * reference no file declares is refused as `'not-found'` by `mapSchemaSource`, never fetched. A
 * schema reference is attacker-controlled (`@ltr8/tson/source`'s own note), so no network or
 * directory source is ever configured here.
 */
import { mapSchemaSource, type SchemaSource } from '@ltr8/tson';
import { readIdDirective } from './idDirective.js';

/** A schema document as read from disk. */
export interface SchemaFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/**
 * A source serving every file in `files` whose first line is `!!id:"…"`, or `undefined` when none
 * is. A file with no such line cannot be named by a reference and is skipped; loading it directly
 * still reports that its `!!id` is required.
 */
export function suppliedSource(files: readonly SchemaFile[]): SchemaSource | undefined {
  const byId = new Map<string, Uint8Array>();
  for (const file of files) {
    const id = readIdDirective(file.bytes)?.id;
    if (id !== undefined) byId.set(id, file.bytes);
  }
  return byId.size === 0 ? undefined : mapSchemaSource(byId);
}
