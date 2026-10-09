/**
 * Part 2 §5.2's field-marks table -- the single place that turns a field's two marks
 * (`optional`/`voidable`) and its modifier (`~`/`=`/`=?`) into the three facts
 * (`optional`/`voidable`/`role`) and the value a `schema.meta` `RecordField` carries. The table
 * is closed and consults nothing but the marks the author wrote (plus, for a template body's own
 * open modifiers, the enclosing declaration's parameter list), which is why it can be answered
 * before a field's type is even known.
 *
 * **One table, not two.** `desugar.ts` (building a template's held body from unresolved AST) and
 * `definitionResolver.ts` (resolving a closed record's own fields) both consult this function --
 * the Java reference has one, `FieldModifiers.of`
 * (`tson-compiler/.../resolver/FieldModifiers.java`), and a second, hand-kept copy is exactly how
 * the two drift.
 *
 * Consulted by `definitionResolver.ts`'s own `resolveFieldEntry` and by `desugar.ts`'s own
 * `recordFieldValue`.
 */
import { TsonSchemaValidationError } from '../core/errors.js';
import type { FieldModifier } from '../ast/schema/fields.js';
import type { TokenValue } from '../ast/value.js';
import type { FieldRole } from '../schema/meta/bodies.js';

/**
 * What §5.2 makes of one field's marks: the three independent facts a `RecordField` carries.
 * `value` is present exactly when `role` is not `FREE`. `selector` is `true` for `=?` -- the
 * discriminator a family's members pin (§5.2); every other field of this shape is then at its
 * bare `FREE`/unpinned defaults, `=?` taking no value of its own.
 *
 * A token naming a type parameter rides `value` like any other (§5.7's "Open modifiers"), and the
 * marks beside it are the author's exactly as beside a literal; nothing here labels the token as a
 * parameter -- §8.1's shadowing rule (a token is a parameter exactly when its text resolves into
 * the enclosing entry's own `parameters`) is what tells the two apart wherever the question is
 * asked.
 */
export interface ResolvedFieldMarks {
  readonly optional: boolean;
  readonly voidable: boolean;
  readonly role: FieldRole;
  readonly value?: TokenValue;
  readonly selector: boolean;
}

/**
 * §5.2's table for one field. `optional`/`voidable` are the two marks as written -- the entry's
 * own `?` on the name and on the type.
 *
 * @throws TsonSchemaValidationError for the four spellings §5.2 rules out: a default on an
 *   unmarked name (a parameter's value included, §5.7's "Open modifiers"), a pin on a voidable type, and the selector `=?` on a marked name or a voidable
 *   type. (A modifier on a `void`-typed field is a resolver error checked once the field's type
 *   is known, at the field's own resolution site -- this table does not see the type.)
 */
export function resolveFieldMarks(
  fieldName: string,
  optional: boolean,
  voidable: boolean,
  modifier: FieldModifier | undefined,
): ResolvedFieldMarks {
  if (modifier === undefined) {
    return { optional, voidable, role: 'FREE', selector: false };
  }
  if (modifier.kind === 'selector') {
    if (optional) {
      throw new TsonSchemaValidationError(
        `field '${fieldName}' writes the selector '=?' on a name that also carries '?' -- a marked ` +
          "name already answers its own omission question, and '=?' is refused there (§5.2). Write " +
          `'${fieldName}: type =?' on the unmarked name`,
      );
    }
    if (voidable) {
      throw new TsonSchemaValidationError(
        `field '${fieldName}' writes the selector '=?' on a voidable type -- a selector's declared ` +
          "type MUST be non-voidable (§5.2): '_' selects nothing, and the family's members are what " +
          'pin this field',
      );
    }
    return { optional, voidable, role: 'FREE', selector: true };
  }

  const fixed = modifier.kind === 'fixed';
  if (fixed && voidable) {
    throw new TsonSchemaValidationError(
      `field '${fieldName}' pins a voidable type ('type? = value') -- a pin names the only value ` +
        "the field admits, and '_' is not it: the '_' question is settled before the pin is " +
        "consulted (§5.2). Drop the type's '?', or spell \"may be omitted or _ and nothing else\" " +
        `as '${fieldName}: void?'`,
    );
  }
  const token = modifier.token;
  if (!optional && !fixed) {
    throw new TsonSchemaValidationError(
      `field '${fieldName}' gives a default to a key that is always written ('type ~ value') -- an ` +
        "unmarked name says the key is always written, and '~ value' is a value only omission can " +
        `reach (§5.2). Write '${fieldName}?: type ~ value'`,
    );
  }
  const role: FieldRole = fixed ? 'FIXED' : 'DEFAULT';
  return { optional, voidable, role, value: token, selector: false };
}
