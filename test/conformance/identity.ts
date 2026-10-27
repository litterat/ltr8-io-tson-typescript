/**
 * Conformance-harness bridge for the identity layer (RUNNER.md rule 3e; the suite README's "The
 * identity layer"): [TSON-DATA] §2.2.1's canonical identity.
 *
 * The subject is a header and an empty body, and the vector is about the **first directive's
 * argument alone** -- nothing is fetched or resolved. A document's first directive is its `!!id`
 * when it has one, and otherwise its `!!schema`:
 *
 * - `!!id` is a document's own name, so it must already be written in canonical form
 *   (`validateIdentity`); a `valid` vector's `identity` is then the canonical identity of what it
 *   wrote.
 * - `!!schema` is a reference, read in any spelling of its identity (`canonicalizeIdentity`).
 *
 * A `valid` vector's `identity` is compared byte for byte with the one computed. An `error`
 * vector's category is `resolver` (§8.1): a reference that names no identity, or an `!!id` written
 * in another spelling, stops a schema loading, and the failure is the schema layer's however
 * value-like the rule. The subject is parsed with the real Tier 3 parser first, so a vector that
 * had accidentally become a parse error would fail here rather than pass for the wrong reason.
 */

import { expect } from 'vitest';

import { TsonSchemaValidationError } from '../../packages/tson/src/core/errors.js';
import { parseDocument } from '../../packages/tson/src/compiler/dataParser.js';
import { fromBytes, runSync } from '../../packages/tson/src/io/bytes.js';
import { canonicalizeIdentity, validateIdentity } from '../../packages/tson/src/link/identity.js';
import type { IdentitySidecar } from './sidecar.js';
import type { Vector } from './vectors.js';

/** The identity a subject's first directive names; throws when the directive is not a canonical `!!id` or names none. */
function identityOfFirstDirective(vector: Vector, subject: Uint8Array): string {
  const { document } = runSync(parseDocument(fromBytes(subject)));
  if (document.id !== undefined) {
    validateIdentity(document.id);
    return canonicalizeIdentity(document.id);
  }
  if (document.schema !== undefined) {
    return canonicalizeIdentity(document.schema);
  }
  throw new Error(`${vector.name}: an identity-layer subject must open with !!id or !!schema`);
}

/** Judges one identity-layer vector against its sidecar. */
export function checkIdentityVector(
  vector: Vector,
  subject: Uint8Array,
  sidecar: IdentitySidecar,
): void {
  if (sidecar.outcome === 'valid') {
    if (sidecar.identity === undefined) {
      throw new Error(`${vector.name}: a 'valid' identity-layer vector must state its identity`);
    }
    expect(identityOfFirstDirective(vector, subject)).toBe(sidecar.identity);
    return;
  }
  if (sidecar.category !== 'resolver') {
    throw new Error(
      `${vector.name}: an identity-layer error vector's category is 'resolver', got ` +
        `'${sidecar.category ?? 'none'}'`,
    );
  }
  // Parse cleanly first: the failure under test is the identity rule, not the document's syntax.
  runSync(parseDocument(fromBytes(subject)));
  expect(() => identityOfFirstDirective(vector, subject)).toThrow(TsonSchemaValidationError);
}
