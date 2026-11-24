/**
 * Bridges `class2/schema/` vectors ([TSON-SCHEMA] §5's declaration forms, §8's resolved output)
 * to this implementation's real schema resolve/link pipeline (`Tson.resolveSchema`) -- the Class 2
 * counterpart of `lexer.ts`/`parser.ts`/`reader.ts`/`resolver.ts`/`vocabulary.ts`.
 *
 * **Driving the front door, not the pipeline stages** -- `class2Tson.ts`'s `newClass2Tson()`, a
 * fresh registry per vector, mirroring the reference implementation's own `Class2ConformanceSuiteTest`
 * top note on why: a Class 2 vector is about a phase boundary (did this schema resolve), which is
 * `Tson.resolveSchema`'s to own, not a test's to reassemble from lower-level calls.
 */
import { expect } from 'vitest';

import {
  TsonAtomParseError,
  TsonAtomValidationError,
  TsonBindMismatchError,
  TsonContentHashMismatchError,
  TsonLexError,
  TsonNameHygieneRefusedError,
  TsonNotImplementedError,
  TsonParseError,
  TsonReadError,
  TsonSchemaFetchError,
  TsonSchemaValidationError,
  TsonUnsupportedDocumentError,
} from '../../packages/tson/src/core/errors.js';
import {
  diagnosticCodeForFetch,
  isVerdict,
  type DiagnosticCode,
} from '../../packages/tson/src/core/diagnostic.js';
import { canonicalizeIdentity } from '../../packages/tson/src/link/identity.js';
import type { Tson } from '../../packages/tson/src/config.js';
import type { DefinitionGetter } from '../../packages/tson/src/compiler/resolverTypes.js';
import type { Top } from '../../packages/tson/src/schema/meta/typedef.js';

import { BUNDLED_SCHEMA_IDS } from './bundled-ids.js';
import { loadSchema, newClass2Tson } from './class2Tson.js';
import {
  markedApplications,
  markedCompletions,
  ourApplications,
  ourCompletions,
  ownEntries,
  readResolved,
  renderDefinition,
} from './resolvedForm.js';
import type { Category, ExpectedRefusal, SchemaSidecar } from './sidecar.js';
import type { Class2Layer, Vector } from './vectors.js';

const META_TN_ID = BUNDLED_SCHEMA_IDS['meta.tn'];

/** The pre-loaded kernel's entries on `tson`, which every schema is read under (§3.4). */
function kernelEntries(tson: Tson): ReadonlyMap<string, Top> {
  const kernel = tson.schemas.get(canonicalizeIdentity(META_TN_ID));
  if (kernel === undefined) throw new Error('the pre-loaded kernel is not registered');
  return kernel.entries;
}

/**
 * Whichever error `Tson.resolveSchema` threw, as the {@link DiagnosticCode} an equivalent
 * *collected* diagnostic would carry, so {@link assertSchemaOrLinkLoadFailed} can defer the actual
 * verdict/non-verdict judgement to the library's own {@link isVerdict} rather than keeping a
 * second copy of its `NON_VERDICT` set.
 *
 * `resolveSchema`/`linkSchema` throw plain exceptions rather than collecting `Diagnostic`s
 * (`config.ts`'s own design -- there is no `Tson.validateSchema` returning a list here), so there
 * is no code already attached to a thrown error to read off; this is the mapping from exception
 * class to the code the same failure would carry if it had come through a collecting read
 * instead, e.g. `packages/cli/src/problem.ts`'s own `isInvalidSchemaError` classifying the same
 * exception family for the same reason (there: usable schema vs. not; here: verdict vs. not).
 *
 * A `TsonNameHygieneRefusedError` is not this function's to classify -- {@link assertSchemaRefused}
 * handles it on its own path -- and anything unrecognised (`TsonInternalError` above all) is
 * rethrown: a bug in this runner or the library must fail the vector loudly, never be swallowed
 * into a conformance verdict.
 */
function schemaFailureCode(error: unknown): DiagnosticCode {
  if (error instanceof TsonNotImplementedError) return 'NOT_IMPLEMENTED';
  if (error instanceof TsonBindMismatchError) return 'BIND_MISMATCH';
  if (error instanceof TsonSchemaFetchError) return diagnosticCodeForFetch(error.reason);
  if (
    error instanceof TsonSchemaValidationError ||
    // [TSON-DATA] §2.2.1's integrity failure: the bytes a source returned are not the bytes the reference
    // pinned. A verdict on the reference, coded like the schema it names failing to load.
    error instanceof TsonContentHashMismatchError ||
    error instanceof TsonLexError ||
    error instanceof TsonParseError ||
    error instanceof TsonUnsupportedDocumentError ||
    error instanceof TsonAtomParseError ||
    error instanceof TsonAtomValidationError
  ) {
    // [TSON-DATA] §8.1: every error that makes a schema fail to load or ingest is a resolver
    // error "however value-like the violated rule". This port attaches no DiagnosticCode of its
    // own to a thrown schema-resolution error, so 'SCHEMA_ERROR' (already defined for "the
    // governing schema itself is invalid, unreachable, or failed to resolve") stands in -- all
    // that matters to isVerdict is that it is not one of the seven non-verdict codes.
    return 'SCHEMA_ERROR';
  }
  throw error;
}

/** Runs `action`, returning what it threw -- fails the vector (via `expect`) if it did not throw at all. */
async function catchThrow(
  vector: Vector<Class2Layer>,
  action: () => Promise<unknown>,
): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error(`${vector.name}: expected the schema to fail to load, but it resolved cleanly`);
}

/**
 * RUNNER.md rule 3b: a `class2/schema/` or `class2/link/` `error` vector always states `category:
 * resolver` -- checked here as a sanity assertion on the corpus itself, mirroring the Java
 * reference implementation's own `assertSchemaLoadFailed` -- and the category is never read off
 * whichever code the library happened to raise, only established from the phase (the schema
 * failed to load).
 *
 * Rule 3c: the thrown error must still be a *verdict* on the schema, not one of the reasons this
 * library could not judge it at all (a gap, an unreachable schema, a bind mismatch).
 */
export function assertSchemaOrLinkLoadFailed(
  vector: Vector<Class2Layer>,
  category: Category | undefined,
  error: unknown,
): void {
  if (category !== 'resolver') {
    throw new Error(
      `${vector.name}: RUNNER.md rule 3b -- a class2 schema/link 'error' vector always states ` +
        `category: resolver ([TSON-DATA] §8.1); found '${String(category)}'`,
    );
  }
  const code = schemaFailureCode(error);
  if (!isVerdict(code)) {
    throw new Error(
      `${vector.name}: RUNNER.md rule 3c -- '${code}' is not a verdict on the schema (it says ` +
        `this could not be judged, not that it is invalid): ${String(error)}`,
    );
  }
}

/**
 * RUNNER.md rule 3d, the schema-layer peer of `reader.ts`'s own `checkRefusedReaderVector`: assert
 * both that something was refused under the mechanism the vector names, and that nothing was also
 * reported as one of §8.1's four categories -- true structurally here too, since
 * {@link TsonNameHygieneRefusedError} extends the library's base error class directly, never any
 * of the four category families.
 */
export function assertSchemaRefused(
  vector: Vector<Class2Layer>,
  refused: ExpectedRefusal | undefined,
  error: unknown,
): void {
  if (refused === undefined) {
    throw new Error(`${vector.name}: a 'refused' class2/schema vector must declare its mechanism`);
  }
  expect(error).toBeInstanceOf(TsonNameHygieneRefusedError);
  const refusal = error as TsonNameHygieneRefusedError;
  expect(refusal.mechanism).toBe(refused.mechanism);
  expect(refusal).not.toBeInstanceOf(TsonSchemaValidationError);
  expect(refusal).not.toBeInstanceOf(TsonLexError);
  expect(refusal).not.toBeInstanceOf(TsonParseError);
  expect(refusal).not.toBeInstanceOf(TsonReadError);
  expect(refusal).not.toBeInstanceOf(TsonAtomParseError);
  expect(refusal).not.toBeInstanceOf(TsonAtomValidationError);
}

/**
 * A schema document, and what §8 says it resolves to.
 *
 * `valid`'s comparison never renders this implementation's own output to text: the sidecar's own
 * `resolved` text is read back through this implementation's own meta.tn-governed reader
 * (`resolvedForm.ts`'s `readResolved`) into the same `schema.meta` values the resolver itself
 * produces, and the two are compared structurally.
 */
export async function checkSchemaVector(
  vector: Vector<Class2Layer>,
  subject: Uint8Array,
  sidecar: SchemaSidecar,
): Promise<void> {
  const tson = newClass2Tson();
  switch (sidecar.outcome) {
    case 'valid': {
      const linked = await loadSchema(tson, subject);
      if (sidecar.resolved === undefined) {
        throw new Error(
          `${vector.name}: a 'valid' class2/schema vector must state its resolved output`,
        );
      }
      // The expected side is read under the subject's own imports, and under the pre-loaded kernel
      // alone when it has none (RUNNER.md, "A fixture schema's own records"): a constructor resolves
      // in the subject's own namespace, whose entries carry every import's.
      const lookup: DefinitionGetter = (name) =>
        linked.entries.get(name) ?? kernelEntries(tson).get(name);
      const ours = ownEntries(linked);
      const expected = readResolved(sidecar.resolved, lookup);
      expect(new Set(ours.keys())).toEqual(new Set(expected.keys()));
      for (const [name, expectedDefinition] of expected) {
        const ourDefinition = ours.get(name);
        if (ourDefinition === undefined) continue; // already reported by the keys assertion above
        expect(renderDefinition(ourDefinition)).toBe(renderDefinition(expectedDefinition));
      }
      // §8.1's key annotation is a claim of its own -- not part of any entry's value, so the
      // keys/body comparison above cannot make it: each declared completion states, on its key, the
      // incomplete entries it closed.
      expect(ourCompletions(linked)).toEqual(markedCompletions(sidecar.resolved));
      // Likewise `@meta.application`, on the key of each declared application (§8.2).
      expect(ourApplications(linked)).toEqual(markedApplications(sidecar.resolved));
      return;
    }
    case 'error': {
      const error = await catchThrow(vector, () => loadSchema(tson, subject));
      assertSchemaOrLinkLoadFailed(vector, sidecar.category, error);
      return;
    }
    case 'refused': {
      const error = await catchThrow(vector, () => loadSchema(tson, subject));
      assertSchemaRefused(vector, sidecar.refused, error);
      return;
    }
  }
}
