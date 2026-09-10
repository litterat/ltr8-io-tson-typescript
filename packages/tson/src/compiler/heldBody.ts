/**
 * `HeldBody` — the one implementation of `schema/meta`'s own `TemplateBody` (§5.10): a
 * constructor application, still in wire form, standing as the body of the template that
 * declares it, unread until `templateSubstitution.ts` substitutes its parameters away.
 *
 * `schema/meta/bodies.ts`'s own doc says this outright: "declared here but implemented
 * elsewhere... exactly one class implements this interface, and it lives outside `schema/meta`".
 * This module is that implementation.
 *
 * **`TemplateBody` itself is now text** (§8.1: "the application is text... What is compared —
 * for identity, on ingest, and between two resolvers' outputs — is the parsed form of the text,
 * never the text"), so `parameters`/`template` alone satisfy the contract `schema/meta` declares
 * the seat for. `HeldBody` carries more than that contract requires: the live `application`
 * value beneath the text, and the two query methods ({@link HeldBody.names}/
 * {@link HeldBody.applications}) every caller in this module still asks of it. Parsing
 * `template` text back into a structured application belongs to a later work package's own held-
 * body cache; until it lands, this implementation keeps answering both questions the way it
 * always has — directly over the `DataValue` it was built from, never round-tripped through the
 * text — which is why `template` is written once, from the same value, and never read back here.
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
 * the two questions a held, unresolved body can answer without being resolved.
 */
import type { CoreValue, DataValue } from '../ast/value.js';
import type { TemplateBody } from '../schema/meta/bodies.js';
import type { TypeRef } from '../schema/meta/typedef.js';
import { writeDataValue } from '../write/astWriter.js';
import { isApplication, typeRefOf } from './wireForm.js';

/**
 * Wraps a held application (§5.10) as the `TemplateBody` `schema/meta` declares the seat for —
 * `application` is `HeldBody`'s own accessor in the Java original; here it is a plain property, so
 * a caller (`definitionResolver.ts`'s own `openOperand`) reads `held.application` directly with no
 * separate accessor call.
 *
 * `names()`/`applications()` answer the only two questions a held, unresolved body can answer
 * without being resolved: every unquoted name it mentions, at any depth (a declared parameter the
 * body never references is an author error, §5.10), and every type application it writes, at any
 * depth (a recursive application that does not pass its parameters through unchanged grows its
 * argument at every level, §5.10.1). Neither is part of `TemplateBody` itself — the
 * contract's own `template` field carries only text — so a caller that needs either narrows (or
 * casts, the way this module's own callers do) from `TemplateBody` to this richer type first.
 */
export interface HeldBody extends TemplateBody {
  readonly application: DataValue;
  names(): ReadonlySet<string>;
  applications(): readonly TypeRef[];
}

/**
 * Whether a resolved `TemplateBody` is this module's own `HeldBody` — true of every one that
 * exists, since this is the one implementation `schema/meta`'s own doc says lives "outside
 * `schema/meta`" (this module's own top note). Callers elsewhere in `compiler/`/`link/` that need
 * `application`/`names()`/`applications()` — none of which `TemplateBody` itself declares any
 * more — narrow with this first rather than assuming the cast is always safe.
 */
export function isHeldBody(body: TemplateBody): body is HeldBody {
  return 'application' in body;
}

/** `parameters`, named-parameter-first, in declaration order — `HeldBody`'s own contribution to `TemplateBody.parameters`. */
export function createHeldBody(application: DataValue, parameters: readonly string[]): HeldBody {
  return {
    application,
    parameters,
    template: writeDataValue(application),
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
      // A parameter stands wherever a token stands (this module's own top note), map keys and
      // values alike -- `extern_of => <S> !scoped { scope: [EXTERN] schemas: { S => _ } }` binds
      // `S` as a map key, never a field or element, so a walk that skipped this case would call
      // `extern_of` a declared-but-unused parameter (§5.10's own error, wrongly raised).
      for (const entry of value.entries) {
        collectNames(entry.key.coreValue, into);
        collectNames(entry.value.value.coreValue, into);
      }
      return;
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
    case 'map':
      // A map is exactly as legitimate a container to find a nested application inside as an
      // array or a record field is -- both the key and value side of each entry are walked.
      for (const entry of value.entries) {
        collectApplications(entry.key.coreValue, into);
        collectApplications(entry.value.value.coreValue, into);
      }
      return;
    case 'token':
    case 'empty-brace':
    case 'absent':
      return;
  }
}
