/**
 * §8.2's merge pass: **one closed synthetic entry per distinct concrete form, schema-wide**,
 * whichever of the two lift channels produced each candidate.
 *
 * Both channels name a form by the same function of the same thing — the binding record with
 * every inner form already reduced to its entry name. `templates.ts`'s own materialisation always
 * satisfies that, closing applications before it names. `desugar.ts` satisfies it for a nested
 * *sugar* form, lifting innermost-first so the inner entry exists by the time the outer is named,
 * and cannot satisfy it for a nested *application*: `box<text>` has no entry until
 * materialisation. So a form lifted eagerly with an application in one of its slots is named from
 * an unreduced record, and `[box<text>]` written directly lands apart from `[box<T>]` closed with
 * `T := text` — two entries for one type, which is exactly what §8.2 requires this pass to
 * reconcile.
 *
 * **The closed-record name wins, never the eager one.** It is a function of the resolved form
 * alone, so two schemas reaching one form by different spellings agree on it — §8.2's determinism
 * SHOULD, and what lets an import merge unify rather than collide. Picking the eager name instead,
 * or the smaller of the two, would make an entry's name depend on which spellings happened to
 * appear beside it.
 *
 * **Only a form whose binding held an application moves.** Every other synthetic was already
 * named from a reduced record and re-derives to the name it has, so this pass is a no-op over
 * them — which is what keeps it from renaming the whole namespace on the strength of a rule it is
 * only enforcing at one edge.
 */
import { TsonNotImplementedError, TsonSchemaValidationError } from '../core/errors.js';
import type { CoreValue, RecordField } from '../ast/value.js';
import type { Declaration } from '../ast/schema/document.js';
import type { TypeDefinition, TypeRef } from '../schema/meta/typedef.js';
import { isApplication } from './wireForm.js';
import { mapBodyRefs, type TemplateMaterialiser } from './templates.js';

/**
 * The renames the pass calls for: each eagerly lifted form that re-derives to a different name,
 * mapped to that name. Empty — the ordinary case — when no lifted form held an application.
 *
 * `declarations` is the *desugared* document's, so a lifted name's declaration is the `!C value`
 * construction the phase injected and its binding record is recoverable from it. Open synthetics
 * are skipped: §8.2 gives them their own identity rule (structural equality of the held body up
 * to consistent renaming of parameters), and their bodies are held rather than closed.
 */
export function renames(
  declarations: ReadonlyMap<string, Declaration>,
  generated: ReadonlySet<string>,
  materialiser: TemplateMaterialiser,
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const name of generated) {
    const declaration = declarations.get(name);
    if (declaration?.typeDef.kind !== 'instance') {
      continue;
    }
    const instance = declaration.typeDef;
    if (instance.typeParams.length > 0) {
      continue;
    }
    const head = instance.value.typeRef;
    const binding = instance.value.coreValue;
    if (head === undefined || binding.kind !== 'record' || !holdsApplication(binding)) {
      continue;
    }
    const closed = closedName(materialiser, head, binding.fields);
    if (closed !== undefined && closed !== name) {
      result.set(name, closed);
    }
  }
  return result;
}

/**
 * Every reference in `entries` that names a merged form, rewritten in place to the name it merged
 * onto. Keys are left alone: which map an entry belongs in, and whether a renamed one moves or is
 * dropped because the other channel already published it, is `schemaResolver.ts`'s to decide — it
 * is the one holding both the local and the materialised map.
 */
export function rewrite(
  entries: Map<string, TypeDefinition>,
  renamed: ReadonlyMap<string, string>,
): void {
  for (const [key, definition] of entries) {
    entries.set(
      key,
      mapRefs(definition, (ref) => renameRef(ref, renamed)),
    );
  }
}

/** One type-ref rewritten, its own arguments included -- an application may name a merged form. */
function renameRef(ref: TypeRef, renamed: ReadonlyMap<string, string>): TypeRef {
  const to = renamed.get(ref.name);
  return to === undefined
    ? ref
    : { name: to, arguments: ref.arguments, annotations: ref.annotations };
}

/**
 * One definition with every reference it holds mapped -- `source` and whatever its body carries
 * alike. A local twin of `templates.ts`'s own (unexported) helper of the same shape: both walk
 * through that module's exported `mapBodyRefs`, so a body shape added there needs remembering in
 * exactly one place, not two.
 */
function mapRefs(definition: TypeDefinition, map: (ref: TypeRef) => TypeRef): TypeDefinition {
  return {
    ...definition,
    ...(definition.source === undefined ? {} : { source: map(definition.source) }),
    body: mapBodyRefs(definition.body, map),
  };
}

/**
 * The name the form takes with its applications closed, or `undefined` where closing cannot
 * answer. Materialisation has already closed every application in this entry's body, so this
 * reads its memo; a schema whose materialisation failed is one that is being reported anyway, and
 * a rename derived from a half-closed record would be a second, invented problem on top of the
 * real one.
 */
function closedName(
  materialiser: TemplateMaterialiser,
  head: string,
  fields: readonly RecordField[],
): string | undefined {
  try {
    return materialiser.closedFormName(head, fields);
  } catch (e: unknown) {
    if (e instanceof TsonSchemaValidationError || e instanceof TsonNotImplementedError) {
      return undefined;
    }
    throw e;
  }
}

/**
 * Whether any slot of the binding record holds an application -- `type_ref`'s record form, the
 * one shape `desugar.ts` writes for an application standing in a slot. Nested records and arrays
 * recurse, so `[[box<text>]]` and `(box<text> | int32)` are found alike.
 */
function holdsApplication(value: CoreValue): boolean {
  switch (value.kind) {
    case 'record':
      return (
        isApplication(value) || value.fields.some((f) => holdsApplication(f.value.value.coreValue))
      );
    case 'array':
      return value.elements.some((e) => holdsApplication(e.value.coreValue));
    case 'map':
    case 'empty-brace':
    case 'absent':
    case 'token':
      return false;
  }
}
