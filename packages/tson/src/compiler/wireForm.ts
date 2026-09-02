/**
 * How schema vocabulary is spelled as data, in both directions — the one place that knows what a
 * `type_ref` and a held `!record { ... }` look like on the wire, and the one that rewrites a
 * parameter standing inside one.
 *
 * **Why one module rather than a producer over here and a consumer over there.** A held body is
 * written by two phases and read by several: `desugar.ts` lifts a sugar form and
 * `definitionResolver.ts` holds a composition or refinement template; `templates.ts` closes one,
 * `heldBody.ts` answers §5.10's declaration-time questions about one. A second opinion about what
 * an application looks like is what makes one of those wrong — this project has already drifted
 * once, `desugar.ts` and `heldBody.ts` each hand-maintaining their own copy of the member-name
 * constants and the `isApplication`/`typeRefOf` pair.
 *
 * **Nothing here is canonical output.** A canonical writer is fully quoted, which is a different
 * language from the one a held body is written in: `HeldBody.names()` and
 * `templateSubstitution.ts`'s own `substitute` both key on a token being *unquoted*, so a quoted
 * body references no parameters at all. What is written here is what an author would have
 * written — an unquoted token where a canonical writer would quote, a bare name where it would
 * state `{ name: X  arguments: [] }`, and nothing at all where the constructor's own default says
 * it.
 *
 * **One spelling per shape is the requirement, not the tidiness.** An entry name derives from what
 * is written (`derivedName.ts`'s `ofBinding`/`ofApplication`), so a second spelling of one
 * reference splits one type across two entries. That is why {@link refValue} is what every
 * producer of a *resolved* `schema/meta` reference goes through, and why {@link typeRefOf} — its
 * inverse — lives beside it rather than in whichever phase happens to read.
 *
 * **What this module does not cover.** `desugar.ts` walks the *unresolved* AST
 * (`ast/schema/typeref.ts`'s own `TypeRef`, before resolution has run at all) and keeps its own
 * `refValueOf`/`refRecordOf` for that reason — the shape it produces is identical to
 * {@link refValue}'s by construction, but the input type is a different one this module has no
 * reason to know about.
 */
import { TsonInternalError } from '../core/errors.js';
import type {
  Annotation,
  CoreValue,
  DataValue,
  RecordField,
  RecordValue,
  ScopedValue,
  TokenValue,
} from '../ast/value.js';
import type { TokenForm } from '../lexer/token.js';
import type { FieldGroup, RecordBody } from '../schema/meta/bodies.js';
import type { TypeArgument, TypeRef } from '../schema/meta/typedef.js';
import { lexerFormOfMeta, metaFormOfLexer } from './tokenForms.js';

// ── The vocabulary's own member names ───────────────────────────────────────────────────────────

/**
 * The `name` member. One constant for the two records that spell it alike — `type_ref.name`,
 * carrying a reference, and `record_field.name`, carrying a field name. What tells an application
 * from anything else is never this member alone but its pairing with {@link ARGUMENTS}; see
 * {@link isApplication}.
 */
export const NAME = 'name';

/** `type_ref.arguments` — the second half of what makes a record an application. */
export const ARGUMENTS = 'arguments';

/** `record_field.value` and `type_argument.value`: §8.1's literal channel. */
export const VALUE = 'value';

/** The constructor a held record body carries. */
export const RECORD = 'record';

export const FIELDS = 'fields';
export const GROUPS = 'groups';
export const MEMBERS = 'members';
export const TYPE = 'type';
export const STATE = 'state';
export const SUPERTYPES = 'supertypes';

// ── Building blocks ──────────────────────────────────────────────────────────────────────────

/** A raw token in the wire's own unquoted-by-default spelling — quoted only where the caller says so. */
export function tokenValue(text: string, form: TokenForm = 'unquoted'): TokenValue {
  return { kind: 'token', text, form };
}

/**
 * A bare value in a field or element position — no schema directive, no annotations, no type-ref
 * of its own — or, given one, the same value carrying the annotations written on the construct it
 * stands for. §6 puts a field's own annotations on the resolved record, and a held body reaches
 * that through the wire value, so they travel here rather than being re-attached after the fact.
 */
export function scoped(value: CoreValue, annotations: readonly Annotation[] = []): ScopedValue {
  return { value: { annotations, coreValue: value } };
}

export function nameField(name: string, text: string): RecordField {
  return { name, value: scoped(tokenValue(text)) };
}

/** The same scoped value carrying a rewritten core value — annotations and type-ref kept as written. */
export function rescope(original: ScopedValue, rewritten: CoreValue): ScopedValue {
  return { ...original, value: { ...original.value, coreValue: rewritten } };
}

// ── Writing: a resolved value as the wire form it was written in ───────────────────────────────

/**
 * The held body an *error placeholder* carries — `!record { fields: [] }`, the zero-field record
 * both absorbing stand-ins already stood for, now held like every other open body.
 *
 * It exists so that "an open entry's body is held or a `Reference`" has no exceptions. A
 * placeholder keeps its declaration's type parameters on purpose (answering "how many?" with zero
 * sends a downstream `bl<text>` to fix the wrong declaration), which is what makes it the last
 * producer of a parameterised `RecordBody`.
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
 * Unbinds one resolved annotation value back to wire form — the one leaf {@link heldRecord} cannot
 * do generically, since a bound annotation value's real host shape depends on the type its name
 * resolved against. The default handles the scalar shapes a schema-level constraint value ever
 * actually carries (a boolean, a bigint, a string, or an already-wire `Token`/`CoreValue`); a
 * caller with a richer binding layer in scope may supply a fuller one.
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
 * The same `!record { ... }` held body, built from a body that is *already resolved* — the form a
 * composition or refinement template arrives in (§5.7, §5.8), since both absorb fields from a
 * source and so cannot be rewritten before there is a namespace to absorb from.
 *
 * **Two producers of the held wire form are fine; two spellings of it are not.** This one and
 * `desugar.ts`'s own record binding both go through {@link refValue} and {@link nameField}, which
 * is what makes them one spelling by construction rather than by two authors agreeing.
 *
 * A canonical writer's output cannot serve here: a held body's own grammar is
 * unquoted-token-as-parameter, and a canonical writer quotes everything, which would make every
 * parameter reference in the held body indistinguishable from a literal.
 */
export function heldRecord(
  body: RecordBody,
  encodeAnnotation: AnnotationValueEncoder = defaultAnnotationValueEncoder,
): DataValue {
  const fields = body.fields.map((f) => {
    const members: RecordField[] = [
      nameField(NAME, f.name),
      { name: TYPE, value: scoped(refValue(f.type)) },
    ];
    if (f.state !== 'REQUIRED') {
      members.push(nameField(STATE, f.state));
    }
    if (f.value !== undefined) {
      const form = lexerFormOfMeta(f.value.form);
      members.push({ name: VALUE, value: scoped({ kind: 'token', text: f.value.text, form }) });
    }
    return scoped(
      { kind: 'record' as const, fields: members },
      f.annotations.map((a) => ({
        name: a.name,
        ...(a.value === undefined ? {} : { value: encodeAnnotation(a.value) }),
      })),
    );
  });
  const groups = body.groups.map((group: FieldGroup) => {
    const members: RecordField[] = [
      {
        name: MEMBERS,
        value: scoped({ kind: 'array', elements: group.members.map((m) => scoped(tokenValue(m))) }),
      },
    ];
    if (group.state !== 'REQUIRED') {
      members.push(nameField(STATE, group.state));
    }
    return scoped({ kind: 'record', fields: members });
  });
  const binding: RecordField[] = [];
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
 * A *resolved* `schema/meta` {@link TypeRef} in the held spelling: a bare name, or `type_ref`'s
 * record form.
 *
 * **The `arguments.length === 0` branch is load-bearing, not an optimisation.** A held body is
 * read by later phases as wire form, and `type_argument` is told from `type_ref` by which shape a
 * slot carries — so stating a no-argument reference in the record form would make the two
 * indistinguishable to a walk that reads neither against a vocabulary, and would give one type two
 * entry names, since a name derives from what is written. That is why `templateSubstitution.ts`'s
 * own substitution writes a bound reference through this rather than spelling one of its own: the
 * open form needs one spelling however many phases produce it.
 */
export function refValue(ref: TypeRef): CoreValue {
  if (ref.arguments.length === 0) {
    return tokenValue(ref.name);
  }
  const args: ScopedValue[] = ref.arguments.map((argument) => {
    const member: RecordField =
      argument.kind === 'ref'
        ? { name: NAME, value: scoped(refValue(argument.ref)) }
        : {
            name: VALUE,
            value: scoped(tokenValue(argument.value.text, lexerFormOfMeta(argument.value.form))),
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

// ── Reading: the wire form back as the reference it spells ─────────────────────────────────────

/** One field of a wire `RecordValue`, by name — `undefined` when absent. */
export function field(record: RecordValue, name: string): CoreValue | undefined {
  return record.fields.find((f) => f.name === name)?.value.value.coreValue;
}

/**
 * `type_ref`'s record form is the one shape carrying both `name` and `arguments`; a bare name is a
 * token, and a `type_argument` carries `name` *or* `value` but never `arguments`. Shared so
 * `heldBody.ts` recognises an application by the same test that closes one — a held body is
 * written by one phase and read by several, and a second opinion about what an application looks
 * like is what makes one of them wrong.
 */
export function isApplication(record: RecordValue): boolean {
  return field(record, NAME) !== undefined && field(record, ARGUMENTS) !== undefined;
}

/** `{ name: head  arguments: [ ... ] }` back as the reference it spells. */
export function typeRefOf(record: RecordValue): TypeRef {
  const name = field(record, NAME);
  if (name === undefined) {
    throw new TsonInternalError("a type_ref record form always carries 'name'");
  }
  const head = name.kind === 'token' ? name.text : typeRefOf(name as RecordValue).name;
  const args: TypeArgument[] = [];
  const argumentsValue = field(record, ARGUMENTS);
  if (argumentsValue?.kind === 'array') {
    for (const element of argumentsValue.elements) {
      args.push(argumentOf(element.value.coreValue as RecordValue));
    }
  }
  return { name: head, arguments: args, annotations: [] };
}

/** One argument record: `value` carries a literal, `name` a reference, simple or compound. */
export function argumentOf(argument: RecordValue): TypeArgument {
  const literal = field(argument, VALUE);
  if (literal !== undefined) {
    const token = literal as TokenValue;
    return { kind: 'value', value: { text: token.text, form: metaFormOfLexer(token.form) } };
  }
  const name = field(argument, NAME);
  if (name === undefined) {
    throw new TsonInternalError("a type_argument record form always carries 'name' or 'value'");
  }
  const ref =
    name.kind === 'token'
      ? { name: name.text, arguments: [], annotations: [] }
      : typeRefOf(name as RecordValue);
  return { kind: 'ref', ref };
}
