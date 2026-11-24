/**
 * `tson compile [<policy options>] <schema>...` -- checks that each schema document loads: it
 * resolves and links against the bundled standard library (meta, numeric, temporal, net, core and
 * policy; see `../stdlib.ts`) and against the other schema files on the command line, under
 * `identifierPolicy` ([TSON-SCHEMA] §11.4's schema-layer name hygiene).
 *
 * **Every file is both a subject and a supply.** Each schema is loaded with `Tson.loadSchema`,
 * which fetches what it imports and what its externs name ([TSON-SCHEMA] §5.13, §7.8) through a
 * source serving the files given here by their `!!id` (`../schemaSupply.ts`). A schema naming one
 * no file declares is refused as unobtainable -- never fetched -- and reported as a rejection.
 *
 * **Deliberately does not force every entry's compiled reader.** `@ltr8/tson`'s `compile()` is
 * lazy (`compiler/compile.ts`'s own doc), building a `TypeReader` only on first request, so
 * eagerly calling `.reader(name)` for every entry a schema declares would be the more thorough
 * check -- but it is also *wrong*: an entry left as an incomplete entry or a parametric record (a
 * schema legitimately declaring a reusable form it never itself completes or applies) has no
 * reader to build, which is true of *reading a value against it*, not of the schema being
 * malformed. Forcing every reader would flag such a schema as broken when it is not. So `compile`
 * reports "loads" -- exactly what `Tson.loadSchema` already checks (composition, refinement,
 * application at every closed use site, reference validity, choice disjointness, `subtypes`) --
 * and leaves "does entry X actually read?" to `tson validate --schema ... --root X`, which is a
 * question about a root, not about the schema as a whole.
 */
import { readFile } from 'node:fs/promises';
import {
  TsonLimitRefusedError,
  TsonSchemaFetchError,
  TsonNameHygieneRefusedError,
  type LinkedSchema,
  type Tson,
} from '@ltr8/tson';
import { outcomeOfFiles, type Outcome } from '../outcome.js';
import { isInvalidSchemaError } from '../problem.js';
import {
  configOf,
  processorPolicyOf,
  type PolicyOptions,
  type ProcessorPolicy,
} from '../policyOptions.js';
import { suppliedSource, type SchemaFile } from '../schemaSupply.js';
import { stdlibTson } from '../stdlib.js';

export interface CompileFileResult {
  readonly file: string;
  readonly outcome: Outcome;
  readonly id?: string;
  readonly entryCount?: number;
  readonly message?: string;
}

async function compileOne(tson: Tson, schema: SchemaFile): Promise<CompileFileResult> {
  const file = schema.path;
  let linked: LinkedSchema;
  try {
    linked = await tson.loadSchema(schema.bytes);
  } catch (error) {
    // A schema this run was not given the means to obtain is rejected, like one that does not
    // resolve: the author holds the fix, by naming the file that declares it.
    if (isInvalidSchemaError(error) || error instanceof TsonSchemaFetchError) {
      return { file, outcome: 'REJECTED', message: error.message };
    }
    // §8.1's refused outcome: this processor's policy declined the schema, which says nothing
    // about whether it is valid -- a rejection here all the same, and (like any rejection) exit 1.
    // A §11.5 limit refusal is the same kind: this processor's own bound declined the schema, so a
    // rejection here that the author can fix by lowering the schema's depth or raising the limit.
    if (error instanceof TsonNameHygieneRefusedError || error instanceof TsonLimitRefusedError) {
      return { file, outcome: 'REJECTED', message: error.message };
    }
    throw error;
  }
  return { file, outcome: 'ACCEPTED', id: linked.id, entryCount: linked.entries.size };
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
  const schemas: SchemaFile[] = [];
  for (const path of files) {
    schemas.push({ path, bytes: await readFile(path) });
  }
  const tson = stdlibTson(configOf(policy), suppliedSource(schemas));
  const results: CompileFileResult[] = [];
  for (const schema of schemas) {
    results.push(await compileOne(tson, schema));
  }
  return {
    outcome: outcomeOfFiles(results.map((r) => r.outcome)),
    policy: processorPolicyOf(policy),
    files: results,
  };
}
