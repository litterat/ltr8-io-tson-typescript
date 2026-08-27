/**
 * Part 2 §5.2's field-state table: a field's presence marker (`?`) and value modifier (`~`/`=`)
 * decide its resolved `FieldState` and what value, if any, rides with it. The table is closed and
 * consults nothing but the two marks the author wrote, which is why it can be answered before a
 * field's type is even known.
 *
 * Consulted by `definitionResolver.ts`'s own `resolveFieldEntry` when it resolves a closed record
 * body; the reference implementation's `SchemaDesugarer` asks the identical question when it
 * rewrites a record template's body into the `!record { ... }` form §5.2 says it denotes, so the
 * two agree on all six spellings — this port's `desugar.ts` does the equivalent rewrite inline
 * (see its own `resolveFieldModifiers`) rather than sharing this exact function, since the
 * desugarer runs on unresolved AST tokens while this one runs on an already-resolved `FieldState`
 * axis; both are transcribed from this one table and must be kept in step by hand if the table
 * ever changes.
 */
import { TsonSchemaValidationError } from '../core/errors.js';
import type { FieldModifier } from '../ast/schema/fields.js';
import type { TokenValue } from '../ast/value.js';
import type { FieldState } from '../schema/meta/bodies.js';

/**
 * What §5.2 makes of one field's marks. `value` is absent for the two states that carry none —
 * plain `REQUIRED`/`OPTIONAL`, and `OPTIONAL_FIXED`'s `= _` spelling, whose output encoding is a
 * `record_field` with no `value` member (§8.1).
 *
 * A token naming a type parameter rides `value` like any other (§5.7's "Open modifiers"); nothing
 * here labels it as one — §8.1's shadowing rule (a token is a parameter exactly when its text
 * resolves into the enclosing entry's own `parameters`) is what tells the two apart wherever the
 * question is asked. What a parametric modifier *does* decide is the `state` beside it, which is
 * exactly what {@link resolveFieldModifiers} decides below.
 */
export interface ResolvedFieldModifiers {
  readonly state: FieldState;
  readonly value?: TokenValue;
}

/**
 * §5.2's table for one field. `optional` is the presence axis — the entry's own `?`, or (for a
 * tightening entry that restates only a modifier) the state it inherits. `parameters` is the
 * enclosing declaration's type-parameter list, empty outside a template.
 *
 * @throws TsonSchemaValidationError for the three spellings §5.2 rules out: `~ _` on any field,
 *   `= _` on a required one, and a default on an optional one.
 */
export function resolveFieldModifiers(
  fieldName: string,
  optional: boolean,
  modifier: FieldModifier | undefined,
  parameters: readonly string[],
): ResolvedFieldModifiers {
  if (modifier === undefined) {
    return { state: optional ? 'OPTIONAL' : 'REQUIRED' };
  }
  const fixed = modifier.kind === 'fixed';

  if (modifier.value.kind === 'absent') {
    // §5.2's sixth spelling, `field: type? = _`: OPTIONAL_FIXED carrying no value at all, so the
    // field MUST be omitted or written as `_`.
    if (!fixed) {
      throw new TsonSchemaValidationError(
        `field '${fieldName}' uses '~ _' -- a required field cannot fall back to not-being-filled, ` +
          "so an absent default is a resolver error on any field (§5.2). Write 'type?' for a field " +
          'that may be absent',
      );
    }
    if (!optional) {
      throw new TsonSchemaValidationError(
        `field '${fieldName}' fixes a required field to absent ('= _') -- a field cannot be both ` +
          `required and forbidden from being present (§5.2). Make it optional ('${fieldName}: type? = _') ` +
          'to forbid its value while keeping it in the contract',
      );
    }
    return { state: 'OPTIONAL_FIXED' };
  }

  const token = modifier.value.token;
  if (optional && !fixed) {
    throw new TsonSchemaValidationError(
      `field '${fieldName}' gives an optional field a default ('type? ~ value') -- a default implies ` +
        "the field is always present, which contradicts optional (§5.2). Use 'type ~ value' for a " +
        "fallback, 'type?' for absence, or 'type? = value' for present-implies-value",
    );
  }
  // §5.7's "Open modifiers": a parametric modifier lands in a REQUIRED-family state whatever the
  // presence axis says, because nothing is fixed at declaration -- the value arrives at
  // application, and every application MUST bind every parameter.
  if (parameters.includes(token.text)) {
    return { state: fixed ? 'REQUIRED' : 'REQUIRED_DEFAULT', value: token };
  }
  const state: FieldState = optional
    ? 'OPTIONAL_FIXED'
    : fixed
      ? 'REQUIRED_FIXED'
      : 'REQUIRED_DEFAULT';
  return { state, value: token };
}
