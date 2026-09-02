/**
 * `outcome.ts`'s two derivations, checked against the reference implementation's own
 * `Outcome.of`/`Outcome.ofFiles` (`tson-cli`'s `Outcome.java`).
 */
import { describe, expect, it } from 'vitest';
import type { Diagnostic } from '@ltr8/tson';
import { outcomeOfDiagnostics, outcomeOfFiles } from '../src/outcome.js';

function diagnostic(code: Diagnostic['code']): Diagnostic {
  return { code, message: 'x' };
}

describe('outcomeOfDiagnostics', () => {
  it('is VALID when nothing was reported', () => {
    expect(outcomeOfDiagnostics([])).toBe('VALID');
  });

  it('is INVALID when every diagnostic is a verdict', () => {
    expect(outcomeOfDiagnostics([diagnostic('TYPE_MISMATCH')])).toBe('INVALID');
    expect(outcomeOfDiagnostics([diagnostic('TYPE_MISMATCH'), diagnostic('FIELD_REQUIRED')])).toBe(
      'INVALID',
    );
  });

  it('is INVALID for a §8.2 name-hygiene refusal -- a verdict, not a validity call', () => {
    expect(outcomeOfDiagnostics([diagnostic('CONFUSABLE_NAMES')])).toBe('INVALID');
    expect(outcomeOfDiagnostics([diagnostic('RESTRICTED_CHARACTER')])).toBe('INVALID');
    expect(outcomeOfDiagnostics([diagnostic('RESTRICTED_SCRIPT')])).toBe('INVALID');
  });

  it('is NOT_CHECKED when a non-verdict code is present alone', () => {
    expect(outcomeOfDiagnostics([diagnostic('NOT_IMPLEMENTED')])).toBe('NOT_CHECKED');
    expect(outcomeOfDiagnostics([diagnostic('BIND_MISMATCH')])).toBe('NOT_CHECKED');
    expect(outcomeOfDiagnostics([diagnostic('SCHEMA_NOT_FOUND')])).toBe('NOT_CHECKED');
    expect(outcomeOfDiagnostics([diagnostic('SCHEMA_UNREACHABLE')])).toBe('NOT_CHECKED');
  });

  it('is NOT_CHECKED when a non-verdict code sits beside real verdicts -- one is enough', () => {
    expect(outcomeOfDiagnostics([diagnostic('TYPE_MISMATCH'), diagnostic('NOT_IMPLEMENTED')])).toBe(
      'NOT_CHECKED',
    );
  });
});

describe('outcomeOfFiles', () => {
  it('is VALID when every file is VALID', () => {
    expect(outcomeOfFiles(['VALID', 'VALID'])).toBe('VALID');
    expect(outcomeOfFiles([])).toBe('VALID');
  });

  it('is INVALID when at least one file is INVALID and none is NOT_CHECKED', () => {
    expect(outcomeOfFiles(['VALID', 'INVALID'])).toBe('INVALID');
    expect(outcomeOfFiles(['INVALID', 'INVALID'])).toBe('INVALID');
  });

  it('is NOT_CHECKED when any file is NOT_CHECKED, even beside a VALID/INVALID one -- a run is no better than its parts', () => {
    expect(outcomeOfFiles(['VALID', 'NOT_CHECKED'])).toBe('NOT_CHECKED');
    expect(outcomeOfFiles(['INVALID', 'NOT_CHECKED'])).toBe('NOT_CHECKED');
    expect(outcomeOfFiles(['NOT_CHECKED'])).toBe('NOT_CHECKED');
  });
});
