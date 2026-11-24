/**
 * The walk over every {@link TypeRef} a value of this model holds, at any depth of types written in place: the one
 * place that says which body shape carries which references.
 *
 * **A rewrite takes a name and gives a name back** ({@link Rewrite.atName}), at a type slot (an element, a map's
 * value, a tuple position, a choice variant, a record field's type) and at a slot that holds a name alone (a map's
 * key, a reference's `of`, an alias's target, an application's head and arguments) alike. A type written in place is
 * walked into, each slot inside it rewritten the same way, and may come back as another type in its stead
 * ({@link Rewrite.atInPlace}). A chain is never walked: its parents are a parametric record's to substitute, and its
 * supertypes are names linking computes.
 *
 * **The switch over {@link Top} is exhaustive.** A body shape added to the model fails to type-check here until
 * someone says which references it holds.
 */
import type { RecordField } from './bodies.js';
import { mapFields } from './bodies.js';
import type { ApplyBody, Top, Type, TypeExpr, TypeInline, TypeRef } from './typedef.js';

/** What a walk does with each reference it meets, by the kind of slot holding it. */
export interface Rewrite {
  /** A reference; a name comes back. */
  readonly atName: (reference: TypeRef) => TypeRef;
  /** The body of a type written in place, met before its own slots are walked; the walk goes on in what returns. */
  readonly inPlace?: (body: Type) => Type;
  /**
   * A type written in place, met after its slots are walked, which may come back as another type in its stead: how
   * an application written in place closes where it stands.
   */
  readonly atInPlace?: (inline: TypeInline) => TypeExpr;
}

/** A rewrite changing only the names it meets. */
export function names(atName: (reference: TypeRef) => TypeRef): Rewrite {
  return { atName };
}

/** What a type slot holds with `rewrite` applied: a name rewritten, a type written in place walked into. */
export function map(type: TypeExpr, rewrite: Rewrite): TypeExpr {
  if (type.kind !== 'inline') return rewrite.atName(type);
  const entered = rewrite.inPlace === undefined ? type.of : rewrite.inPlace(type.of);
  const of = mapBody(entered, rewrite);
  const walked: TypeInline = of === type.of ? type : { ...type, of };
  return rewrite.atInPlace === undefined ? walked : rewrite.atInPlace(walked);
}

/** Every reference `type` holds, at any depth of types written in place, each visited once, in order. */
export function forEach(type: TypeExpr, visit: (reference: TypeRef) => void): void {
  map(type, visitor(visit));
}

/** Every reference `body`'s slots hold, its chain left out; {@link forEach} over each. */
export function forEachIn(body: Top, visit: (reference: TypeRef) => void): void {
  mapBody(body, visitor(visit));
}

/** Every application written in place in `type`, at any depth of types written in place. */
export function applications(type: TypeExpr, visit: (application: ApplyBody) => void): void {
  map(type, {
    atName: (reference) => reference,
    inPlace: (body) => {
      if (body.kind === 'apply') visit(body);
      return body;
    },
  });
}

function visitor(visit: (reference: TypeRef) => void): Rewrite {
  return {
    atName: (reference) => {
      visit(reference);
      return reference;
    },
  };
}

/** `body` with every reference its slots hold rewritten, its chain exactly as written; the same object where nothing changed. */
export function mapBody<T extends Top>(body: T, rewrite: Rewrite): T {
  return mapAny(body, rewrite) as T;
}

function mapAny(body: Top, rewrite: Rewrite): Top {
  switch (body.kind) {
    case 'record': {
      // `discriminators` is carried: it holds field names of this record, which no reference rewrite touches.
      const fields = mapFields(body.fields, (field: RecordField) => {
        const type = map(field.type, rewrite);
        return type === field.type ? field : { ...field, type };
      });
      const changed = [...fields.entries].some(
        ([name, field]) => field !== body.fields.entries.get(name),
      );
      return changed ? { ...body, fields } : body;
    }
    case 'array': {
      const elementType = map(body.elementType, rewrite);
      return elementType === body.elementType ? body : { ...body, elementType };
    }
    case 'map':
    case 'namespace': {
      const keyType = rewrite.atName(body.keyType);
      const valueType = map(body.valueType, rewrite);
      return keyType === body.keyType && valueType === body.valueType
        ? body
        : { ...body, keyType, valueType };
    }
    case 'tuple': {
      const elements = body.elements.map((element) => {
        const elementType = map(element.elementType, rewrite);
        return elementType === element.elementType ? element : { ...element, elementType };
      });
      return elements.every((element, index) => element === body.elements[index])
        ? body
        : { ...body, elements };
    }
    case 'choice': {
      const variants = body.variants.map((variant) => map(variant, rewrite));
      return variants.every((variant, index) => variant === body.variants[index])
        ? body
        : { ...body, variants };
    }
    case 'alias': {
      const target = rewrite.atName(body.target);
      return target === body.target ? body : { ...body, target };
    }
    // `of` holds a name ([TSON-SCHEMA] §4.2); the index is carried, derived at link.
    case 'ref': {
      const of = rewrite.atName(body.of);
      return of === body.of ? body : { ...body, of };
    }
    case 'apply': {
      const head = rewrite.atName(body.head);
      const args = body.arguments.map((argument) => rewrite.atName(argument));
      return head === body.head &&
        args.every((argument, index) => argument === body.arguments[index])
        ? body
        : { ...body, head, arguments: args };
    }
    // None of these holds a type's name: an extern's `type` is a name of the foreign namespace, a dependent type's
    // `on` names a field of the enclosing record, a value is data judged at link against the closure, an
    // incomplete entry's names are judged where it is completed, a declared type holds its chain alone, and every
    // other atom's facets are values.
    case 'extern':
    case 'dependent':
    case 'value_entry':
    case 'incomplete':
    case 'declared_type':
    case 'enum':
    case 'void_type':
    case 'integer_type':
    case 'decimal_type':
    case 'float_type':
    case 'rational_type':
    case 'complex_type':
    case 'text_type':
    case 'identifier_type':
    case 'regex_type':
    case 'iri_type':
    case 'uri_type':
    case 'email_type':
    case 'uuid_type':
    case 'ipv4_type':
    case 'ipv6_type':
    case 'cidr4_type':
    case 'cidr6_type':
    case 'mac_type':
    case 'hostname_type':
    case 'host_type':
    case 'media_type_type':
    case 'bytes_type':
    case 'date_type':
    case 'time_type':
    case 'datetime_type':
    case 'duration_type':
    case 'period_type':
      return body;
  }
}
