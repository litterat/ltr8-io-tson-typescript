/**
 * `HeldBody` — the one implementation of `schema/meta`'s own `TemplateBody` (§5.10): a
 * constructor application, still in wire form, standing as the body of the template that
 * declares it, unread until `templateSubstitution.ts` substitutes its parameters away.
 *
 * `schema/meta/bodies.ts`'s own doc says this outright: "declared here but implemented
 * elsewhere... exactly one class implements this interface, and it lives outside `schema/meta`".
 * This module is that implementation.
 *
 * **Every held body is an application, so a `DataValue` carries all of them.** A sugar form
 * already is one, by the desugar table (`desugar.ts`). A bare record body becomes one too: it is
 * the `!record { fields: [ ... ] }` §5.2 says it denotes, built by `wireForm.ts`'s own
 * `heldRecord`/`heldEmptyRecord` and applied by `definitionResolver.ts`'s own `holdIfOpen` for the
 * two forms desugaring cannot rewrite in advance — a composition or refinement template, which has
 * to flatten its supertype's/source's fields against a namespace before there is anything to hold.
 *
 * The wire vocabulary and the shape of an application (`isApplication`/`typeRefOf`) are
 * `wireForm.ts`'s own concern, shared with every other phase that writes or reads one — see that
 * module's own doc for why one spelling matters. This module is left with what only it answers:
 * the two `TemplateBody` questions a held, unresolved body can answer without being resolved.
 */
import type { CoreValue, DataValue } from '../ast/value.js';
import type { TemplateBody } from '../schema/meta/bodies.js';
import type { TypeRef } from '../schema/meta/typedef.js';
import { isApplication, typeRefOf } from './wireForm.js';

/**
 * Wraps a held application (§5.10) as the `TemplateBody` `schema/meta` declares the seat for —
 * `application` is `HeldBody`'s own accessor in the Java original; here it is a plain property, so
 * a caller (`definitionResolver.ts`'s own `openOperand`) reads `held.application` directly with no
 * separate accessor call.
 *
 * The two `TemplateBody` methods answer the only two questions a held, unresolved body can answer
 * without being resolved — see `schema/meta/bodies.ts`'s own doc on each.
 */
export interface HeldBody extends TemplateBody {
  readonly application: DataValue;
}

export function createHeldBody(application: DataValue): HeldBody {
  return {
    application,
    names(): ReadonlySet<string> {
      const names = new Set<string>();
      collectNames(application.coreValue, names);
      return names;
    },
    applications(): readonly TypeRef[] {
      const applications: TypeRef[] = [];
      collectApplications(application.coreValue, applications);
      return applications;
    },
  };
}

function collectNames(value: CoreValue, into: Set<string>): void {
  switch (value.kind) {
    case 'token':
      if (value.form === 'unquoted') into.add(value.text);
      return;
    case 'array':
      for (const element of value.elements) collectNames(element.value.coreValue, into);
      return;
    case 'record':
      for (const field of value.fields) collectNames(field.value.value.coreValue, into);
      return;
    case 'map':
    case 'empty-brace':
    case 'absent':
      return;
  }
}

/**
 * Every `type_ref` record form the held tree holds. Does **not** descend into one it finds: an
 * application's own arguments come back inside the `TypeRef` it yields, and a caller that cares
 * about nesting walks those — descending here too would report each nested application twice.
 */
function collectApplications(value: CoreValue, into: TypeRef[]): void {
  switch (value.kind) {
    case 'record':
      if (isApplication(value)) {
        into.push(typeRefOf(value));
        return;
      }
      for (const field of value.fields) collectApplications(field.value.value.coreValue, into);
      return;
    case 'array':
      for (const element of value.elements) collectApplications(element.value.coreValue, into);
      return;
    case 'token':
    case 'map':
    case 'empty-brace':
    case 'absent':
      return;
  }
}
