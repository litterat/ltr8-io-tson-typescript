/**
 * `exit.ts`'s ladder, `70 > 78 > 69 > 1 > 75`: who must act first ([TSON-DATA] §8.1's two outcomes
 * beside the four categories, and the reference implementation's `TsonCli.exitCodeFor`).
 */
import { describe, expect, it } from 'vitest';
import type { Diagnostic } from '@ltr8/tson';
import { EXIT, exitCodeFor } from '../src/exit.js';

function diagnostics(...codes: Diagnostic['code'][]): Diagnostic[] {
  return codes.map((code) => ({ code, message: 'x' }));
}

describe('exitCodeFor', () => {
  it('a library gap outranks everything, and a missing binding everything else', () => {
    expect(exitCodeFor(diagnostics('TYPE_MISMATCH', 'NOT_IMPLEMENTED', 'BIND_MISMATCH'))).toBe(
      EXIT.FAULT,
    );
    expect(exitCodeFor(diagnostics('SCHEMA_NOT_FOUND', 'BIND_MISMATCH'))).toBe(EXIT.CONFIG);
  });

  it('a schema this run will not supply, or cannot find, is 69 whatever else is reported', () => {
    expect(exitCodeFor(diagnostics('SCHEMA_NOT_PERMITTED'))).toBe(EXIT.SCHEMA_UNAVAILABLE);
    expect(exitCodeFor(diagnostics('TYPE_MISMATCH', 'SCHEMA_TOO_LARGE'))).toBe(
      EXIT.SCHEMA_UNAVAILABLE,
    );
    expect(exitCodeFor(diagnostics('SCHEMA_NOT_FOUND', 'SCHEMA_TIMEOUT'))).toBe(
      EXIT.SCHEMA_UNAVAILABLE,
    );
  });

  it('an origin that did not answer is 75 only when it is all that went wrong', () => {
    expect(exitCodeFor(diagnostics('SCHEMA_UNREACHABLE', 'SCHEMA_TIMEOUT'))).toBe(
      EXIT.SCHEMA_TEMPFAIL,
    );
    // Beside a rejection a rerun reaches the same rejection, so the sender acts first.
    expect(exitCodeFor(diagnostics('TYPE_MISMATCH', 'SCHEMA_UNREACHABLE'))).toBe(EXIT.INVALID);
    expect(exitCodeFor(diagnostics('RESTRICTED_SCRIPT', 'SCHEMA_TIMEOUT'))).toBe(EXIT.INVALID);
  });

  it('a verdict or a refusal alone is 1', () => {
    expect(exitCodeFor(diagnostics('TYPE_MISMATCH'))).toBe(EXIT.INVALID);
    expect(exitCodeFor(diagnostics('LIMIT_REFUSED'))).toBe(EXIT.INVALID);
  });
});
