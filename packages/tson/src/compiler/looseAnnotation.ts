/**
 * An annotation's value read with no type to read it against (§6): the token's own base type under
 * [TSON-DATA] §4's three classes -- a boolean, a number kept exact where it is an integer, or a string.
 * The reading of last resort, for an annotation whose type this resolution holds no compiled reader for: a
 * type the document declares itself, whose readers do not exist until the document has resolved. A value
 * that is no token, and a bare annotation, hold nothing here (§6).
 *
 * It is the value the annotation carries into resolved output, so it is the one a writer can spell back:
 * `string`, `boolean` or `bigint`, never a tree node.
 */
import type { DataValue } from '../ast/value.js';
import { resolveBaseType } from '../base/baseTypeResolver.js';
import { toExactInteger } from '../base/numberNarrowing.js';

/** `argument`'s value as a plain host value, `undefined` where it holds none. */
export function looseAnnotationValue(argument: DataValue | undefined): unknown {
  if (argument === undefined) return undefined;
  const core = argument.coreValue;
  if (core.kind !== 'token') return undefined;
  const base = resolveBaseType(core);
  switch (base.kind) {
    case 'boolean':
      return base.value;
    case 'string':
      return base.text;
    case 'number':
      return base.form.kind === 'integer' || base.form.kind === 'based-integer'
        ? toExactInteger(base.form)
        : core.text;
  }
}
