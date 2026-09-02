/**
 * `tson compile [<policy options>] <schema>...` -- checks that each schema document resolves and
 * links against the bundled standard library (meta-kernel, meta.tn, core.tn; see `../stdlib.ts`),
 * under `identifierPolicy` ([TSON-SCHEMA] §11.4's schema-layer name hygiene).
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
import { outcomeOfFiles, type Outcome } from '../outcome.js';
import { isInvalidSchemaError } from '../problem.js';
import { processorPolicyOf, type PolicyOptions, type ProcessorPolicy } from '../policyOptions.js';
import { stdlibTson } from '../stdlib.js';

export interface CompileFileResult {
  readonly file: string;
  readonly outcome: Outcome;
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
      return { file, outcome: 'INVALID', message: error.message };
    }
    throw error;
  }
  return { file, outcome: 'VALID', id: linked.id, entryCount: linked.entries.size };
}

export interface CompileRun {
  readonly outcome: Outcome;
  /** Stated once for the run, never per file -- mirrors `commands/validate.ts`'s own `ValidateRun.policy`. */
  readonly policy: ProcessorPolicy;
  readonly files: readonly CompileFileResult[];
}

/** Runs `compile` over every file. A schema that fails to resolve/link is a per-file result, not a thrown error; an unreadable file still throws, for the caller to classify as a usage failure. */
export async function runCompile(
  files: readonly string[],
  policy: PolicyOptions,
): Promise<CompileRun> {
  const tson = stdlibTson({ identifierPolicy: policy.identifierPolicy });
  const results: CompileFileResult[] = [];
  for (const file of files) {
    results.push(await compileOne(tson, file));
  }
  return {
    outcome: outcomeOfFiles(results.map((r) => r.outcome)),
    policy: processorPolicyOf(policy),
    files: results,
  };
}
