/**
 * Bridges `class2/validate/` vectors -- a data document read against a schema that has already
 * loaded, where [TSON-DATA] §8.1's `validation` category finally has vectors -- to this
 * implementation's real `Tson.validateDocument`.
 *
 * The subject is a complete document (RUNNER.md): its own header names the schemas it imports and its own root
 * `!type-ref` the type it is read as, so nothing about either is stated here -- the front door reads them, as
 * the Java reference's own `Class2ConformanceSuiteTest.checkValidateVector` has its tree reader do.
 */
import type { Diagnostic, DiagnosticCode } from '../../packages/tson/src/core/diagnostic.js';
import {
  diagnosticCodeForMechanism,
  isNameRefusal,
  isVerdict,
} from '../../packages/tson/src/core/diagnostic.js';

import { loadImports, newClass2Tson } from './class2Tson.js';
import type { Category, ValidateSidecar } from './sidecar.js';
import type { Class2Layer, Vector } from './vectors.js';

/** [TSON-DATA] §8.1's `validation` category. */
const VALIDATION_CODES: ReadonlySet<DiagnosticCode> = new Set([
  'FIELD_REQUIRED',
  'FIELD_FIXED',
  'FIELD_GROUP',
  'TYPE_MISMATCH',
  'WRONG_ARITY',
  'UNRECOGNIZED_FIELD',
  'ATOM_CONSTRAINT_VIOLATION',
  'VALIDATION_ERROR',
] satisfies DiagnosticCode[]);

/** §8.1's `resolver` category, as it can appear at this layer (a reference the governing schema does not declare, a structural document-level rule, or a token a built-in atom's grammar rejects outright, §5.2). */
const RESOLVER_CODES: ReadonlySet<DiagnosticCode> = new Set([
  'UNKNOWN_TYPE_REF',
  'UNKNOWN_TYPE',
  'DUPLICATE_MAP_KEY',
  'VOID_MAP_KEY',
  'DUPLICATE_FIELD',
  'SCHEMA_ERROR',
  'ATOM_FORM_INVALID',
  'SCOPE_NOT_ADMITTED',
] satisfies DiagnosticCode[]);

/**
 * `diagnostic`'s §8.1 category, per the mapping the Java reference implementation's own
 * `Class2ConformanceSuiteTest.categoryOf` states -- and, per RUNNER.md rule 3c, a hard failure
 * (never a quiet "no match") when the code is not a verdict at all, or is one of §8.2's refusal
 * codes, which §8.1 says MUST NOT be reported in any of the four categories.
 */
function categoryOf(vector: Vector<Class2Layer>, diagnostic: Diagnostic): Category {
  if (isNameRefusal(diagnostic.code)) {
    throw new Error(
      `${vector.name}: §8.2 name hygiene ('${diagnostic.code}') is a policy refusal, which §8.1 ` +
        `says MUST NOT be reported in any of the four categories: ${diagnostic.message}`,
    );
  }
  if (!isVerdict(diagnostic.code)) {
    throw new Error(
      `${vector.name}: RUNNER.md rule 3c -- '${diagnostic.code}' is not a verdict on the data ` +
        `(it says this could not be checked, not that it is invalid): ${diagnostic.message}`,
    );
  }
  if (VALIDATION_CODES.has(diagnostic.code)) return 'validation';
  if (RESOLVER_CODES.has(diagnostic.code)) return 'resolver';
  throw new Error(`${vector.name}: unclassified diagnostic code '${diagnostic.code}'`);
}

/**
 * A data document read the way the processor reads one ([TSON-DATA] §2.2), as the Java reference's own
 * `Class2ConformanceSuiteTest.checkValidateVector` does: through the front door, which reads the document's
 * header, obtains the schemas its `!!import`s name, merges them into one namespace (§2.2.3) and reads the root
 * value as the type its own root `!type-ref` names. Nothing about the schema or the root type is stated
 * outside the subject, which is a complete document (RUNNER.md).
 */
export async function checkValidateVector(
  vector: Vector<Class2Layer>,
  subject: Uint8Array,
  sidecar: ValidateSidecar,
): Promise<void> {
  const tson = newClass2Tson();
  await loadImports(tson, subject);
  const result = tson.validateDocument(subject);

  switch (sidecar.outcome) {
    case 'refused': {
      // RUNNER.md rule 3d: both halves -- something was refused, under the mechanism the vector
      // names, and nothing was also reported under one of §8.1's four categories.
      if (sidecar.refused === undefined) {
        throw new Error(
          `${vector.name}: a 'refused' class2/validate vector must declare its mechanism`,
        );
      }
      const expected = diagnosticCodeForMechanism(sidecar.refused.mechanism);
      if (!result.diagnostics.some((d) => d.code === expected)) {
        throw new Error(
          `${vector.name}: expected a ${expected} refusal; got ` +
            (result.diagnostics.length === 0
              ? 'no diagnostics'
              : result.diagnostics.map((d) => d.code).join(', ')),
        );
      }
      const categorised = result.diagnostics.filter((d) => isVerdict(d.code));
      if (categorised.length > 0) {
        throw new Error(
          `${vector.name}: a refusal must not also be reported in one of §8.1's four categories; ` +
            `got ${categorised.map((d) => `${d.code} ${d.message}`).join('; ')}`,
        );
      }
      return;
    }
    case 'valid':
      if (result.diagnostics.length !== 0) {
        throw new Error(
          `${vector.name}: expected a clean read, got ${String(result.diagnostics.length)} diagnostic(s): ` +
            result.diagnostics.map((d) => `${d.code} ${d.message}`).join('; '),
        );
      }
      return;
    case 'error': {
      if (result.diagnostics.length === 0) {
        throw new Error(`${vector.name}: the document is invalid, but nothing was reported`);
      }
      const category = sidecar.category;
      if (category === undefined) {
        throw new Error(`${vector.name}: an 'error' outcome vector must declare a category`);
      }
      const matched = result.diagnostics.some(
        (d) =>
          categoryOf(vector, d) === category &&
          (sidecar.path === undefined || d.path === sidecar.path),
      );
      if (!matched) {
        throw new Error(
          `${vector.name}: no diagnostic is a ${category} error` +
            (sidecar.path === undefined ? '' : ` at path '${sidecar.path}'`) +
            `; got ${result.diagnostics.map((d) => `${d.code}${d.path === undefined ? '' : ` (${d.path})`}`).join(', ')}`,
        );
      }
      return;
    }
  }
}
