/**
 * §5.10's parameters, typed by use: each parameter of an open entry gets the type an argument for it
 * is read as (`template_param.type`), derived from the positions it stands in, and its kind follows
 * — a parameter is a `TYPE` parameter exactly when that type is `type_ref`.
 *
 * **The slot's declared type is what says which.** A held body is the constructor application as
 * written, so the body alone cannot tell a parameter naming a type from one standing for an enum
 * member — both are bare tokens. What separates them is the constructor's own vocabulary:
 * `array.element_type` is typed `type_ref`, `array.min_items` `non_negative_integer`,
 * `enum.members` a set of `text`. §9 makes that reading general rather than a table of kernel names
 * — a slot holding a type reference MUST be typed `type_ref` — so an extension meta-schema's own
 * constructors classify by the same walk with nothing added here.
 *
 * **Four sources of a use type**, and the last is why this is not one pass over one declaration:
 *
 * - a slot typed `type_ref` gives `type_ref`;
 * - a slot whose type resolves to an {@link Atom} gives that declared type;
 * - a **routed default or fixed value** — a parameter at `record_field.value` — gives the field's
 *   own declared type, read from the sibling `type` slot, and not `record_field.value`'s own type
 *   `value`, which says nothing. Where that field is typed by a parameter, the use type names the
 *   parameter (`<T, N> { w?: T ~ N }` gives `N` the type `T`);
 * - a parameter riding another template's argument list, where meta-kernel's own `type_argument` doc
 *   says a parameter of *either* kind travels on the reference channel. That occurrence says
 *   nothing on its own: the type comes from the callee's parameter at that position, so it is
 *   recorded as a dependency and settled by a fixed point over the whole open-entry set.
 *
 * Anything else — a parameter standing where a record, a collection or a choice is declared, as in
 * `<T> !enum { members: T }` — is refused here. §5.10 confines value parameters to scalars and type
 * parameters to references, so a parameter standing for a whole `enum_set` is neither, and refusing
 * it at the declaration is what turns "every application of this fails" into "this template is
 * wrong".
 *
 * **A written type narrows what the positions give** (`<T: text, N: int8>`), read by the kind they
 * give: on a value parameter it replaces `type`; on a type parameter it is the `bound`. This module
 * records both. What checks them — that a written type IS-A the derived one, that several uses
 * agree, that a bound is not wider than the one it inherits, and the call-site check — is the
 * resolver's, over the parameters recorded here.
 *
 * **An imported template is taken as recorded**, not walked again: its schema resolved it, and its
 * recorded parameters carry what its author wrote, which its held body does not.
 *
 * **A parameter the fixed point leaves ungrounded is a type parameter, and that is forced** — being
 * a value parameter *means* standing in a scalar slot, and a slot is what grounds a parameter.
 */
import { TsonSchemaValidationError } from '../core/errors.js';
import type { ArrayValue, CoreValue, MapValue, RecordValue } from '../ast/value.js';
import type { RecordBody, TemplateParam } from '../schema/meta/bodies.js';
import type { Top, TypeDefinition, TypeRef } from '../schema/meta/typedef.js';
import { isTemplateBody } from '../schema/meta/typedef.js';
import { isHeldBody, type HeldBody } from './heldBody.js';
import type { DefinitionGetter } from './resolverTypes.js';
import { ARGUMENTS, NAME, TYPE, VALUE, field, isApplication, typeRefOf } from './wireForm.js';

/** What a parameter's type makes it (§5.10). */
export type Kind = 'TYPE' | 'VALUE';

/** The kernel entry every type-reference slot is typed by (§9). */
const TYPE_REF_NAME = 'type_ref';

/** The unbounded type parameter's type. */
export const TYPE_REF: TypeRef = { name: TYPE_REF_NAME, arguments: [], annotations: [] };

/** The kernel record whose `value` slot routes a default or fixed value into its sibling's type. */
const RECORD_FIELD = 'record_field';

/** The kind a parameter's recorded type makes it. */
export function kindOf(type: TypeRef): Kind {
  return type.name === TYPE_REF_NAME && type.arguments.length === 0 ? 'TYPE' : 'VALUE';
}

/**
 * Whether `template`'s value parameters are the governing meta's types, read and checked in the
 * structure namespace (§5.10): a template whose body applies a meta constructor other than `record`
 * — `vec => <N> !array { element_type: text  min_items: N }` — binds its values into the meta's
 * own structure, so `N` is the meta's `non_negative_integer` whatever the schema declares under that
 * name, and a written narrowing names a type there too. A record template's fields are typed by the
 * schema, so its parameters read in the schema's namespace. A template whose body applies another
 * template takes that template's form. A type parameter's bound is the schema's either way.
 */
export function readsInStructure(
  template: TypeDefinition,
  entries: (name: string) => TypeDefinition | undefined,
): boolean {
  let current: TypeDefinition = template;
  for (let hop = 0; hop < 64; hop += 1) {
    const head = current.source?.name;
    if (head === undefined || head === 'record') return false;
    const applied = entries(head);
    if (applied === undefined || !isTemplateBody(applied.body)) return true;
    current = applied;
  }
  return false;
}

/** The type a slot's declared name resolves to: `!reference` chains followed — the slot type a written value faces. */
function resolveSlot(name: string, meta: DefinitionGetter): Top | undefined {
  let definition: TypeDefinition | undefined = meta(name);
  let hops = 0;
  while (definition !== undefined && 'target' in definition.body && hops < 32) {
    definition = meta(definition.body.target.name);
    hops += 1;
  }
  return definition?.body;
}

/** Every kernel/core body shape §5.10 treats as scalar; a product, sum, reference, held body or `Data` extension body never is. */
const ATOM_KINDS: ReadonlySet<string> = new Set([
  'value_type',
  'void_type',
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
  'period_type',
  'text_type',
  'identifier_type',
  'bytes_type',
  'regex_type',
  'uri_type',
  'iri_type',
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

// ── One declaration's occurrences ───────────────────────────────────────────────────────────

/** One parameter riding another template's argument list, whose type that template's parameter fixes. */
interface Deferred {
  readonly parameter: string;
  readonly head: string;
  readonly index: number;
}

/**
 * One position's type, the bound it carries where it is a type position, and the namespace its
 * names resolve in first: a slot's declared type is the applied constructor's, and a field's
 * declared type is the schema's.
 */
interface Use {
  readonly type: TypeRef;
  readonly bound?: TypeRef;
  readonly local: boolean;
}

/** What one declaration's occurrences have made of its parameters so far. */
interface Occurrences {
  readonly parameters: readonly string[];
  readonly written: ReadonlyMap<string, TypeRef>;
  /** Whether the template reads its value parameters in the structure namespace ({@link readsInStructure}). */
  readonly structural: boolean;
  readonly uses: Map<string, Use[]>;
  readonly deferred: Deferred[];
  readonly settled: Set<Deferred>;
}

function createOccurrences(
  parameters: readonly string[],
  written: ReadonlyMap<string, TypeRef>,
  structural: boolean,
): Occurrences {
  return {
    parameters,
    written,
    structural,
    uses: new Map(),
    deferred: [],
    settled: new Set(),
  };
}

function declares(occurrences: Occurrences, name: string): boolean {
  return occurrences.parameters.includes(name);
}

function observe(occurrences: Occurrences, parameter: string, use: Use): void {
  const uses = occurrences.uses.get(parameter);
  if (uses === undefined) {
    occurrences.uses.set(parameter, [use]);
  } else {
    uses.push(use);
  }
}

// ── The environment a parameter is judged in ─────────────────────────────────────────────────

/** The two namespaces a type name resolves in: the schema's own and the governing meta's. */
interface Namespaces {
  readonly local: (name: string) => TypeDefinition | undefined;
  readonly meta: DefinitionGetter;
}

/** A type-ref as the schema spells it — `text`, `box<int32, 3>` — for a message. */
export function spell(ref: TypeRef): string {
  if (ref.arguments.length === 0) return ref.name;
  const rendered = ref.arguments.map((argument) =>
    argument.kind === 'ref' ? spell(argument.ref) : argument.value.text,
  );
  return `${ref.name}<${rendered.join(', ')}>`;
}

function sameType(a: TypeRef, b: TypeRef): boolean {
  return spell(a) === spell(b);
}

function lookup(use: Use, namespaces: Namespaces): TypeDefinition | undefined {
  const [first, second] = use.local
    ? [namespaces.local, namespaces.meta]
    : [namespaces.meta, namespaces.local];
  return first(use.type.name) ?? second(use.type.name);
}

/**
 * Whether `a`'s type IS-A `b`'s: equal, `b` among the supertypes `a` records, or the same name for
 * two entries with the same body — a core type and the kernel original it copies.
 */
function isA(a: Use, b: Use, namespaces: Namespaces): boolean {
  if (sameType(a.type, b.type)) return true;
  if (a.type.arguments.length > 0 || b.type.arguments.length > 0) return false;
  const definition = lookup(a, namespaces);
  if (definition === undefined) return false;
  if (definition.supertypes.includes(b.type.name)) return true;
  const other = lookup(b, namespaces);
  return (
    other !== undefined &&
    a.type.name === b.type.name &&
    JSON.stringify(definition.body, replacer) === JSON.stringify(other.body, replacer)
  );
}

/** `bigint`s are not JSON; the body comparison above only needs them to compare equal when equal. */
function replacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? `${value.toString()}n` : value;
}

/** The use every other use is a supertype of, or a resolver error where no such use exists. */
function narrowest(
  parameter: string,
  verb: string,
  uses: readonly Use[],
  namespaces: Namespaces,
): Use {
  for (const candidate of uses) {
    if (uses.every((other) => isA(candidate, other, namespaces))) return candidate;
  }
  const named = [...new Set(uses.map((use) => spell(use.type)))];
  throw new TsonSchemaValidationError(
    `parameter '${parameter}' is ${verb} ${named.join(' and ')} by the positions it stands in, and ` +
      'none of them IS-A the others, so no argument can satisfy them all -- §5.10 gives a ' +
      'parameter one type, derived from where it is used',
  );
}

/**
 * A written bound names a type, so its name — an application's head, where it is one — resolves in
 * the type-name namespace and nowhere else. The governing meta's constructors are structure
 * vocabulary (§3.3.1): a bound naming one would admit no argument, since a type argument names a
 * type, and the lookup that falls back to the meta for a slot's declared type must not reach it
 * here.
 */
function requireType(bound: TypeRef, namespaces: Namespaces): void {
  if (namespaces.local(bound.name) !== undefined) return;
  throw new TsonSchemaValidationError(
    namespaces.meta(bound.name) !== undefined
      ? `the bound '${spell(bound)}' names '${bound.name}', and '${bound.name}' is a constructor of ` +
          'the governing meta -- structure vocabulary, not a type (§3.3.1); a bound names a type, ' +
          'which every argument must IS-A (§5.10)'
      : `the bound '${spell(bound)}': '${bound.name}' names no type in this schema or its imports (§5.10)`,
  );
}

/**
 * One parameter: the kind its uses agree on, the narrowest of their types or bounds, then what the
 * declaration wrote, which must narrow that further. With no use at all it is a type parameter,
 * bounded by what was written if anything was.
 */
function parameterOf(
  occurrences: Occurrences,
  parameter: string,
  namespaces: Namespaces,
): TemplateParam {
  const all = occurrences.uses.get(parameter) ?? [];
  const declared = occurrences.written.get(parameter);
  const kinds = new Set(all.map((use) => kindOf(use.type)));
  if (kinds.size > 1) {
    throw new TsonSchemaValidationError(
      `parameter '${parameter}' stands in both a type position and a value position, so no ` +
        'argument can satisfy both -- §5.10 gives a parameter one kind, inferred from where it is used',
    );
  }
  if (all.length === 0 || kinds.has('TYPE')) {
    const bounds = all
      .filter((use) => use.bound !== undefined)
      .flatMap((use): Use[] =>
        use.bound === undefined ? [] : [{ type: use.bound, local: use.local }],
      );
    const inherited =
      bounds.length === 0 ? undefined : narrowest(parameter, 'bounded by', bounds, namespaces);
    if (declared !== undefined) {
      requireType(declared, namespaces);
      if (inherited !== undefined && !isA({ type: declared, local: true }, inherited, namespaces)) {
        throw new TsonSchemaValidationError(
          `parameter '${parameter}' is declared '${parameter}: ${spell(declared)}', and a template ` +
            `it is passed to needs a type that IS-A ${spell(inherited.type)}, which ` +
            `${spell(declared)} is not -- a written bound narrows what the uses require, and ` +
            'never widens it',
        );
      }
      return { name: parameter, type: TYPE_REF, bound: declared };
    }
    return {
      name: parameter,
      type: TYPE_REF,
      ...(inherited === undefined ? {} : { bound: inherited.type }),
    };
  }
  const derived = narrowest(parameter, 'read as', all, namespaces);
  if (declared !== undefined) {
    if (occurrences.structural && namespaces.meta(declared.name) === undefined) {
      throw new TsonSchemaValidationError(
        `parameter '${parameter}' is declared '${parameter}: ${spell(declared)}', and this template ` +
          "applies a constructor of the governing meta, so its value parameters are the meta's " +
          `types and a written type names one there -- '${declared.name}' is not in the structure ` +
          'namespace (§5.10)',
      );
    }
    const mine: Use = { type: declared, local: !occurrences.structural };
    if (!isA(mine, derived, namespaces)) {
      throw new TsonSchemaValidationError(
        `parameter '${parameter}' is declared '${parameter}: ${spell(declared)}', and the positions ` +
          `it stands in read it as ${spell(derived.type)}, which ${spell(declared)} does not IS-A -- ` +
          'a written type narrows what the positions give, and never replaces it',
      );
    }
    return { name: parameter, type: declared };
  }
  return { name: parameter, type: derived.type };
}

/** One parameter as far as the fixed point has got, or `undefined` while nothing grounds it. */
function currentOf(
  occurrences: Occurrences,
  parameter: string,
  namespaces: Namespaces,
): TemplateParam | undefined {
  if (!occurrences.uses.has(parameter) && !occurrences.written.has(parameter)) return undefined;
  try {
    return parameterOf(occurrences, parameter, namespaces);
  } catch (e: unknown) {
    if (e instanceof TsonSchemaValidationError) return undefined; // reported against this declaration when it settles
    throw e;
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
  if (head === undefined) return;
  const vocabulary = resolveSlot(head, ctx.meta);
  if (vocabulary !== undefined && isRecordBody(vocabulary)) {
    walkPayload(held.application.coreValue, head, vocabulary, ctx);
  }
}

/**
 * A constructor's payload: a record of bindings, or §5.6's positional form — a record with exactly
 * one unmarked field takes that field's value alone, which is how `!enum [a b M]` binds `members`.
 */
function walkPayload(
  payload: CoreValue,
  constructor: string,
  vocabulary: RecordBody,
  ctx: WalkContext,
): void {
  if (payload.kind === 'record') {
    walkRecord(payload, constructor, vocabulary, ctx);
    return;
  }
  const unmarked = vocabulary.fields.filter((f) => !f.optional);
  const only = unmarked[0];
  if (unmarked.length === 1 && only !== undefined) {
    walkValue(payload, only.type, ctx);
  }
}

/** Each written slot walked against the field the constructor declares for it. */
function walkRecord(
  wire: RecordValue,
  constructor: string,
  vocabulary: RecordBody,
  ctx: WalkContext,
): void {
  for (const written of wire.fields) {
    const value = written.value.value.coreValue;
    if (
      constructor === RECORD_FIELD &&
      written.name === VALUE &&
      value.kind === 'token' &&
      declares(ctx.occurrences, value.text)
    ) {
      walkRouted(value.text, wire, ctx);
      continue;
    }
    const slotField = vocabulary.fields.find((f) => f.name === written.name);
    if (slotField !== undefined) {
      walkValue(value, slotField.type, ctx);
    }
  }
}

/**
 * A routed default or fixed value: the parameter is read as the field's own declared type, which the
 * author wrote and which resolves in the schema's own namespace — or, where that type is itself one
 * of this template's parameters, as whatever that parameter's argument names.
 */
function walkRouted(parameter: string, fieldRecord: RecordValue, ctx: WalkContext): void {
  const declared = field(fieldRecord, TYPE);
  let type: TypeRef | undefined;
  if (declared?.kind === 'token') {
    type = { name: declared.text, arguments: [], annotations: [] };
  } else if (declared?.kind === 'record' && isApplication(declared)) {
    type = typeRefOf(declared);
  }
  if (type === undefined) return; // no type to route into: record_field's own reader refuses the field
  observe(ctx.occurrences, parameter, { type, local: true });
}

/** One written value against the type its slot declares. */
function walkValue(written: CoreValue, declared: TypeRef, ctx: WalkContext): void {
  const slot = declared.name;
  const type = resolveSlot(slot, ctx.meta);
  if (written.kind === 'token' && declares(ctx.occurrences, written.text)) {
    walkToken(written.text, declared, type, ctx);
    return;
  }
  switch (written.kind) {
    case 'array':
      walkElements(written, type, ctx);
      return;
    case 'map':
      if (type !== undefined && 'keyType' in type) walkEntries(written, type, ctx);
      return;
    case 'record':
      if (slot === TYPE_REF_NAME) {
        walkApplication(written, ctx);
      } else if (type !== undefined && isRecordBody(type)) {
        walkRecord(written, slot, type, ctx);
      }
      return;
    default:
      return;
  }
}

/**
 * A map slot: the key against `key_type`, the value against `value_type`. Both halves, because a
 * parameter reaches either — core's `extern_type => <S, T> !scoped { scope: [EXTERN] schemas: { S =>
 * [T] } }` puts one in each.
 */
function walkEntries(
  map: MapValue,
  declared: { keyType: TypeRef; valueType: TypeRef },
  ctx: WalkContext,
): void {
  for (const entry of map.entries) {
    walkValue(entry.key.coreValue, declared.keyType, ctx);
    walkValue(entry.value.value.coreValue, declared.valueType, ctx);
  }
}

/** A parameter standing at a slot: the slot's declared type is the whole of the verdict. */
function walkToken(
  parameter: string,
  declared: TypeRef,
  type: Top | undefined,
  ctx: WalkContext,
): void {
  if (declared.name === TYPE_REF_NAME || (type !== undefined && isAtomBody(type))) {
    observe(ctx.occurrences, parameter, { type: declared, local: false });
  } else {
    throw new TsonSchemaValidationError(
      `parameter '${parameter}' stands where '${declared.name}' is declared, which is neither a type ` +
        'reference nor a scalar -- §5.10 binds a value parameter to scalars only and a type ' +
        'parameter to references, so nothing could be applied here',
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
  }
  // not a collection slot -- a shape error the constructor's own reader reports
}

/**
 * A slot typed `type_ref` holding an application rather than a bare name. The head is a type name;
 * each argument that names a parameter of this declaration is *deferred*, since meta-kernel's
 * `type_argument` puts a parameter of either kind on the reference channel.
 *
 * Read through `wireForm.ts`'s own {@link field}/`NAME`/`ARGUMENTS`, not by matching those wire
 * names here — what an application looks like on the wire is one module's answer, and a walk that
 * re-derives it is a second opinion waiting to disagree.
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

/** Where a declaration whose parameters will not type is reported, entry by entry. */
export interface ParameterTypesFailureReporter {
  report(entryName: string, error: TsonSchemaValidationError): void;
}

/**
 * Every local open entry's parameters, by entry name then parameter name.
 *
 * `entries` is the **whole namespace**, imports included, because a local template may route a
 * parameter into an imported one and take its type from there. `local` is the subset this schema
 * produced: those are walked, and the only names a failure is reported against, since an imported
 * entry resolved in its own schema. `written` is what each local declaration's parameter list wrote.
 */
export function inferAll(
  entries: ReadonlyMap<string, TypeDefinition>,
  local: ReadonlySet<string>,
  written: ReadonlyMap<string, ReadonlyMap<string, TypeRef>>,
  meta: DefinitionGetter,
  reporter: ParameterTypesFailureReporter,
): ReadonlyMap<string, ReadonlyMap<string, TemplateParam>> {
  const observed = new Map<string, Occurrences>();
  const recorded = new Map<string, ReadonlyMap<string, TemplateParam>>();
  const get = (name: string): TypeDefinition | undefined => entries.get(name);
  for (const [name, definition] of entries) {
    if (!isTemplateBody(definition.body)) continue;
    const body = definition.body;
    if (!local.has(name)) {
      recorded.set(name, new Map(body.parameters.map((p) => [p.name, p])));
      continue;
    }
    if (!isHeldBody(body)) continue;
    const occurrences = createOccurrences(
      body.parameterNames,
      written.get(name) ?? new Map(),
      readsInStructure(definition, get),
    );
    try {
      walkBody(body, { occurrences, meta });
    } catch (e: unknown) {
      if (!(e instanceof TsonSchemaValidationError)) throw e;
      reporter.report(name, e);
      continue;
    }
    observed.set(name, occurrences);
  }
  return settle(observed, recorded, entries, reporter, { local: get, meta });
}

/** The same answer as kinds, for the materialiser, which asks only which channel an argument travels on. */
export function kinds(
  parameters: ReadonlyMap<string, ReadonlyMap<string, TemplateParam>>,
): ReadonlyMap<string, ReadonlyMap<string, Kind>> {
  const result = new Map<string, ReadonlyMap<string, Kind>>();
  for (const [entry, params] of parameters) {
    result.set(entry, new Map([...params].map(([name, param]) => [name, kindOf(param.type)])));
  }
  return result;
}

/**
 * One template's kinds from its own body alone, for a caller with no batch pass behind it.
 *
 * {@link inferAll} runs once every declaration has resolved, which is after resolution has already
 * closed some applications on demand — a composition supertype and a refinement source have to
 * absorb the closed entry's fields and cannot wait for the batch. Those closings ask for this
 * instead: the template in hand has resolved, so its own occurrences classify, and only a parameter
 * needing the cross-template fixed point is left undetermined. A body that will not classify yields
 * nothing here and is reported by the batch pass, which is the one that knows which declarations
 * this schema wrote.
 */
export function inferOne(
  template: TypeDefinition,
  meta: DefinitionGetter,
): ReadonlyMap<string, Kind> {
  if (!isTemplateBody(template.body) || !isHeldBody(template.body)) return new Map();
  const occurrences = createOccurrences(template.body.parameterNames, new Map(), false);
  try {
    walkBody(template.body, { occurrences, meta });
  } catch (e: unknown) {
    if (e instanceof TsonSchemaValidationError) return new Map();
    throw e;
  }
  const result = new Map<string, Kind>();
  for (const parameter of occurrences.parameters) {
    const uses = occurrences.uses.get(parameter) ?? [];
    if (uses.length === 0) continue;
    const seen = new Set(uses.map((use) => kindOf(use.type)));
    if (seen.size !== 1) return new Map();
    const [only] = seen;
    if (only !== undefined) result.set(parameter, only);
  }
  return result;
}

// ── The fixed point ──────────────────────────────────────────────────────────────────────────

/**
 * Deferred occurrences resolved against the types already known, until nothing moves. A parameter
 * riding `box<T>`'s argument list takes `box`'s own parameter at that position — its type, and its
 * bound — and `box` may itself be waiting on this one; §5.10 anticipates the cycle, and this pass
 * leaves such a parameter ungrounded, which is an unbounded type parameter.
 */
function settle(
  observed: Map<string, Occurrences>,
  recorded: ReadonlyMap<string, ReadonlyMap<string, TemplateParam>>,
  entries: ReadonlyMap<string, TypeDefinition>,
  reporter: ParameterTypesFailureReporter,
  namespaces: Namespaces,
): ReadonlyMap<string, ReadonlyMap<string, TemplateParam>> {
  let moved = true;
  while (moved) {
    moved = false;
    for (const occurrences of observed.values()) {
      for (const deferred of occurrences.deferred) {
        if (occurrences.settled.has(deferred)) continue;
        const callee = entries.get(deferred.head);
        if (callee === undefined || !isTemplateBody(callee.body)) continue;
        const calleeParameter = callee.body.parameters[deferred.index];
        if (calleeParameter === undefined) {
          occurrences.settled.add(deferred);
          continue; // an arity error, which the materialiser reports where it is applied
        }
        const calleeRecorded = recorded.get(deferred.head);
        const calleeObserved = observed.get(deferred.head);
        const known =
          calleeRecorded !== undefined
            ? calleeRecorded.get(calleeParameter.name)
            : calleeObserved !== undefined
              ? currentOf(calleeObserved, calleeParameter.name, namespaces)
              : undefined;
        if (known === undefined) continue;
        occurrences.settled.add(deferred);
        // A value type is read where the callee reads it: the meta's for a constructor template.
        const schemaSide =
          kindOf(known.type) === 'TYPE'
            ? !recorded.has(deferred.head)
            : !readsInStructure(callee, (n) => entries.get(n));
        observe(occurrences, deferred.parameter, {
          type: known.type,
          ...(known.bound === undefined ? {} : { bound: known.bound }),
          local: schemaSide,
        });
        moved = true;
      }
    }
  }
  const result = new Map<string, ReadonlyMap<string, TemplateParam>>();
  for (const [name, occurrences] of observed) {
    try {
      result.set(
        name,
        new Map(occurrences.parameters.map((p) => [p, parameterOf(occurrences, p, namespaces)])),
      );
    } catch (e: unknown) {
      if (!(e instanceof TsonSchemaValidationError)) throw e;
      reporter.report(name, e);
    }
  }
  return result;
}
