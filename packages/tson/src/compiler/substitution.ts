/**
 * A parametric record's parameters substituted on the model ([TSON-SCHEMA] §5.10): each parameter reference in its
 * fields' types and its parents replaced by the argument bound to it, at any depth, and nothing else changed. A
 * parameter stands only at a slot of a field's type (`schema/meta/typeSlots.ts`) or as an argument of an application
 * there or in a parent, so those references are all substitution visits.
 *
 * **Two callers, one rule.** `parametricMaterialiser.ts` closes an application, where every argument is closed;
 * `definitionResolver.ts` absorbs an applied operand, where an argument may be one of the absorbing declaration's own
 * parameters, written as its name, which that declaration's record then holds as its parameter in turn.
 *
 * @module
 */
import { TsonInternalError } from '../core/errors.js';
import type { Namespace } from '../schema/meta/typedef.js';
import type { RecordBody, RecordField } from '../schema/meta/bodies.js';
import { mapFields } from '../schema/meta/bodies.js';
import type { TypeExpr, TypeRef } from '../schema/meta/typedef.js';
import { parentsOf } from '../schema/meta/typedef.js';
import * as TypeSlots from '../schema/meta/typeSlots.js';

/** Each parameter's argument, by parameter name. */
export type Bindings = ReadonlyMap<string, TypeRef>;

/**
 * `open`'s fields with `bindings` substituted at every slot of their types, at any depth of types written in place,
 * in order and with their key annotations.
 */
export function fields(open: RecordBody, bindings: Bindings): Namespace<RecordField> {
  const substitute = rewrite(bindings);
  return mapFields(open.fields, (field) => {
    const type = TypeSlots.map(field.type, substitute);
    return type === field.type ? field : { ...field, type };
  });
}

/** `open`'s parents as written, each substituted -- closing completes the chain from them. */
export function parents(open: RecordBody, bindings: Bindings): TypeExpr[] {
  const substitute = rewrite(bindings);
  return parentsOf(open).map((parent) => TypeSlots.map(parent, substitute));
}

/** `type` with `bindings` substituted at every slot. */
export function type(written: TypeExpr, bindings: Bindings): TypeExpr {
  return TypeSlots.map(written, rewrite(bindings));
}

/** `ref`, or its binding where it is a parameter. */
export function reference(ref: TypeRef, bindings: Bindings): TypeRef {
  if (ref.param !== true) return ref;
  const argument = bindings.get(ref.name);
  if (argument === undefined) {
    throw new TsonInternalError(
      `parameter '${ref.name}' has no argument -- arity is checked before a parametric record is substituted`,
    );
  }
  return argument;
}

function rewrite(bindings: Bindings): TypeSlots.Rewrite {
  return TypeSlots.names((ref) => reference(ref, bindings));
}
