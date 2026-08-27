/**
 * Conformance-harness bridge from the real {@link resolveBaseType} (`base/baseTypeResolver.ts`) to
 * the suite's own resolver-sidecar shapes (`schemas/resolver-sidecar.tn`). A resolver-layer
 * subject is always a single bare token as the whole document (see the suite's own README, "Valid
 * resolver-layer vectors"), so this module parses it with the real Tier 3 parser to recover that
 * token's decoded text and form, then hands it to base type resolution -- exactly the parse-then-
 * resolve pipeline `dataParser.ts`'s own doc comment describes higher layers as composing.
 */

import { resolveBaseType } from '../../packages/tson/src/base/baseTypeResolver.js';
import type { NumberForm } from '../../packages/tson/src/base/numberGrammar.js';
import { parseDocument } from '../../packages/tson/src/compiler/dataParser.js';
import { TsonInternalError } from '../../packages/tson/src/core/errors.js';
import { fromBytes, runSync } from '../../packages/tson/src/io/bytes.js';
import type { ExpectedBaseValue, ExpectedNumberForm } from './sidecar.js';

/**
 * Resolves `subject`'s single bare token per §4. §4 itself never rejects a token (every unquoted
 * token that isn't null/boolean/a number falls through to string, §4.4), so this only throws for a
 * malformed document (a lexer/parser failure) or a subject that isn't a bare token at all -- the
 * latter is a vector-authoring error this harness surfaces loudly rather than silently misreading.
 */
export function resolveBaseValue(subject: Uint8Array): ExpectedBaseValue {
  const { document } = runSync(parseDocument(fromBytes(subject)));
  const core = document.root.coreValue;
  if (core.kind !== 'token') {
    throw new TsonInternalError(
      `resolver-layer vector's subject must be a single bare token, got core-value kind '${core.kind}'`,
    );
  }
  const resolved = resolveBaseType({ text: core.text, form: core.form });
  switch (resolved.kind) {
    case 'null':
      return { kind: 'null' };
    case 'boolean':
      return { kind: 'boolean', value: resolved.value };
    case 'string':
      return { kind: 'string', text: resolved.text };
    case 'number':
      return { kind: 'number', form: toExpectedNumberForm(resolved.form) };
  }
}

function toExpectedNumberForm(form: NumberForm): ExpectedNumberForm {
  switch (form.kind) {
    case 'integer':
      return {
        shape: 'integer',
        ...(form.sign !== undefined ? { sign: form.sign } : {}),
        digits: form.digits,
      };
    case 'based-integer':
      return {
        shape: 'based-integer',
        ...(form.sign !== undefined ? { sign: form.sign } : {}),
        radix: form.radix,
        digits: form.digits,
      };
    case 'float':
      return {
        shape: 'float',
        ...(form.sign !== undefined ? { sign: form.sign } : {}),
        ...(form.integerPart !== undefined ? { integerPart: form.integerPart } : {}),
        ...(form.fractionDigits !== undefined ? { fractionDigits: form.fractionDigits } : {}),
        ...(form.exponent !== undefined
          ? {
              exponent: {
                ...(form.exponent.sign !== undefined ? { sign: form.exponent.sign } : {}),
                digits: form.exponent.digits,
              },
            }
          : {}),
      };
    case 'special-value':
      return {
        shape: 'special-value',
        ...(form.sign !== undefined ? { sign: form.sign } : {}),
        kind: form.special,
      };
  }
}
