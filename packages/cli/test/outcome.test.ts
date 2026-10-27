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
  it('is ACCEPTED when nothing was reported', () => {
    expect(outcomeOfDiagnostics([])).toBe('ACCEPTED');
  });

  it('is REJECTED when every diagnostic is a verdict', () => {
    expect(outcomeOfDiagnostics([diagnostic('TYPE_MISMATCH')])).toBe('REJECTED');
    expect(outcomeOfDiagnostics([diagnostic('TYPE_MISMATCH'), diagnostic('FIELD_REQUIRED')])).toBe(
      'REJECTED',
    );
  });

  it('is REJECTED for a refusal -- Part 1 §8.1: declined by this processor, a rejection here', () => {
    expect(outcomeOfDiagnostics([diagnostic('CONFUSABLE_NAMES')])).toBe('REJECTED');
    expect(outcomeOfDiagnostics([diagnostic('RESTRICTED_CHARACTER')])).toBe('REJECTED');
    expect(outcomeOfDiagnostics([diagnostic('RESTRICTED_SCRIPT')])).toBe('REJECTED');
    expect(outcomeOfDiagnostics([diagnostic('LIMIT_REFUSED')])).toBe('REJECTED');
    expect(outcomeOfDiagnostics([diagnostic('SCHEMA_NOT_PERMITTED')])).toBe('REJECTED');
    expect(outcomeOfDiagnostics([diagnostic('SCHEMA_TOO_LARGE')])).toBe('REJECTED');
  });

  it('is UNDETERMINED when only what could not be judged was reported (Part 1 §8.1)', () => {
    expect(outcomeOfDiagnostics([diagnostic('NOT_IMPLEMENTED')])).toBe('UNDETERMINED');
    expect(outcomeOfDiagnostics([diagnostic('BIND_MISMATCH')])).toBe('UNDETERMINED');
    expect(outcomeOfDiagnostics([diagnostic('SCHEMA_NOT_FOUND')])).toBe('UNDETERMINED');
    expect(outcomeOfDiagnostics([diagnostic('SCHEMA_UNREACHABLE')])).toBe('UNDETERMINED');
    expect(outcomeOfDiagnostics([diagnostic('SCHEMA_TIMEOUT')])).toBe('UNDETERMINED');
  });

  it('is REJECTED when a rejection sits beside what went unjudged -- one rejection is enough', () => {
    expect(outcomeOfDiagnostics([diagnostic('TYPE_MISMATCH'), diagnostic('NOT_IMPLEMENTED')])).toBe(
      'REJECTED',
    );
  });
});

describe('outcomeOfFiles', () => {
  it('is ACCEPTED when every file is ACCEPTED', () => {
    expect(outcomeOfFiles(['ACCEPTED', 'ACCEPTED'])).toBe('ACCEPTED');
    expect(outcomeOfFiles([])).toBe('ACCEPTED');
  });

  it('is REJECTED when any file is REJECTED, whatever else the run holds', () => {
    expect(outcomeOfFiles(['ACCEPTED', 'REJECTED'])).toBe('REJECTED');
    expect(outcomeOfFiles(['UNDETERMINED', 'REJECTED'])).toBe('REJECTED');
  });

  it('is UNDETERMINED when no file is REJECTED and one is UNDETERMINED', () => {
    expect(outcomeOfFiles(['ACCEPTED', 'UNDETERMINED'])).toBe('UNDETERMINED');
    expect(outcomeOfFiles(['UNDETERMINED'])).toBe('UNDETERMINED');
  });
});
