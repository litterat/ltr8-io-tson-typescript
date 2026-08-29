/**
 * Renders a command's run result in one of the three formats every command shares: `text` (for a
 * person), `json` (a plain JSON document, for another program), and `tson` -- produced by
 * `@ltr8/tson`'s own writer over a hand-built `tree/nodes.ts` {@link Value}, never string
 * concatenation, per this work package's own brief.
 */
import { arrayNode, atomNode, recordNode, write, type Value } from '@ltr8/tson';
import type { CompileRun } from './commands/compile.js';
import type { HashRun } from './commands/hash.js';
import type { ValidateRun } from './commands/validate.js';
import { diagnosticJson, diagnosticNode, diagnosticText } from './diagnosticNode.js';

export type Format = 'text' | 'json' | 'tson';

export function parseFormat(raw: string): Format {
  if (raw === 'text' || raw === 'json' || raw === 'tson') return raw;
  throw new RangeError(`--format must be one of text, json, tson (got '${raw}')`);
}

/** Sets `fields.get(name)` to an atom node of `value`, only when `value` is present -- the tson-format counterpart of spreading `{ ...(v === undefined ? {} : { [k]: v }) }` into a JSON object below. */
function optionalField(fields: Map<string, Value>, name: string, value: string | undefined): void {
  if (value !== undefined) fields.set(name, atomNode(value));
}

function runNode(valid: boolean, files: readonly Value[]): Value {
  return recordNode(
    new Map<string, Value>([
      ['valid', atomNode(valid)],
      ['files', arrayNode(files)],
    ]),
  );
}

// ── validate ─────────────────────────────────────────────────────────────────────────────────

function validateFileNode(file: ValidateRun['files'][number]): Value {
  const fields = new Map<string, Value>([
    ['file', atomNode(file.file)],
    ['valid', atomNode(file.ok)],
    ['diagnostics', arrayNode(file.diagnostics.map(diagnosticNode))],
  ]);
  if (file.notImplemented === true) fields.set('not_implemented', atomNode(true));
  if (file.schemaUnavailable === true) fields.set('schema_unavailable', atomNode(true));
  return recordNode(fields);
}

export function renderValidateRun(run: ValidateRun, format: Format): string {
  if (format === 'json') {
    return JSON.stringify(
      {
        valid: run.ok,
        files: run.files.map((f) => ({
          file: f.file,
          valid: f.ok,
          diagnostics: f.diagnostics.map(diagnosticJson),
          ...(f.notImplemented === true ? { not_implemented: true } : {}),
          ...(f.schemaUnavailable === true ? { schema_unavailable: true } : {}),
        })),
      },
      null,
      2,
    );
  }
  if (format === 'tson') {
    return write(runNode(run.ok, run.files.map(validateFileNode)));
  }
  const lines: string[] = [];
  const multiple = run.files.length > 1;
  for (const f of run.files) {
    if (multiple) lines.push(`# ${f.file}`);
    if (f.diagnostics.length === 0) {
      lines.push(`${f.file}: valid`);
    } else {
      for (const d of f.diagnostics) lines.push(`${f.file}: ${diagnosticText(d)}`);
    }
  }
  lines.push(run.ok ? 'valid' : 'invalid');
  return lines.join('\n');
}

// ── compile ──────────────────────────────────────────────────────────────────────────────────

export function renderCompileRun(run: CompileRun, format: Format): string {
  if (format === 'json') {
    return JSON.stringify(
      {
        valid: run.ok,
        files: run.files.map((f) => ({
          file: f.file,
          valid: f.ok,
          ...(f.id === undefined ? {} : { id: f.id }),
          ...(f.entryCount === undefined ? {} : { entry_count: f.entryCount }),
          ...(f.message === undefined ? {} : { message: f.message }),
        })),
      },
      null,
      2,
    );
  }
  if (format === 'tson') {
    const fileNodes = run.files.map((f) => {
      const fields = new Map<string, Value>([
        ['file', atomNode(f.file)],
        ['valid', atomNode(f.ok)],
      ]);
      optionalField(fields, 'id', f.id);
      if (f.entryCount !== undefined) fields.set('entry_count', atomNode(BigInt(f.entryCount)));
      optionalField(fields, 'message', f.message);
      return recordNode(fields);
    });
    return write(runNode(run.ok, fileNodes));
  }
  const lines: string[] = [];
  for (const f of run.files) {
    lines.push(
      f.ok
        ? `${f.file}: compiles (${f.id ?? '?'}, ${String(f.entryCount ?? 0)} entries)`
        : `${f.file}: ${f.message ?? 'does not compile'}`,
    );
  }
  lines.push(run.ok ? 'valid' : 'invalid');
  return lines.join('\n');
}

// ── hash ─────────────────────────────────────────────────────────────────────────────────────

export function renderHashRun(run: HashRun, format: Format): string {
  if (format === 'json') {
    return JSON.stringify(
      {
        valid: run.ok,
        files: run.files.map((f) => ({
          file: f.file,
          valid: f.ok,
          ...(f.id === undefined ? {} : { id: f.id }),
          ...(f.contentHash === undefined ? {} : { content_hash: f.contentHash }),
          ...(f.pinnedReference === undefined ? {} : { pinned_reference: f.pinnedReference }),
          ...(f.problem === undefined ? {} : { problem: f.problem }),
        })),
      },
      null,
      2,
    );
  }
  if (format === 'tson') {
    const fileNodes = run.files.map((f) => {
      const fields = new Map<string, Value>([
        ['file', atomNode(f.file)],
        ['valid', atomNode(f.ok)],
      ]);
      optionalField(fields, 'id', f.id);
      optionalField(fields, 'content_hash', f.contentHash);
      optionalField(fields, 'pinned_reference', f.pinnedReference);
      optionalField(fields, 'problem', f.problem);
      return recordNode(fields);
    });
    return write(runNode(run.ok, fileNodes));
  }
  const lines: string[] = [];
  for (const f of run.files) {
    if (!f.ok) {
      lines.push(`${f.file}: ${f.problem ?? 'could not be hashed'}`);
      continue;
    }
    lines.push(`${f.file}: sha256:${f.contentHash ?? ''}`);
    if (f.pinnedReference !== undefined) lines.push(`${f.file}: ${f.pinnedReference}`);
  }
  lines.push(run.ok ? 'valid' : 'invalid');
  return lines.join('\n');
}
