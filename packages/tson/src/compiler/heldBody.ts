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
 * the `!record { fields: [ ... ] }` §5.2 says it denotes, built here by {@link heldRecord}/
 * {@link heldEmptyRecord} and applied by `definitionResolver.ts`'s own `holdIfOpen` for the two
 * forms desugaring cannot rewrite in advance — a composition or refinement template, which has to
 * flatten its supertype's/source's fields against a namespace before there is anything to hold.
 *
 * **The spelling must not fork.** `desugar.ts`'s own record-template rewrite and this module's
 * `heldRecord` both have to produce byte-for-byte the same wire shape for the same logical body —
 * an unquoted token where a canonical writer would quote, a bare name where one would spell
 * `{ name: X  arguments: [] }` — because `names()`/`applications()` below and
 * `templateSubstitution.ts`'s own walk both key on a token being unquoted. `desugar.ts`'s own
 * `refValueOf` is the AST-layer half of that one spelling; {@link metaRefValue} below is this
 * module's own resolved-layer twin, over `schema/meta`'s already-resolved `TypeRef` — the shape a
 * composition/refinement template's fields arrive in by the time they are held (see
 * `heldRecord`'s own doc) — spelled identically by construction, not by sharing one function
 * across two different `TypeRef` types.
 */
import { TsonInternalError } from '../core/errors.js';
import type { CoreValue, DataValue, RecordValue, ScopedValue, TokenValue } from '../ast/value.js';
import type { TemplateBody } from '../schema/meta/bodies.js';
import type { RecordBody, FieldGroup } from '../schema/meta/bodies.js';
import type { TypeArgument, TypeRef } from '../schema/meta/typedef.js';
import { lexerFormOfMeta, metaFormOfLexer } from './tokenForms.js';

const NAME = 'name';
const ARGUMENTS = 'arguments';
const VALUE = 'value';
const FIELDS = 'fields';
const GROUPS = 'groups';
const MEMBERS = 'members';
const STATE = 'state';
const SUPERTYPES = 'supertypes';
const FIELD_NAME = 'name';
const TYPE = 'type';
const RECORD = 'record';

/** One field of a wire `RecordValue`, by name — `undefined` when absent. */
function fieldOf(record: RecordValue, name: string): CoreValue | undefined {
  return record.fields.find((f) => f.name === name)?.value.value.coreValue;
}

/**
 * `type_ref`'s record form is the one shape carrying both `name` and `arguments`; a bare name is
 * a token, and a `type_argument` carries `name` *or* `value` but never `arguments`.
 */
export function isApplication(record: RecordValue): boolean {
  return fieldOf(record, NAME) !== undefined && fieldOf(record, ARGUMENTS) !== undefined;
}

/** `{ name: head  arguments: [ ... ] }` back as the reference it spells. */
export function typeRefOf(record: RecordValue): TypeRef {
  const name = fieldOf(record, NAME);
  if (name === undefined) {
    throw new TsonInternalError("a type_ref record form always carries 'name'");
  }
  const head = name.kind === 'token' ? name.text : typeRefOf(name as RecordValue).name;
  const args: TypeArgument[] = [];
  const argumentsValue = fieldOf(record, ARGUMENTS);
  if (argumentsValue?.kind === 'array') {
    for (const element of argumentsValue.elements) {
      args.push(argumentOf(element.value.coreValue as RecordValue));
    }
  }
  return { name: head, arguments: args, annotations: [] };
}

/** One argument record: `value` carries a literal, `name` a reference, simple or compound. */
export function argumentOf(argument: RecordValue): TypeArgument {
  const literal = fieldOf(argument, VALUE);
  if (literal !== undefined) {
    const token = literal as TokenValue;
    return { kind: 'value', value: { text: token.text, form: metaFormOfLexer(token.form) } };
  }
  const name = fieldOf(argument, NAME);
  if (name === undefined) {
    throw new TsonInternalError("a type_argument record form always carries 'name' or 'value'");
  }
  const ref =
    name.kind === 'token'
      ? { name: name.text, arguments: [], annotations: [] }
      : typeRefOf(name as RecordValue);
  return { kind: 'ref', ref };
}

function scoped(value: CoreValue): { readonly value: DataValue } {
  return { value: { annotations: [], coreValue: value } };
}

function tokenValue(text: string, unquoted = true): TokenValue {
  return { kind: 'token', text, form: unquoted ? 'unquoted' : 'single-line' };
}

function nameField(
  name: string,
  text: string,
): { readonly name: string; readonly value: ReturnType<typeof scoped> } {
  return { name, value: scoped(tokenValue(text)) };
}

/**
 * A *resolved* `schema/meta` `TypeRef`, in the held spelling: a bare name when it carries no
 * arguments, or `type_ref`'s own record form when it does. The `arguments.length === 0` branch is
 * load-bearing, not an optimisation — a held body is read by later phases as wire form, and
 * `type_argument` is told from `type_ref` by which shape a slot carries, so stating a no-argument
 * reference in the record form would make the two indistinguishable and give one type two entry
 * names (a name derives from what is written). `templateSubstitution.ts`'s own `substitute` writes
 * a bound reference through this same function for exactly that reason.
 */
export function metaRefValue(ref: TypeRef): CoreValue {
  if (ref.arguments.length === 0) {
    return tokenValue(ref.name);
  }
  const args: ScopedValue[] = ref.arguments.map((argument) => {
    const member =
      argument.kind === 'ref'
        ? { name: NAME, value: scoped(metaRefValue(argument.ref)) }
        : {
            name: VALUE,
            value: scoped(tokenValue(argument.value.text, argument.value.form === 'UNQUOTED')),
          };
    return scoped({ kind: 'record', fields: [member] });
  });
  return {
    kind: 'record',
    fields: [
      nameField(NAME, ref.name),
      { name: ARGUMENTS, value: scoped({ kind: 'array', elements: args }) },
    ],
  };
}

/**
 * The held body an error placeholder carries — `!record { fields: [] }}`, the zero-field record
 * both absorbing stand-ins already stand for, held like every other open body.
 *
 * Keeps its declaration's own type parameters (the caller attaches those to the enclosing
 * `TypeDefinition`, not here) so "an open entry's body is held, or a `Reference`" has no
 * exceptions even for a declaration this phase gave up on.
 */
export function heldEmptyRecord(): DataValue {
  return {
    annotations: [],
    typeRef: RECORD,
    coreValue: {
      kind: 'record',
      fields: [{ name: FIELDS, value: scoped({ kind: 'array', elements: [] }) }],
    },
  };
}

/**
 * Unbinds one resolved annotation value back to wire form — the one leaf {@link heldRecord}
 * cannot do generically, since a bound annotation value's real host shape depends on the type its
 * name resolved against. The default handles the scalar shapes a schema-level constraint value
 * ever actually carries (a boolean, a bigint, a string, or an already-wire `Token`/`CoreValue`);
 * a caller with a richer binding layer in scope may supply a fuller one.
 */
export type AnnotationValueEncoder = (value: unknown) => DataValue;

export function defaultAnnotationValueEncoder(value: unknown): DataValue {
  if (value === null || value === undefined) {
    return { annotations: [], coreValue: { kind: 'absent' } };
  }
  if (typeof value === 'boolean' || typeof value === 'bigint' || typeof value === 'number') {
    return { annotations: [], coreValue: tokenValue(String(value)) };
  }
  if (typeof value === 'string') {
    return { annotations: [], coreValue: { kind: 'token', text: value, form: 'single-line' } };
  }
  if (typeof value === 'object' && 'kind' in value) {
    return { annotations: [], coreValue: value as CoreValue };
  }
  throw new TsonInternalError(
    `defaultAnnotationValueEncoder has no wire spelling for a bound annotation value of type ${typeof value}`,
  );
}

/**
 * The same `!record { ... }` held body, built from a body that is already resolved — the form a
 * composition or refinement template arrives in (§5.7, §5.8), since both absorb fields from a
 * source and so cannot be rewritten before there is a namespace to absorb from.
 *
 * `TsonObjectWriter`-shaped output cannot serve here (the Java original's own note, ported
 * structurally): a held body's own grammar is unquoted-token-as-parameter, and a canonical writer
 * quotes everything, which would make every parameter reference in the held body indistinguishable
 * from a literal.
 */
export function heldRecord(
  body: RecordBody,
  encodeAnnotation: AnnotationValueEncoder = defaultAnnotationValueEncoder,
): DataValue {
  const fields = body.fields.map((field) => {
    const members: { name: string; value: ReturnType<typeof scoped> }[] = [
      nameField(FIELD_NAME, field.name),
      { name: TYPE, value: scoped(metaRefValue(field.type)) },
    ];
    if (field.state !== 'REQUIRED') {
      members.push(nameField(STATE, field.state));
    }
    if (field.value !== undefined) {
      const form = lexerFormOfMeta(field.value.form);
      members.push({ name: VALUE, value: scoped({ kind: 'token', text: field.value.text, form }) });
    }
    return {
      value: {
        annotations: field.annotations.map((a) => ({
          name: a.name,
          ...(a.value === undefined ? {} : { value: encodeAnnotation(a.value) }),
        })),
        coreValue: { kind: 'record' as const, fields: members },
      },
    };
  });
  const groups = body.groups.map((group: FieldGroup) => {
    const members: { name: string; value: ReturnType<typeof scoped> }[] = [
      {
        name: MEMBERS,
        value: scoped({
          kind: 'array',
          elements: group.members.map((m) => scoped(tokenValue(m))),
        }),
      },
    ];
    if (group.state !== 'REQUIRED') {
      members.push(nameField(STATE, group.state));
    }
    return scoped({ kind: 'record', fields: members });
  });
  const binding: { name: string; value: ReturnType<typeof scoped> }[] = [];
  if (body.supertypes.length > 0) {
    binding.push({
      name: SUPERTYPES,
      value: scoped({
        kind: 'array',
        elements: body.supertypes.map((s: string) => scoped(tokenValue(s))),
      }),
    });
  }
  binding.push({ name: FIELDS, value: scoped({ kind: 'array', elements: fields }) });
  if (groups.length > 0) {
    binding.push({ name: GROUPS, value: scoped({ kind: 'array', elements: groups }) });
  }
  return { annotations: [], typeRef: RECORD, coreValue: { kind: 'record', fields: binding } };
}

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
