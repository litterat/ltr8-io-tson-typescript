/**
 * Bridges `class2/validate/` vectors -- a data document read against a schema that has already
 * loaded, where [TSON-DATA] §8.1's `validation` category finally has vectors -- to this
 * implementation's real `Tson.validate`.
 *
 * The subject is self-describing at the root: its own root value carries a `!type-ref` naming its
 * type (`class2Tson.ts`'s fresh registry has the schema compiled), which this port's own
 * `readTree`/`validate` do not infer from a document's own header (`facade/tree.ts`'s
 * `SchemaGovernedReadOptions` always takes an explicit `root`) -- so the root type name is read
 * off the parsed subject's own {@link DataValue.typeRef} rather than assumed.
 */
import { canonicalizeIdentity } from '../../packages/tson/src/link/identity.js';
import { fromBytes, runSync } from '../../packages/tson/src/io/bytes.js';
import { parseDocument } from '../../packages/tson/src/compiler/dataParser.js';
import type { Diagnostic, DiagnosticCode } from '../../packages/tson/src/core/diagnostic.js';
import { isVerdict } from '../../packages/tson/src/core/diagnostic.js';

import { resolveBundledSchemaId } from './bundled-ids.js';
import { newClass2Tson } from './class2Tson.js';
import type { Category, ValidateSidecar } from './sidecar.js';
import type { Class2Layer, Vector } from './vectors.js';

/** [TSON-DATA] §8.1's `validation` category. */
const VALIDATION_CODES: ReadonlySet<DiagnosticCode> = new Set([
  'FIELD_REQUIRED',
  'FIELD_FIXED',
  'TYPE_MISMATCH',
  'WRONG_ARITY',
  'UNRECOGNIZED_FIELD',
  'ATOM_CONSTRAINT_VIOLATION',
  'VALIDATION_ERROR',
] satisfies DiagnosticCode[]);

/** §8.1's `resolver` category, as it can appear at this layer (a reference the governing schema does not declare, a structural document-level rule). */
const RESOLVER_CODES: ReadonlySet<DiagnosticCode> = new Set([
  'UNKNOWN_TYPE_REF',
  'UNKNOWN_TYPE',
  'DUPLICATE_MAP_KEY',
  'ABSENT_MAP_KEY',
  'DUPLICATE_FIELD',
  'SCHEMA_ERROR',
] satisfies DiagnosticCode[]);

/** §8.2's three name-hygiene codes -- never one of §8.1's four categories (RUNNER.md rule 3d). */
const REFUSAL_CODES: ReadonlySet<DiagnosticCode> = new Set([
  'CONFUSABLE_NAMES',
  'RESTRICTED_CHARACTER',
  'RESTRICTED_SCRIPT',
] satisfies DiagnosticCode[]);

/**
 * `diagnostic`'s §8.1 category, per the mapping the Java reference implementation's own
 * `Class2ConformanceSuiteTest.categoryOf` states -- and, per RUNNER.md rule 3c, a hard failure
 * (never a quiet "no match") when the code is not a verdict at all, or is one of §8.2's refusal
 * codes, which §8.1 says MUST NOT be reported in any of the four categories.
 */
function categoryOf(vector: Vector<Class2Layer>, diagnostic: Diagnostic): Category {
  if (!isVerdict(diagnostic.code)) {
    throw new Error(
      `${vector.name}: RUNNER.md rule 3c -- '${diagnostic.code}' is not a verdict on the data ` +
        `(it says this could not be checked, not that it is invalid): ${diagnostic.message}`,
    );
  }
  if (REFUSAL_CODES.has(diagnostic.code)) {
    throw new Error(
      `${vector.name}: §8.2 name hygiene ('${diagnostic.code}') is a policy refusal, which §8.1 ` +
        `says MUST NOT be reported in any of the four categories: ${diagnostic.message}`,
    );
  }
  if (VALIDATION_CODES.has(diagnostic.code)) return 'validation';
  if (RESOLVER_CODES.has(diagnostic.code)) return 'resolver';
  throw new Error(`${vector.name}: unclassified diagnostic code '${diagnostic.code}'`);
}

/** The root value's own declared type -- what a self-describing document names itself as. */
function rootTypeOf(vector: Vector<Class2Layer>, subject: Uint8Array): string {
  const { document } = runSync(parseDocument(fromBytes(subject)));
  const typeRef = document.root.typeRef;
  if (typeRef === undefined) {
    throw new Error(
      `${vector.name}: a class2/validate subject's root value must carry its own !type-ref`,
    );
  }
  return typeRef;
}

export function checkValidateVector(
  vector: Vector<Class2Layer>,
  subject: Uint8Array,
  sidecar: ValidateSidecar,
): void {
  if (sidecar.schema === undefined) {
    throw new Error(`${vector.name}: a class2/validate vector must name its governing schema`);
  }
  const tson = newClass2Tson();
  const schemaId = resolveBundledSchemaId(sidecar.schema);
  const linked = tson.schemas.get(canonicalizeIdentity(schemaId));
  if (linked === undefined) {
    throw new Error(
      `${vector.name}: '${sidecar.schema}' (${schemaId}) is not registered on this Tson instance`,
    );
  }
  const compiled = tson.compile(linked);
  const root = rootTypeOf(vector, subject);
  const result = tson.validate(subject, { schema: compiled, root });

  switch (sidecar.outcome) {
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
