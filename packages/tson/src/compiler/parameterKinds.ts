/**
 * §5.10's two parameter kinds, inferred by use: a parameter standing at a `type_ref`-typed slot is
 * a `TYPE` parameter, one standing in a slot whose declared type resolves to an {@link Atom}
 * (`identifier`, `value`, or any enum) is a `VALUE` parameter, and one standing anywhere else is a
 * resolver error at the declaration.
 *
 * **The slot's declared type is what says which, read generically rather than from a table of
 * kernel names.** A held body is the constructor application as written, so the body alone cannot
 * tell a parameter naming a type from one standing for an enum member — both are bare tokens.
 * What separates them is the constructor's own vocabulary (`array.element_type` is typed
 * `type_ref`, `enum.members` a set of `identifier`, `record_field.value` typed `value`), read
 * through `meta` — §9 makes a type-reference slot MUST be typed `type_ref`, so an extension
 * meta-schema's own constructors classify by the same walk with nothing added here.
 *
 * **A parameter riding another template's argument list** (`box<T>`'s `T`) says nothing on its
 * own — meta-kernel's own `type_argument` puts a parameter of *either* kind on the reference
 * channel — so it is recorded as a {@link Deferred} dependency and settled by a fixed point over
 * the whole open-entry set ({@link settle}, this module's own `inferAll`), because the callee
 * (`box`) may not have classified its own parameter yet.
 *
 * **A parameter grounded only by mutual template recursion** (`loop => <T> loop<T>`) is forced to
 * `TYPE` once the fixed point leaves it undetermined, rather than reported as an error: being a
 * value parameter means standing in a scalar slot of some held body, and a parameter with no
 * concrete use anywhere in its cycle cannot be one. That is a deliberate divergence from §5.10's
 * own error text for this one case.
 *
 * **A parameter standing where neither a reference nor a scalar is declared** — `<T> !enum {
 * members: T }`, a parameter standing for a whole record/collection/choice — is refused at the
 * declaration, not deferred to application time. So is a parameter used as both a type and a
 * value parameter across its occurrences.
 */
import { TsonInternalError, TsonSchemaValidationError } from '../core/errors.js';
import type { ArrayValue, CoreValue, RecordValue } from '../ast/value.js';
import type { RecordBody } from '../schema/meta/bodies.js';
import type { Top, TypeDefinition, TypeRef } from '../schema/meta/typedef.js';
import type { HeldBody } from './heldBody.js';
import type { DefinitionGetter } from './resolverTypes.js';
import { ARGUMENTS, NAME, VALUE, field } from './wireForm.js';

/** What a parameter's occurrences make it (§5.10). */
export type Kind = 'TYPE' | 'VALUE';

/** The kernel entry every type-reference slot is typed by (§9). */
const TYPE_REF = 'type_ref';

/**
 * Every kernel/core body shape §5.10 treats as scalar: {@link Unit} (`value`/`token`/`void`), an
 * enum (`boolean` and every user-declared `!enum`), and one member per `*_type` constructor (§9).
 * A `Product`/`Sum`/`Reference`/held body, or a meta-layer `Data` extension body, is never a
 * scalar for this purpose, whatever its own `kind` happens to spell.
 */
const ATOM_KINDS: ReadonlySet<string> = new Set([
  'unit',
  'enum',
  'integer_type',
  'float_type',
  'decimal_type',
  'rational_type',
  'complex_type',
  'date_type',
  'time_type',
  'datetime_type',
  'duration_type',
  'text_type',
  'binary',
  'regex_type',
  'uri_type',
  'email_type',
  'uuid_type',
  'ipv4_type',
  'ipv6_type',
  'cidr4_type',
  'cidr6_type',
  'mac_type',
]);

function isAtomBody(top: Top): boolean {
  return 'kind' in top && typeof top.kind === 'string' && ATOM_KINDS.has(top.kind);
}

function isRecordBody(top: Top): top is RecordBody {
  return 'fields' in top;
}

function isHeldBody(body: Top): body is HeldBody {
  return 'application' in body;
}

/** `name`'s resolved body, `!reference` chains followed — the slot type a written value faces. */
function resolveSlot(name: string, meta: DefinitionGetter): Top | undefined {
  let definition: TypeDefinition | undefined = meta(name);
  let hops = 0;
  while (definition !== undefined && 'target' in definition.body && hops < 32) {
    definition = meta(definition.body.target.name);
    hops += 1;
  }
  return definition?.body;
}

// ── One declaration's occurrences ───────────────────────────────────────────────────────────

/** One parameter riding another template's argument list, whose kind that template's parameter fixes. */
interface Deferred {
  readonly parameter: string;
  readonly head: string;
  readonly index: number;
}

/** What one declaration's occurrences have made of its parameters so far. */
interface Occurrences {
  readonly parameters: readonly string[];
  readonly kinds: Map<string, Kind>;
  readonly deferred: Deferred[];
  conflict?: TsonSchemaValidationError;
}

function createOccurrences(parameters: readonly string[]): Occurrences {
  return { parameters, kinds: new Map(), deferred: [] };
}

function declares(occurrences: Occurrences, name: string): boolean {
  return occurrences.parameters.includes(name);
}

/** Records one occurrence's verdict, returning whether it added anything. */
function observe(occurrences: Occurrences, parameter: string, kind: Kind): boolean {
  const previous = occurrences.kinds.get(parameter);
  if (previous === undefined) {
    occurrences.kinds.set(parameter, kind);
    return true;
  }
  if (previous !== kind && occurrences.conflict === undefined) {
    occurrences.conflict = new TsonSchemaValidationError(
      `parameter '${parameter}' stands in both a type position and a value position, so no argument can ` +
        'satisfy both -- §5.10 gives a parameter one kind, inferred from where it is used',
    );
  }
  return false;
}

/**
 * A parameter the fixed point left undetermined is a **type** parameter, forced rather than
 * chosen: being a value parameter means standing in a scalar slot of some held body, and a slot
 * is exactly what grounds a parameter. `loop => <T> loop<T>` is the case that cannot be written
 * any other way — a reference template's body *is* the application, so there is no second slot to
 * put a concrete use in.
 */
function groundRemainingAsType(occurrences: Occurrences): void {
  for (const parameter of occurrences.parameters) {
    if (occurrences.deferred.length > 0 && !occurrences.kinds.has(parameter)) {
      occurrences.kinds.set(parameter, 'TYPE');
    }
  }
}

// ── The walk ─────────────────────────────────────────────────────────────────────────────────

interface WalkContext {
  readonly occurrences: Occurrences;
  readonly meta: DefinitionGetter;
}

/** One held body walked against the vocabulary of the constructor it applies. */
function walkBody(held: HeldBody, ctx: WalkContext): void {
  const head = held.application.typeRef;
  const wire = held.application.coreValue;
  if (head === undefined || wire.kind !== 'record') {
    return; // not a constructor application -- nothing here classifies
  }
  const vocabulary = resolveSlot(head, ctx.meta);
  if (vocabulary !== undefined && isRecordBody(vocabulary)) {
    walkRecord(wire, vocabulary, ctx);
  }
}

/** Each written slot walked against the field the constructor declares for it. */
function walkRecord(wire: RecordValue, vocabulary: RecordBody, ctx: WalkContext): void {
  for (const written of wire.fields) {
    const slotField = vocabulary.fields.find((f) => f.name === written.name);
    if (slotField !== undefined) {
      walkValue(written.value.value.coreValue, slotField.type, ctx);
    }
  }
}

/** One written value against the type its slot declares. */
function walkValue(written: CoreValue, declared: TypeRef, ctx: WalkContext): void {
  const slot = declared.name;
  const type = resolveSlot(slot, ctx.meta);
  if (written.kind === 'token' && declares(ctx.occurrences, written.text)) {
    walkToken(written.text, slot, type, ctx);
    return;
  }
  if (written.kind === 'array') {
    walkElements(written, type, ctx);
    return;
  }
  if (written.kind === 'record') {
    if (slot === TYPE_REF) {
      walkApplication(written, ctx);
      return;
    }
    if (type !== undefined && isRecordBody(type)) {
      walkRecord(written, type, ctx);
    }
  }
}

/** A parameter standing at a slot: the slot's declared type is the whole of the verdict. */
function walkToken(parameter: string, slot: string, type: Top | undefined, ctx: WalkContext): void {
  if (slot === TYPE_REF) {
    observe(ctx.occurrences, parameter, 'TYPE');
  } else if (type !== undefined && isAtomBody(type)) {
    observe(ctx.occurrences, parameter, 'VALUE');
  } else {
    throw new TsonSchemaValidationError(
      `parameter '${parameter}' stands where '${slot}' is declared, which is neither a type reference nor a ` +
        'scalar -- §5.10 binds a value parameter to scalars only and a type parameter to references, so ' +
        'nothing could be applied here',
    );
  }
}

function walkElements(array: ArrayValue, type: Top | undefined, ctx: WalkContext): void {
  if (type !== undefined && 'elementType' in type) {
    for (const element of array.elements) {
      walkValue(element.value.coreValue, type.elementType, ctx);
    }
    return;
  }
  if (type !== undefined && 'elements' in type) {
    const positions = type.elements;
    array.elements.forEach((element, i) => {
      const position = positions[Math.min(i, positions.length - 1)];
      if (position !== undefined) {
        walkValue(element.value.coreValue, position.elementType, ctx);
      }
    });
    return;
  }
  // not a collection slot -- a shape error the constructor's own reader reports
}

/**
 * A slot typed `type_ref` holding an application rather than a bare name. The head is a type
 * name; each argument that names a parameter of this declaration is *deferred*, since
 * meta-kernel's `type_argument` puts a parameter of either kind on the reference channel.
 *
 * Read through `wireForm.ts`'s own {@link field}/`NAME`/`ARGUMENTS`, not by matching those wire
 * names here — what an application looks like on the wire is one module's answer, and a walk
 * that re-derives it is a second opinion waiting to disagree.
 */
function walkApplication(application: RecordValue, ctx: WalkContext): void {
  const nameValue = field(application, NAME);
  const head = nameValue?.kind === 'token' ? nameValue.text : undefined;
  const argumentsValue = field(application, ARGUMENTS);
  if (head === undefined || argumentsValue?.kind !== 'array') {
    return;
  }
  argumentsValue.elements.forEach((element, index) => {
    walkArgument(element.value.coreValue, head, index, ctx);
  });
}

/** One `type_argument`: a bare parameter name under `name` defers, everything else does not. */
function walkArgument(argument: CoreValue, head: string, index: number, ctx: WalkContext): void {
  if (argument.kind !== 'record') {
    return;
  }
  for (const member of argument.fields) {
    const memberValue = member.value.value.coreValue;
    if (member.name === VALUE) {
      continue; // a literal argument says nothing about this declaration's parameters
    }
    if (memberValue.kind === 'token' && declares(ctx.occurrences, memberValue.text)) {
      ctx.occurrences.deferred.push({ parameter: memberValue.text, head, index });
    } else if (memberValue.kind === 'record') {
      walkApplication(memberValue, ctx); // a nested application: `box<inner<T>>`
    }
  }
}

// ── Public surface ───────────────────────────────────────────────────────────────────────────

/** Where a declaration whose parameters will not classify is reported, entry by entry. */
export interface ParameterKindsFailureReporter {
  report(entryName: string, error: TsonSchemaValidationError): void;
}

/**
 * Every open entry's parameter kinds, by entry name then parameter name.
 *
 * `entries` is the **whole namespace**, imports included, because a local template may route a
 * parameter into an imported one and take its kind from there. `declared` is the subset this
 * schema wrote, and the only names a failure is reported against: an imported entry resolved in
 * its own schema, and reporting it here would put one document's verdict on another's
 * declaration.
 */
export function inferAll(
  entries: ReadonlyMap<string, TypeDefinition>,
  declared: ReadonlySet<string>,
  meta: DefinitionGetter,
  reporter: ParameterKindsFailureReporter,
): ReadonlyMap<string, ReadonlyMap<string, Kind>> {
  const observed = new Map<string, Occurrences>();
  for (const [name, definition] of entries) {
    if (definition.parameters.length === 0 || !isHeldBody(definition.body)) {
      continue;
    }
    const occurrences = createOccurrences(definition.parameters);
    try {
      walkBody(definition.body, { occurrences, meta });
    } catch (e: unknown) {
      if (!(e instanceof TsonSchemaValidationError)) {
        throw e;
      }
      if (declared.has(name)) {
        reporter.report(name, e);
      }
      continue;
    }
    observed.set(name, occurrences);
  }
  return settle(observed, entries, declared, reporter);
}

/**
 * One template's kinds from its own body alone, for a caller with no batch pass behind it.
 *
 * {@link inferAll} runs once every declaration has resolved, which is after resolution has
 * already closed some applications on demand — a composition supertype and a refinement source
 * have to absorb the closed entry's fields and cannot wait for the batch. Those closings ask for
 * this instead: the template in hand has resolved, so its own occurrences classify, and only a
 * parameter needing the cross-template fixed point is left undetermined. A body that will not
 * classify yields nothing here and is reported by the batch pass, which is the one that knows
 * which declarations this schema wrote.
 */
export function inferOne(
  template: TypeDefinition,
  meta: DefinitionGetter,
): ReadonlyMap<string, Kind> {
  if (template.parameters.length === 0 || !isHeldBody(template.body)) {
    return new Map();
  }
  const occurrences = createOccurrences(template.parameters);
  try {
    walkBody(template.body, { occurrences, meta });
  } catch (e: unknown) {
    if (e instanceof TsonSchemaValidationError) {
      return new Map();
    }
    throw e;
  }
  return occurrences.conflict === undefined ? occurrences.kinds : new Map();
}

/**
 * Deferred occurrences resolved against the kinds already known, until nothing moves. A parameter
 * riding `box<T>`'s argument list takes `box`'s own parameter kind at that position, and `box`
 * may itself be waiting on this one — §5.10 anticipates the cycle and calls a parameter grounded
 * only by it an error; this pass leaves it undetermined instead ({@link groundRemainingAsType}),
 * which is the conservative half of that rule.
 */
function settle(
  observed: Map<string, Occurrences>,
  entries: ReadonlyMap<string, TypeDefinition>,
  declared: ReadonlySet<string>,
  reporter: ParameterKindsFailureReporter,
): ReadonlyMap<string, ReadonlyMap<string, Kind>> {
  let moved = true;
  while (moved) {
    moved = false;
    for (const occurrences of observed.values()) {
      for (const deferred of occurrences.deferred) {
        const callee = observed.get(deferred.head);
        if (callee === undefined) {
          continue;
        }
        const calleeDefinition = entries.get(deferred.head);
        if (calleeDefinition === undefined) {
          throw new TsonInternalError(
            `parameterKinds.settle: '${deferred.head}' has observed occurrences but no namespace entry`,
          );
        }
        const calleeParameter = calleeDefinition.parameters[deferred.index];
        if (calleeParameter === undefined) {
          continue; // an arity error, which the materialiser reports where it is applied
        }
        const kind = callee.kinds.get(calleeParameter);
        if (kind !== undefined && observe(occurrences, deferred.parameter, kind)) {
          moved = true;
        }
      }
    }
  }
  for (const occurrences of observed.values()) {
    groundRemainingAsType(occurrences);
  }
  const result = new Map<string, ReadonlyMap<string, Kind>>();
  for (const [name, occurrences] of observed) {
    if (occurrences.conflict !== undefined) {
      if (declared.has(name)) {
        reporter.report(name, occurrences.conflict);
      }
      continue;
    }
    result.set(name, occurrences.kinds);
  }
  return result;
}
