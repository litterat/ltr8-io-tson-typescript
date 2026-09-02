/**
 * §5.10's substitution walk over a held body — the one piece of the reference implementation's
 * `TemplateMaterialiser` this work package needs, because `definitionResolver.ts`'s own
 * `openOperand` (absorbing a supertype/refinement-source that is itself an application of *this*
 * declaration's own type parameter, e.g. `vip<T> => customer & box<T>`) has to substitute the
 * absorbed operand's parameters with the arguments as written before it can read the result as a
 * field set to absorb.
 *
 * The rest of §5.10 materialisation — closing a fully-bound application to the entry it denotes,
 * cycle detection, the whole-schema pass — lives in `templates.ts`, which imports {@link
 * substitute} from here rather than duplicating it: the walk has exactly one correct spelling,
 * the same one `wireForm.ts`'s own `heldRecord`/`isApplication`/`typeRefOf` agree on.
 */
import { TsonNotImplementedError } from '../core/errors.js';
import type { ArrayValue, CoreValue, DataValue, RecordValue, ScopedValue } from '../ast/value.js';
import type { TypeArgument } from '../schema/meta/typedef.js';
import { NAME, VALUE, refValue, rescope, tokenValue } from './wireForm.js';
import { lexerFormOfMeta } from './tokenForms.js';

/** One argument in the held spelling, standing where the parameter it binds stood — see {@link substitute}'s own note on why the reference case must go through `wireForm.ts`'s own `refValue`. */
function argumentValue(argument: TypeArgument): CoreValue {
  if (argument.kind === 'ref') {
    return refValue(argument.ref);
  }
  return tokenValue(argument.value.text, lexerFormOfMeta(argument.value.form));
}

function argumentFor(
  parameter: string,
  head: string,
  bindings: ReadonlyMap<string, TypeArgument>,
): TypeArgument {
  const argument = bindings.get(parameter);
  if (argument === undefined) {
    // A parameter of an enclosing template, still open: this application is not the one that
    // closes it. Nothing today reaches here — an application is closed only once every argument
    // is concrete — and saying so is what keeps that true rather than assuming it.
    throw new TsonNotImplementedError(
      `'${head}<...>' holds the parameter '${parameter}', which this application does not supply, ` +
        'and closing an open form onto another open form is not implemented (§5.10)',
    );
  }
  return argument;
}

/**
 * One field of a held record, with `type_ref`'s own `name`/`value` split honoured: a `name`
 * member bound to a value argument is that argument's literal on the `value` member, because
 * §8.1 tells a reference argument from a literal one by which member carries it.
 */
function substituteField(
  field: { readonly name: string; readonly value: ScopedValue },
  head: string,
  parameters: readonly string[],
  bindings: ReadonlyMap<string, TypeArgument>,
): { readonly name: string; readonly value: ScopedValue } {
  const held = field.value.value.coreValue;
  if (
    field.name === NAME &&
    held.kind === 'token' &&
    held.form === 'unquoted' &&
    parameters.includes(held.text)
  ) {
    const argument = argumentFor(held.text, head, bindings);
    if (argument.kind === 'value') {
      return { name: VALUE, value: rescope(field.value, argumentValue(argument)) };
    }
  }
  return {
    name: field.name,
    value: rescope(field.value, substitute(held, head, parameters, bindings)),
  };
}

/**
 * The held body with every token naming one of the template's parameters replaced by the
 * argument applied for it — at any depth, in a value slot, a type slot, an argument list, or
 * inside a collection alike.
 *
 * A held token needs no channel label: the body is uninterpreted until this substitution
 * finishes, so §8.1's shadowing rule decides it — a token that resolves into `parameters` is a
 * parameter, and anything else is what it looks like. The one place the channel still shows is
 * inside a `type_ref` record, whose `name` member takes a reference: a parameter there bound to a
 * literal moves to the `value` member, since an argument list distinguishes the two by which
 * member holds it — {@link substituteField} is exactly that one exception.
 */
export function substitute(
  value: CoreValue,
  head: string,
  parameters: readonly string[],
  bindings: ReadonlyMap<string, TypeArgument>,
): CoreValue {
  switch (value.kind) {
    case 'token':
      if (value.form === 'unquoted' && parameters.includes(value.text)) {
        return argumentValue(argumentFor(value.text, head, bindings));
      }
      return value;
    case 'array': {
      const array: ArrayValue = {
        kind: 'array',
        elements: value.elements.map((element) =>
          rescope(element, substitute(element.value.coreValue, head, parameters, bindings)),
        ),
      };
      return array;
    }
    case 'record': {
      const record: RecordValue = {
        kind: 'record',
        fields: value.fields.map((field) => substituteField(field, head, parameters, bindings)),
      };
      return record;
    }
    case 'map':
    case 'empty-brace':
    case 'absent':
      return value;
  }
}

/** Substitutes a whole held `DataValue`'s own core value, keeping its annotations and type-ref. */
export function substituteApplication(
  application: DataValue,
  head: string,
  parameters: readonly string[],
  bindings: ReadonlyMap<string, TypeArgument>,
): DataValue {
  return {
    ...application,
    coreValue: substitute(application.coreValue, head, parameters, bindings),
  };
}
