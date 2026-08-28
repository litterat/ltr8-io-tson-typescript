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
import { readIdDirective, sha256Hex, withSha256Pin } from '../contentHash.js';
import { describeError } from '../problem.js';

export interface HashFileResult {
  readonly file: string;
  readonly ok: boolean;
  readonly id?: string;
  readonly contentHash?: string;
  readonly pinnedReference?: string;
  /** Why `ok` is `false` -- a content problem (no line terminator on an otherwise-openable file). */
  readonly problem?: string;
}

/** Reads and hashes one file. Throws only for a problem that stops the whole run (an unreadable file) -- see `commands/validate.ts`'s own note on that split, applied identically here. */
async function hashOne(file: string): Promise<HashFileResult> {
  const bytes = await readFile(file);
  const contentHash = await sha256Hex(bytes); // throws RangeError when the first line has no terminator
  const id = readIdDirective(bytes)?.id;
  return {
    file,
    ok: true,
    ...(id === undefined ? {} : { id, pinnedReference: withSha256Pin(id, contentHash) }),
    contentHash,
  };
}

export interface HashRun {
  readonly ok: boolean;
  readonly files: readonly HashFileResult[];
}

/** Runs `hash` over every file, without throwing for a per-file content problem -- only an unreadable file escapes as a rejected promise, for the caller to classify as a usage failure. */

/** Whether `error` is a node system error carrying `code`. */
function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

export async function runHash(files: readonly string[]): Promise<HashRun> {
  const results: HashFileResult[] = [];
  for (const file of files) {
    try {
      results.push(await hashOne(file));
    } catch (error) {
      // `RangeError` alone is too wide a net. `sha256Hex` raises one for a document whose first
      // line has no terminator — a real content verdict — but node's own readFile raises
      // ERR_FS_FILE_TOO_LARGE as a RangeError too, for a file over 2 GiB. Reported as a content
      // verdict, that told a caller their file was invalid when it had never been read at all,
      // and exited 1 where a usage failure was the honest answer.
      if (error instanceof RangeError && !isNodeError(error, 'ERR_FS_FILE_TOO_LARGE')) {
        results.push({ file, ok: false, problem: describeError(error) });
        continue;
      }
      throw error; // an unreadable file -- the caller's job to classify as a usage failure
    }
  }
  return { ok: results.every((r) => r.ok), files: results };
}
