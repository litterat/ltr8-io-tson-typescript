/**
 * The facts about a type written in place (§4.2, §8.2) that are stated once: which bodies may stand in place,
 * why one may not, and when two type expressions are one type.
 */
import type { RecordBody } from './bodies.js';
import { fieldMapOf, namedFields, typeExprText } from './bodies.js';
import type { ApplyBody, Top, Type, TypeExpr, TypeInline, TypeRef } from './typedef.js';
import { isEmptyChain, isType, sameRef } from './typedef.js';

/**
 * Whether `type` is a construction that may be written in place: a container, a tuple, a choice or a reference.
 * A namespace type is no such container, its values being tagged by its name; a record in place is no
 * construction.
 */
export function constructible(type: Type): boolean {
  return (
    type.kind === 'array' ||
    type.kind === 'map' ||
    type.kind === 'tuple' ||
    type.kind === 'choice' ||
    type.kind === 'ref'
  );
}

/**
 * Why `inline` may not be written in place as it is (§4.2, §5.2), naming it by its form, the section and the
 * remedy; `undefined` where it may. A type in place has no name: nothing composes it or applies it.
 */
export function inlineRefusal(inline: TypeInline): string | undefined {
  const nameIt = ' ([TSON-SCHEMA] §4.2, §5.2): declare it under a name and write that name';
  const of = inline.of;
  if (
    !constructible(of) &&
    of.kind !== 'dependent' &&
    of.kind !== 'record' &&
    of.kind !== 'apply'
  ) {
    return (
      `'!${inline.head} { ... }' is written in place, and only a container, a tuple, a choice, a reference, ` +
      'a dependent type, a record or an application is: an enum, an atom and a namespace type are declared ' +
      `and named${nameIt}`
    );
  }
  const form = `${of.kind === 'record' ? 'the record written in place' : 'the type written in place'} '${typeExprText(inline)}'`;
  if (!isEmptyChain(of.chain)) {
    return (
      `${form} states a chain, and a type written in place carries none: it has no name, so it is a member ` +
      `of nothing and nothing composes it${nameIt}`
    );
  }
  if (of.kind === 'record' && (of.parameters?.length ?? 0) > 0) {
    return (
      `${form} takes parameters, and a parametric record is applied by its name, which a record written in ` +
      `place has none of${nameIt}`
    );
  }
  if (of.kind === 'record') return discriminatorsRefusal(of, form);
  return undefined;
}

/** Why `record`, named `form`, states `discriminators` it may not: they need `extension: ABSTRACT` (§5.2, item 133). */
export function discriminatorsRefusal(record: RecordBody, form: string): string | undefined {
  if (record.discriminators === undefined || record.extension === 'ABSTRACT') return undefined;
  return (
    `${form} states 'discriminators' beside extension ${record.extension}, and the fields a family is ` +
    "selected by are an abstract base's: state 'extension: ABSTRACT' beside them (§5.2)"
  );
}

/**
 * Whether `a` and `b` are one type (§8.2): two names when they name one entry by spelling, two types in place when
 * their constructor and body are equal, names as the leaves and annotations taking no part. A name and a type in
 * place are never one type.
 */
export function sameTypeExpr(a: TypeExpr, b: TypeExpr): boolean {
  if (a.kind !== 'inline' || b.kind !== 'inline') {
    return a.kind !== 'inline' && b.kind !== 'inline' && sameRef(a, b);
  }
  return a.head === b.head && identity(a.of) === identity(b.of);
}

/** `value`'s structure as identity compares it: annotations and an in-place record's application left out. */
function identity(value: unknown): string {
  return JSON.stringify(value, (key, held: unknown) => {
    if (key === 'annotations' || key === 'application' || key === 'keyAnnotations')
      return undefined;
    if (typeof held === 'bigint') return `${held.toString()}n`;
    if (held instanceof Map) return [...(held as Map<unknown, unknown>).entries()];
    return held;
  });
}

/**
 * `record` with every reference among its field types and in its types written in place, at any depth, that one
 * of its `parameters` declares marked as that parameter (§5.10's shadowing rule: inside a parametric record a name
 * is read against its parameters before the namespace).
 */
export function withParametersMarked(record: RecordBody): RecordBody {
  const names = new Set((record.parameters ?? []).map((parameter) => parameter.name));
  const fields = fieldMapOf(
    namedFields(record).map((field) => ({ ...field, type: markedExpr(field.type, names) })),
    record.fields.keyAnnotations,
  );
  return { ...record, fields };
}

function markedRef(ref: TypeRef, names: ReadonlySet<string>): TypeRef {
  return names.has(ref.name) && ref.param !== true ? { ...ref, param: true } : ref;
}

function markedExpr(expr: TypeExpr, names: ReadonlySet<string>): TypeExpr {
  if (expr.kind !== 'inline') return markedRef(expr, names);
  return { ...expr, of: markedType(expr.of, names) };
}

function markedType(type: Type, names: ReadonlySet<string>): Type {
  switch (type.kind) {
    case 'array':
      return { ...type, elementType: markedExpr(type.elementType, names) };
    case 'map':
    case 'namespace':
      return { ...type, valueType: markedExpr(type.valueType, names) };
    case 'tuple':
      return {
        ...type,
        elements: type.elements.map((element) => ({
          ...element,
          elementType: markedExpr(element.elementType, names),
        })),
      };
    case 'choice':
      return { ...type, variants: type.variants.map((variant) => markedExpr(variant, names)) };
    case 'ref':
      return { ...type, of: markedRef(type.of, names) };
    case 'apply':
      return { ...type, arguments: type.arguments.map((argument) => markedRef(argument, names)) };
    case 'record':
      return {
        ...type,
        fields: fieldMapOf(
          namedFields(type).map((field) => ({ ...field, type: markedExpr(field.type, names) })),
          type.fields.keyAnnotations,
        ),
      };
    default:
      return type;
  }
}

/**
 * `value` with every type written in place at any depth of it -- at a record's field types, an array's element, a
 * map's or a namespace type's value, a tuple's positions and a choice's variants -- passed through `map`,
 * innermost first. The same object comes back where nothing changed. A chain's parents are not walked: they are a
 * parametric record's, which no derived index reaches.
 */
export function mapInPlace<T extends Top>(value: T, map: (inline: TypeInline) => TypeInline): T {
  return isType(value) ? (mapType(value, map) as T) : value;
}

function mapExpr(expr: TypeExpr, map: (inline: TypeInline) => TypeInline): TypeExpr {
  if (expr.kind !== 'inline') return expr;
  const of = mapType(expr.of, map);
  return map(of === expr.of ? expr : { ...expr, of });
}

function mapType(type: Type, map: (inline: TypeInline) => TypeInline): Type {
  switch (type.kind) {
    case 'record': {
      const written = namedFields(type);
      const fields = written.map((field) => {
        const mapped = mapExpr(field.type, map);
        return mapped === field.type ? field : { ...field, type: mapped };
      });
      return fields.every((field, index) => field === written[index])
        ? type
        : { ...type, fields: fieldMapOf(fields, type.fields.keyAnnotations) };
    }
    case 'array': {
      const elementType = mapExpr(type.elementType, map);
      return elementType === type.elementType ? type : { ...type, elementType };
    }
    case 'map':
    case 'namespace': {
      const valueType = mapExpr(type.valueType, map);
      return valueType === type.valueType ? type : { ...type, valueType };
    }
    case 'tuple': {
      const elements = type.elements.map((element) => {
        const elementType = mapExpr(element.elementType, map);
        return elementType === element.elementType ? element : { ...element, elementType };
      });
      return elements.every((element, index) => element === type.elements[index])
        ? type
        : { ...type, elements };
    }
    case 'choice': {
      const variants = type.variants.map((variant) => mapExpr(variant, map));
      return variants.every((variant, index) => variant === type.variants[index])
        ? type
        : { ...type, variants };
    }
    default:
      return type;
  }
}

/**
 * Every application a parametric record writes, at any depth of its fields' types and of its parents, in
 * declaration order: what §5.10's bounds are judged against where a parameter is passed on. A closed entry writes
 * none that is still open.
 */
export function applicationsOf(value: Top): ApplyBody[] {
  if (value.kind !== 'record' || (value.parameters?.length ?? 0) === 0) return [];
  const found: ApplyBody[] = [];
  for (const field of namedFields(value)) collectApplications(field.type, found);
  for (const parent of value.chain?.parents ?? []) collectApplications(parent, found);
  return found;
}

function collectApplications(expr: TypeExpr, found: ApplyBody[]): void {
  if (expr.kind !== 'inline') return;
  const of = expr.of;
  switch (of.kind) {
    case 'apply':
      found.push(of);
      return;
    case 'record':
      for (const field of namedFields(of)) collectApplications(field.type, found);
      return;
    case 'array':
      collectApplications(of.elementType, found);
      return;
    case 'map':
    case 'namespace':
      collectApplications(of.valueType, found);
      return;
    case 'tuple':
      for (const element of of.elements) collectApplications(element.elementType, found);
      return;
    case 'choice':
      for (const variant of of.variants) collectApplications(variant, found);
      return;
    default:
      return;
  }
}

/**
 * The first parameter `expr` names, as itself, at a slot of a type written in place, or as an argument, at any depth
 * -- `undefined` where `expr` means the same thing in every application, and so is closed already (§5.10).
 */
export function parameterIn(expr: TypeExpr): string | undefined {
  if (expr.kind !== 'inline') return expr.param === true ? expr.name : undefined;
  return parameterInType(expr.of);
}

function parameterInType(type: Type): string | undefined {
  const first = (exprs: readonly TypeExpr[]): string | undefined => {
    for (const expr of exprs) {
      const found = parameterIn(expr);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const named = (refs: readonly TypeRef[]): string | undefined =>
    refs.find((ref) => ref.param === true)?.name;
  switch (type.kind) {
    case 'record':
      return first(namedFields(type).map((field) => field.type));
    case 'array':
      return parameterIn(type.elementType);
    case 'map':
      return named([type.keyType]) ?? parameterIn(type.valueType);
    case 'namespace':
      return parameterIn(type.valueType);
    case 'tuple':
      return first(type.elements.map((element) => element.elementType));
    case 'choice':
      return first(type.variants);
    case 'ref':
      return named([type.of]);
    case 'apply':
      return named(type.arguments);
    default:
      return undefined;
  }
}

/** Every record written in place at any depth of `value`'s type slots, outermost first (§4.2). */
export function recordsInPlace(value: Top): RecordBody[] {
  const found: RecordBody[] = [];
  mapInPlace(value, (inline) => {
    if (inline.of.kind === 'record') found.push(inline.of);
    return inline;
  });
  return found.reverse();
}
