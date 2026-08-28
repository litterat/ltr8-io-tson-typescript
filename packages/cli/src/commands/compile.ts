/**
 * `tson compile <schema>...` -- checks that each schema document resolves and links against the
 * bundled standard library (meta-kernel, meta.tn, core.tn; see `../stdlib.ts`).
 *
 * **Deliberately does not force every entry's compiled reader.** `@ltr8/tson`'s `compile()` is
 * lazy (`compiler/compile.ts`'s own doc), building a `TypeReader` only on first request, so
 * eagerly calling `.reader(name)` for every entry a schema declares would be the more thorough
 * check -- but it is also *wrong*: an entry left as an unapplied open template (a schema
 * legitimately declaring a reusable generic it never itself instantiates) throws
 * `TsonNotImplementedError` the moment its reader is requested (`compile.ts`'s own "a
 * TemplateBody reaching compilation at all means an open entry was named directly"), which is
 * true of *reading a value against it*, not of the schema being malformed. Forcing every reader
 * would flag such a schema as broken when it is not. So `compile` reports "resolves and links" --
 * exactly what `Tson.resolveSchema` already checks (composition, refinement, template
 * application at every *closed* use site, reference validity, choice disjointness, `subtypes`) --
 * and leaves "does entry X actually read?" to `tson validate --schema ... --root X`, which is a
 * question about a root, not about the schema as a whole.
 */
import { readFile } from 'node:fs/promises';
import type { LinkedSchema, Tson } from '@ltr8/tson';
import { isInvalidSchemaError } from '../problem.js';
import { stdlibTson } from '../stdlib.js';

export interface CompileFileResult {
  readonly file: string;
  readonly ok: boolean;
  readonly id?: string;
  readonly entryCount?: number;
  readonly message?: string;
}

async function compileOne(tson: Tson, file: string): Promise<CompileFileResult> {
  const bytes = await readFile(file);
  let linked: LinkedSchema;
  try {
    linked = tson.resolveSchema(bytes);
  } catch (error) {
    if (isInvalidSchemaError(error)) {
      return { file, ok: false, message: error.message };
    }
    throw error;
  }
  return { file, ok: true, id: linked.id, entryCount: linked.entries.size };
}

export interface CompileRun {
  readonly ok: boolean;
  readonly files: readonly CompileFileResult[];
}

/** Runs `compile` over every file. A schema that fails to resolve/link is a per-file result, not a thrown error; an unreadable file still throws, for the caller to classify as a usage failure. */
export async function runCompile(files: readonly string[]): Promise<CompileRun> {
  const tson = stdlibTson();
  const results: CompileFileResult[] = [];
  for (const file of files) {
    results.push(await compileOne(tson, file));
  }
  return { ok: results.every((r) => r.ok), files: results };
}
