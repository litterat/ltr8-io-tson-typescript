/**
 * [TSON-SCHEMA] §5.10's parameters: where each may stand, and the bound each is written with.
 *
 * **A parameter is a type.** It stands only at a field's type, at a slot of a type written in place there that holds
 * a type or a name, or as an argument of an application at any of those or in a parent. A parameter anywhere else is
 * refused at the declaration, naming the slot ({@link at}): a field's default or fixed value ({@link atValue}), a size
 * bound, a field name, a group member, a field's `optional`, `voidable` or `role`, the record's `extension`,
 * `name_type` or `discriminators`. A parametric record built from a record body holds a parameter only where it may
 * stand; the explicit spelling, `<T> !meta.record { … }`, is walked against `record`'s own vocabulary before it is
 * bound ({@link checkSlots}).
 *
 * **A bound is written.** A declaration writes one after the parameter's name (`<T: text>`), which names a type;
 * otherwise the parameter is unbounded, and nothing about a parameter is inferred from its uses. A bound naming a
 * constructor admits no argument, a type argument naming a type and no type being IS-A a constructor (§4.1); an
 * incomplete entry is no type (§5.5). Each is refused at the declaration.
 *
 * **A parameter passed on keeps its callee's bound.** One passed as an argument to a bounded parameter of another
 * parametric record is itself written with a bound that IS-A that one, so `rebox => <T> { b: boxed<T> }` over
 * `boxed => <T: text> { v: T }` is refused at `rebox`. Each declaration is judged once against the bounds its
 * callees wrote, so no order among parametric records is needed. A constructor's slot judges the argument that
 * arrives when the record is applied, so a parameter at one (`meta.map<K text>`, `[T]`) needs no bound.
 */
import { TsonNotImplementedError, TsonSchemaValidationError } from '../core/errors.js';
import type { CoreValue, DataValue, MapValue, RecordValue } from '../ast/value.js';
import type { MapBody, RecordBody, RecordField } from '../schema/meta/bodies.js';
import type { Param, Top, TypeExpr, TypeRef } from '../schema/meta/typedef.js';
import { dependentOn, isParametric, parametersOf, supertypesOf } from '../schema/meta/typedef.js';
import { metaName } from '../schema/meta/kernel.js';
import { applicationsOf } from '../schema/meta/typeInline.js';
import { terminal } from '../link/aliasChain.js';
import { noType } from './incompleteEntries.js';
import type { DefinitionGetter } from './resolverTypes.js';
import { OF, TYPE, VALUE } from './wireForm.js';

/** The kernel record whose `type` and `value` slots a parametric record's field binds. */
const RECORD_FIELD = metaName('record_field');

/** The constructor a parametric record applies. */
const RECORD = metaName('record');

/** The one slot of a parametric record a parameter may stand in as a whole token: a field's type. */
const FIELD_TYPE = `${RECORD_FIELD}.${TYPE}`;

/** The kernel's type a type slot holds: a name or a type written in place, `{ of: … }`. */
const TYPE_EXPR = metaName('type_expr');

/** A field's value, which is never a parameter. */
const FIELD_VALUE = `${RECORD_FIELD}.${VALUE}`;

/** The one refusal: `parameter` standing at `slot`, which names no type ([TSON-SCHEMA] §5.10). */
export function at(parameter: string, slot: string): TsonSchemaValidationError {
  return new TsonSchemaValidationError(
    `parameter '${parameter}' stands at ${slot} -- a parameter is a type, and stands only at a field's ` +
      'type or as an argument of an application there or in a parent (§5.10)',
  );
}

/**
 * {@link at} for a field's default or fixed value: a field's value is never a parameter, whatever the field's type.
 * A value that differs per application is written where the application is declared.
 */
export function atValue(parameter: string, field: string): TsonSchemaValidationError {
  return new TsonSchemaValidationError(
    `parameter '${parameter}' stands at the value of field '${field}' (${FIELD_VALUE}) -- a ` +
      "parameter is a type, and stands only at a field's type or as an argument of an application there or " +
      "in a parent, so a field's value is never one (§5.10). State the value where the application is " +
      `declared: 'name => head<argument> & { ${field}?: = value }'`,
  );
}

const TOP = metaName('top');

/** Where a declaration whose parameters are refused is reported. */
export type BoundFailureReporter = (entryName: string, error: TsonSchemaValidationError) => void;

/**
 * Checks each of `local`'s parametric records in `entries` -- the whole namespace, imports included, since a local
 * parametric record may pass a parameter to an imported one -- and returns the names refused. `meta` is where a
 * bound's name is read when the schema does not hold it.
 */
export function check(
  entries: ReadonlyMap<string, Top>,
  local: ReadonlySet<string>,
  meta: DefinitionGetter,
  report: BoundFailureReporter,
): Set<string> {
  const refused = new Set<string>();
  const lookup: DefinitionGetter = (name) => entries.get(name);
  const judged: string[] = [];
  for (const [name, definition] of entries) {
    if (!local.has(name) || !isParametric(definition)) continue;
    try {
      for (const parameter of parametersOf(definition)) {
        if (parameter.bound !== undefined) requireType(parameter.bound, lookup);
      }
      judged.push(name);
    } catch (error: unknown) {
      if (!(error instanceof TsonSchemaValidationError)) throw error;
      refused.add(name);
      report(name, error);
    }
  }
  for (const name of judged) {
    const definition = entries.get(name);
    if (definition === undefined) continue;
    const mine = new Map(parametersOf(definition).map((parameter) => [parameter.name, parameter]));
    try {
      for (const application of applicationsOf(definition)) {
        const head = application.head.name;
        const callee = entries.get(head);
        const theirs = isParametric(callee) && !refused.has(head) ? parametersOf(callee) : [];
        application.arguments.forEach((argument, index) => {
          const passed = mine.get(argument.name);
          const bounded = theirs[index];
          if (passed === undefined || bounded?.bound === undefined) return;
          requireBound(passed, head, bounded.name, bounded.bound, local.has(head), lookup, meta);
        });
      }
    } catch (error: unknown) {
      if (!(error instanceof TsonSchemaValidationError)) throw error;
      refused.add(name);
      report(name, error);
    }
  }
  return refused;
}

/**
 * A written bound names a type: it resolves in the schema's namespace and names no constructor and no incomplete
 * entry. A bound is a name, `meta.param.bound` being `meta.type_ref` (§4.2).
 */
function requireType(bound: TypeRef, lookup: DefinitionGetter): void {
  const name = bound.name;
  const named = lookup(name);
  if (named === undefined) {
    throw new TsonSchemaValidationError(
      `the bound '${name}': '${name}' names no type in this schema or its imports (§5.10)`,
    );
  }
  if (name === TOP || supertypesOf(named).includes(TOP)) {
    throw new TsonSchemaValidationError(
      `the bound '${name}' names '${name}', and '${name}' is a constructor, not a type (§4.1); a bound names a ` +
        'type, which every argument must IS-A (§5.10)',
    );
  }
  const end = lookup(terminal(name, lookup));
  if (end?.kind === 'incomplete') {
    throw new TsonSchemaValidationError(
      `the bound '${name}' names '${name}', ${noType(name, end)}; a bound names a type, which every argument ` +
        'must IS-A, and no type IS-A an incomplete entry (§5.10)',
    );
  }
}

/** `mine`, passed to `callee`'s `theirs` bounded by `bound`: written with a bound that IS-A it. */
function requireBound(
  mine: Param,
  callee: string,
  theirs: string,
  bound: TypeRef,
  calleeLocal: boolean,
  lookup: DefinitionGetter,
  meta: DefinitionGetter,
): void {
  const required = `'${callee}', which declares '${theirs}: ${bound.name}'`;
  if (mine.bound === undefined) {
    throw new TsonSchemaValidationError(
      `parameter '${mine.name}' is passed to ${required}, and is written with no bound -- a parameter passed to ` +
        `a bounded parameter is written with a bound that IS-A it, '<${mine.name}: ${bound.name}>' (§5.10)`,
    );
  }
  const own = mine.bound;
  if (!isA(own, true, bound, calleeLocal, lookup, meta)) {
    throw new TsonSchemaValidationError(
      `parameter '${mine.name}' is declared '${mine.name}: ${own.name}' and passed to ${required}, and ` +
        `${own.name} is not a type that IS-A ${bound.name} (§5.10)`,
    );
  }
}

/**
 * Whether bound `a` IS-A bound `b`: one name, one terminal past alias hops (§8.3), or `b` among the supertypes `a`'s
 * terminal records. Each is looked up first where its own parametric record resolves: a local one's in the schema,
 * an imported one's among the imports.
 */
function isA(
  a: TypeRef,
  aLocal: boolean,
  b: TypeRef,
  bLocal: boolean,
  lookup: DefinitionGetter,
  meta: DefinitionGetter,
): boolean {
  if (a.name === b.name) return true;
  const find =
    (preferLocal: boolean): DefinitionGetter =>
    (name) =>
      preferLocal ? (lookup(name) ?? meta(name)) : (meta(name) ?? lookup(name));
  const aTerminal = terminal(a.name, find(aLocal));
  const bTerminal = terminal(b.name, find(bLocal));
  if (aTerminal === bTerminal) return true;
  const definition = find(aLocal)(aTerminal);
  if (definition === undefined) return false;
  const supertypes = supertypesOf(definition);
  return supertypes.includes(bTerminal) || supertypes.includes(b.name);
}

// ── The walk ─────────────────────────────────────────────────────────────────────────────────

/**
 * The walk's own refusals, thrown, over a parametric record's explicit payload not yet bound, `<T> !meta.record { …
 * }`: its parameters are confined to its field types before `record`'s reader is asked to bind them, so a parameter
 * at a value or a scalar slot is refused for where it stands (§5.10) rather than for the token it is. The payload is
 * walked as the `record` construction the author wrote, so each slot is named as `record` and `record_field` name
 * it.
 *
 * **A type written in place is walked into**, its `{ of: !C { … } }` body against `C`'s vocabulary. A parameter at a
 * slot there that holds a type or a name -- `type: { of: !meta.array { element_type: T } }` -- stands as it does at a
 * field's type. A parameter at a slot that holds no type is refused for where it stands, inside the wrapper as
 * outside it; inside a construction whose constructor cannot be read yet it is a gap.
 */
export function checkSlots(
  parameters: readonly string[],
  payload: DataValue,
  meta: DefinitionGetter,
): void {
  const vocabulary = resolve(RECORD, meta);
  if (vocabulary?.kind === 'record')
    walk(parameters, meta, false).payload(payload.coreValue, RECORD, vocabulary);
}

/** A field's own type, or `undefined` for a dependent field, whose type its sibling names. */
function ownType(field: RecordField): TypeExpr | undefined {
  return dependentOn(field.type) === undefined ? field.type : undefined;
}

/**
 * A name's resolved body, alias chains followed -- the slot type a written value faces. A namespace type faces it as
 * the map its value is.
 */
function resolve(name: string, meta: DefinitionGetter): Top | undefined {
  let definition = meta(name);
  for (let hops = 0; definition?.kind === 'alias' && hops < 32; hops++) {
    definition = meta(definition.target.name);
  }
  if (definition?.kind === 'namespace') {
    const asMap: MapBody = {
      kind: 'map',
      keyType: definition.keyType,
      valueType: definition.valueType,
      voidable: false,
      ordered: definition.ordered,
    };
    return asMap;
  }
  return definition;
}

interface Walk {
  payload(payload: CoreValue, constructor: string, vocabulary: RecordBody): void;
}

function walk(parameters: readonly string[], meta: DefinitionGetter, inPlace: boolean): Walk {
  const declares = (name: string): boolean => parameters.includes(name);

  /**
   * A constructor's payload: a record of bindings, or §5.6's positional form -- a record with exactly one unmarked
   * field takes that field's value alone.
   */
  function payload(written: CoreValue, constructor: string, vocabulary: RecordBody): void {
    if (written.kind === 'record') {
      record(written, constructor, vocabulary);
      return;
    }
    const unmarked = [...vocabulary.fields.entries].filter(([, field]) => !field.optional);
    const only = unmarked.length === 1 ? unmarked[0] : undefined;
    if (only === undefined) return;
    const type = ownType(only[1]);
    if (type !== undefined) value(written, type, `${constructor}.${only[0]}`);
  }

  /** Each written slot walked against the field the constructor declares for it; a field's `value` is never one. */
  function record(wire: RecordValue, constructor: string, vocabulary: RecordBody): void {
    for (const written of wire.fields) {
      const core = written.value.coreValue;
      if (
        constructor === RECORD_FIELD &&
        written.name === VALUE &&
        core.kind === 'token' &&
        declares(core.text)
      ) {
        throw at(core.text, FIELD_VALUE);
      }
      const declared = vocabulary.fields.entries.get(written.name);
      const type = declared === undefined ? undefined : ownType(declared);
      if (type !== undefined) value(core, type, `${constructor}.${written.name}`);
    }
  }

  /** One written value at `slot`, against the type the slot declares. */
  function value(written: CoreValue, declared: TypeExpr, slot: string): void {
    const declaredName = declared.kind === 'inline' ? undefined : declared.name;
    const type = declared.kind === 'inline' ? declared.of : resolve(declared.name, meta);
    if (written.kind === 'token' && declares(written.text)) {
      if (inPlace && (type?.kind === 'ref' || declaredName === TYPE_EXPR)) return;
      // A field written positionally, `item => T`, is its record_field's one unmarked slot, its type.
      token(written.text, declaredName === RECORD_FIELD ? FIELD_TYPE : slot);
      return;
    }
    if (written.kind === 'record' && declaredName === TYPE_EXPR) {
      wrapped(written);
      return;
    }
    if (written.kind === 'array') {
      elements(written.elements, type, slot);
      return;
    }
    if (written.kind === 'map' && type?.kind === 'map') {
      entries(written, type, slot);
      return;
    }
    if (written.kind === 'record' && type?.kind === 'record' && declaredName !== undefined) {
      record(written, declaredName, type);
    }
  }

  /** A type written in place, `{ of: !C { … } }`, walked as the construction of `C` it holds. */
  function wrapped(wrapper: RecordValue): void {
    for (const field of wrapper.fields) {
      if (field.name !== OF) continue; // a field the wrapper does not declare, which its own reader reports
      const construction = field.value;
      const constructor = construction.typeRef;
      const inside = walk(parameters, meta, true);
      const vocabulary = constructor === undefined ? undefined : resolve(constructor, meta);
      if (constructor !== undefined && vocabulary?.kind === 'record') {
        inside.payload(construction.coreValue, constructor, vocabulary);
      } else {
        anyParameter(construction.coreValue);
      }
    }
  }

  /** Refuses, as the gap it is, a parameter anywhere in `written`. */
  function anyParameter(written: CoreValue): void {
    switch (written.kind) {
      case 'token':
        if (declares(written.text)) {
          throw new TsonNotImplementedError(
            `parameter '${written.text}' stands at a type written in place, inside a construction whose ` +
              'constructor is not yet resolved, so which of its slots hold a type cannot be told -- write the ' +
              'type in place with a kernel constructor, or declare the constructor first',
          );
        }
        return;
      case 'array':
        for (const element of written.elements) anyParameter(element.coreValue);
        return;
      case 'map':
        for (const entry of written.entries) {
          anyParameter(entry.key.coreValue);
          anyParameter(entry.value.coreValue);
        }
        return;
      case 'record':
        for (const field of written.fields) anyParameter(field.value.coreValue);
        return;
      default:
        return;
    }
  }

  /** A map slot: the key against `key_type`, the value against `value_type`. */
  function entries(map: MapValue, declared: MapBody, slot: string): void {
    for (const entry of map.entries) {
      value(entry.key.coreValue, declared.keyType, `a key of ${slot}`);
      value(entry.value.coreValue, declared.valueType, slot);
    }
  }

  /** A parameter standing at a slot: admitted only at a field's type, and refused naming the slot anywhere else. */
  function token(parameter: string, slot: string): void {
    if (slot !== FIELD_TYPE) throw at(parameter, slot);
  }

  function elements(written: readonly DataValue[], type: Top | undefined, slot: string): void {
    if (type?.kind === 'array') {
      for (const element of written) value(element.coreValue, type.elementType, slot);
      return;
    }
    if (type?.kind !== 'tuple' || type.elements.length === 0) return;
    written.forEach((element, index) => {
      const position = type.elements[Math.min(index, type.elements.length - 1)];
      if (position !== undefined) value(element.coreValue, position.elementType, slot);
    });
  }

  return { payload };
}
