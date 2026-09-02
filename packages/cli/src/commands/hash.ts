/**
 * `tson hash <file>...` -- computes each document's canonical content hash ([TSON-DATA] §2.2.1:
 * SHA-256 over every byte past the first line's terminator) and, when the document declares
 * `!!id`, the reference pinned with that hash (`<id>?sha256=<hex>`, any existing `sha256`
 * parameter replaced). Applies to any TSON document, schema or data -- content hashing is a
 * general §2.2.1 mechanism, not a schema-specific one, though the usage line (matching this
 * work package's own placeholder) names the argument `<schema>` since that is the overwhelming
 * common case.
 *
 * **Read-only.** This command prints the pinned reference; it does not rewrite the input file in
 * place the way the reference implementation's `tson hash` does. Stamping a file in place is a
 * bigger commitment (does a caller want a backup? an opt-in flag?) than this work package's own
 * brief settles, so the safer default -- print, let the caller decide what to do with it -- is
 * what ships; a caller who wants the file rewritten pipes the printed reference into their own
 * edit. See this CLI's own top-level report for this as a deliberate, documented divergence.
 */
import { readFile } from 'node:fs/promises';
import { sha256Hex, withSha256Pin, TsonSchemaValidationError } from '@ltr8/tson/identity';
import { readIdDirective } from '../idDirective.js';
import { outcomeOfFiles, type Outcome } from '../outcome.js';
import { describeError } from '../problem.js';

export interface HashFileResult {
  readonly file: string;
  readonly outcome: Outcome;
  readonly id?: string;
  readonly contentHash?: string;
  readonly pinnedReference?: string;
  /** Why `outcome` is `'INVALID'` -- a content problem (no line terminator on an otherwise-openable file). Never `'NOT_CHECKED'`: an unreadable file throws past this result entirely rather than becoming one. */
  readonly problem?: string;
}

/** Reads and hashes one file. Throws only for a problem that stops the whole run (an unreadable file) -- see `commands/validate.ts`'s own note on that split, applied identically here. */
async function hashOne(file: string): Promise<HashFileResult> {
  const bytes = await readFile(file);
  // Throws TsonSchemaValidationError when the first line has no terminator -- a content verdict
  // on the document, which `runHash` below turns into a per-file result rather than a run failure.
  const contentHash = await sha256Hex(bytes);
  const id = readIdDirective(bytes)?.id;
  return {
    file,
    outcome: 'VALID',
    ...(id === undefined ? {} : { id, pinnedReference: withSha256Pin(id, contentHash) }),
    contentHash,
  };
}

export interface HashRun {
  readonly outcome: Outcome;
  readonly files: readonly HashFileResult[];
}

/** Runs `hash` over every file, without throwing for a per-file content problem -- only an unreadable file escapes as a rejected promise, for the caller to classify as a usage failure. */

export async function runHash(files: readonly string[]): Promise<HashRun> {
  const results: HashFileResult[] = [];
  for (const file of files) {
    try {
      results.push(await hashOne(file));
    } catch (error) {
      // Only the library's own §2.2.1 verdict is a per-file result. Everything else -- an
      // unreadable file, node's own ERR_FS_FILE_TOO_LARGE for a file over 2 GiB -- means the
      // document was never read, and reporting that as "invalid" would tell a caller their file
      // was bad when nothing had been checked.
      if (error instanceof TsonSchemaValidationError) {
        results.push({ file, outcome: 'INVALID', problem: describeError(error) });
        continue;
      }
      throw error; // an unreadable file -- the caller's job to classify as a usage failure
    }
  }
  return { outcome: outcomeOfFiles(results.map((r) => r.outcome)), files: results };
}
