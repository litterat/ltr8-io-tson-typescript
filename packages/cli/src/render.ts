/**
 * Renders a command's run result in one of the three formats every command shares: `text` (for a
 * person), `json` (a plain JSON document, for another program), and `tson` -- produced by
 * `@ltr8/tson`'s own writer over a hand-built `tree/nodes.ts` {@link Value}, never string
 * concatenation, per this work package's own brief.
 *
 * `--format json`/`--format tson` spell one report one way: `snake_case` keys, and an absent
 * field left out of the object entirely rather than written `null` -- both already matched this
 * project's own convention before `outcome`/`policy` existed, so only the field content below is
 * new (mirrors the reference implementation's `6c47fc0e`, "spell one report one way in both
 * machine formats").
 */
import { arrayNode, atomNode, recordNode, write, type Value } from '@ltr8/tson';
import type { CompileRun } from './commands/compile.js';
import type { HashRun } from './commands/hash.js';
import type { ValidateRun } from './commands/validate.js';
import { diagnosticJson, diagnosticNode, diagnosticText } from './diagnosticNode.js';
import type { Outcome } from './outcome.js';
import { policyJson, policyNode, policyNote, policyText } from './policyNode.js';
import type { ProcessorPolicy } from './policyOptions.js';

export type Format = 'text' | 'json' | 'tson';

export function parseFormat(raw: string): Format {
  if (raw === 'text' || raw === 'json' || raw === 'tson') return raw;
  throw new RangeError(`--format must be one of text, json, tson (got '${raw}')`);
}

/** Sets `fields.get(name)` to an atom node of `value`, only when `value` is present -- the tson-format counterpart of spreading `{ ...(v === undefined ? {} : { [k]: v }) }` into a JSON object below. */
function optionalField(fields: Map<string, Value>, name: string, value: string | undefined): void {
  if (value !== undefined) fields.set(name, atomNode(value));
}

function runNode(outcome: Outcome, files: readonly Value[], policy?: Value): Value {
  const fields = new Map<string, Value>([['outcome', atomNode(outcome)]]);
  if (policy !== undefined) fields.set('policy', policy);
  fields.set('files', arrayNode(files));
  return recordNode(fields);
}

// ── validate ─────────────────────────────────────────────────────────────────────────────────

function validateFileNode(file: ValidateRun['files'][number]): Value {
  return recordNode(
    new Map<string, Value>([
      ['file', atomNode(file.file)],
      ['outcome', atomNode(file.outcome)],
      ['diagnostics', arrayNode(file.diagnostics.map(diagnosticNode))],
    ]),
  );
}

export function renderValidateRun(run: ValidateRun, format: Format): string {
  if (format === 'json') {
    return JSON.stringify(
      {
        outcome: run.outcome,
        policy: policyJson(run.policy),
        files: run.files.map((f) => ({
          file: f.file,
          outcome: f.outcome,
          diagnostics: f.diagnostics.map(diagnosticJson),
        })),
      },
      null,
      2,
    );
  }
  if (format === 'tson') {
    return write(runNode(run.outcome, run.files.map(validateFileNode), policyNode(run.policy)));
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
  lines.push(run.outcome === 'VALID' ? 'valid' : 'invalid');
  const note = policyNote(
    run.policy,
    run.files.flatMap((f) => f.diagnostics.map((d) => d.code)),
  );
  if (note !== '') lines.push(note);
  return lines.join('\n');
}

// ── compile ──────────────────────────────────────────────────────────────────────────────────

export function renderCompileRun(run: CompileRun, format: Format): string {
  if (format === 'json') {
    return JSON.stringify(
      {
        outcome: run.outcome,
        policy: policyJson(run.policy),
        files: run.files.map((f) => ({
          file: f.file,
          outcome: f.outcome,
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
        ['outcome', atomNode(f.outcome)],
      ]);
      optionalField(fields, 'id', f.id);
      if (f.entryCount !== undefined) fields.set('entry_count', atomNode(BigInt(f.entryCount)));
      optionalField(fields, 'message', f.message);
      return recordNode(fields);
    });
    return write(runNode(run.outcome, fileNodes, policyNode(run.policy)));
  }
  const lines: string[] = [];
  for (const f of run.files) {
    lines.push(
      f.outcome === 'VALID'
        ? `${f.file}: compiles (${f.id ?? '?'}, ${String(f.entryCount ?? 0)} entries)`
        : `${f.file}: ${f.message ?? 'does not compile'}`,
    );
  }
  lines.push(run.outcome === 'VALID' ? 'valid' : 'invalid');
  // `compile`'s per-file results carry no diagnostic codes today (`CompileFileResult` has no
  // `diagnostics` list -- see its own module doc), so a §8.2 refusal cannot be distinguished from
  // any other reason a schema fails to resolve; `policyNote` still fires on a non-default policy.
  const note = policyNote(run.policy, []);
  if (note !== '') lines.push(note);
  return lines.join('\n');
}

// ── hash ─────────────────────────────────────────────────────────────────────────────────────

export function renderHashRun(run: HashRun, format: Format): string {
  if (format === 'json') {
    return JSON.stringify(
      {
        outcome: run.outcome,
        files: run.files.map((f) => ({
          file: f.file,
          outcome: f.outcome,
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
        ['outcome', atomNode(f.outcome)],
      ]);
      optionalField(fields, 'id', f.id);
      optionalField(fields, 'content_hash', f.contentHash);
      optionalField(fields, 'pinned_reference', f.pinnedReference);
      optionalField(fields, 'problem', f.problem);
      return recordNode(fields);
    });
    return write(runNode(run.outcome, fileNodes));
  }
  const lines: string[] = [];
  for (const f of run.files) {
    if (f.outcome !== 'VALID') {
      lines.push(`${f.file}: ${f.problem ?? 'could not be hashed'}`);
      continue;
    }
    lines.push(`${f.file}: sha256:${f.contentHash ?? ''}`);
    if (f.pinnedReference !== undefined) lines.push(`${f.file}: ${f.pinnedReference}`);
  }
  lines.push(run.outcome === 'VALID' ? 'valid' : 'invalid');
  return lines.join('\n');
}

// ── policy ───────────────────────────────────────────────────────────────────────────────────

/** `tson policy`'s own rendering -- no run envelope, since this states this processor's configuration, not a verdict on anything. */
export function renderPolicy(policy: ProcessorPolicy, format: Format): string {
  if (format === 'json') {
    return JSON.stringify(policyJson(policy), null, 2);
  }
  if (format === 'tson') {
    return write(policyNode(policy));
  }
  return policyText(policy);
}
