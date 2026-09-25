/**
 * A choice-typed position ([TSON-JSON] §8): §8.2's discrimination predicate, over the
 * resolver-derived `disjoint` fact this port already computes for the text encoding
 * (`link/disjointness.ts`'s `discriminationClassOf`/`choiceDisjoint`, whose class derivation
 * already folds in Revision 36's class-stability rule -- see that module's own top note. There is
 * therefore no separate "class stability" question to ask here, unlike the pinned Java reference,
 * whose own `DiscriminationClass.stable` predicate the change log's own §5.4 text folds into the
 * derivation itself).
 *
 * A value at a choice position MAY omit the tag **if and only if** the choice is `disjoint`, and
 * selection is then by the JSON value kind, which names a discrimination class (§4.2) and so names
 * the one variant bearing it -- no member-shape matching, no trying variants in order. Where it
 * does not hold, the tag is REQUIRED.
 *
 * **A tag is always accepted**, disjoint or not (§8.1): a value's own `$type` places it by name,
 * checked against the variant list alone -- no alias flattening and no subtype admission, matching
 * this port's own text-encoding choice reader (`compiler/choiceReader.ts`), which reads §7.2's
 * subsumption rule as reaching record and atom positions, not a choice's own variant list. §8.4's
 * own reasoning is why: a choice has no expected supertype for a tag to be admitted *into*, only
 * a closed variant list a name either names or does not.
 *
 * **§8.3.1's map escape.** An object whose first member is reserved is read as the tagged form
 * before anything else, even at an untagged, disjoint choice whose brace-class variant is an
 * object-form map: a map's keys are data that may legitimately spell a reserved name, and this is
 * the one combination where an untagged object could be misread as an annotation object.
 */
import type { SchemaLocation } from '../../core/diagnostic.js';
import type { Task } from '../../io/bytes.js';
import { choiceDisjoint, type TypeDefinition } from '../../schema/meta/typedef.js';
import { discriminationClassOf, type DiscriminationClass } from '../../link/disjointness.js';
import type { ChoiceBody } from '../../schema/meta/bodies.js';
import type { JsonReadContext } from '../readContext.js';
import type { JsonEvent } from '../stream.js';
import { describeEvent } from './atoms.js';
import type { CompileContext } from './compile.js';
import { skipNextValue } from './eventSkip.js';
import { nameHygieneRefuses } from './nameHygiene.js';
import { lead as leadOf, leadPresent, SCHEMA, TYPE, type Lead } from './reservedMembers.js';
import { routeTo, type Route } from './route.js';
import type { JsonTypeReader } from './types.js';

const CLASS_LABEL: Record<DiscriminationClass, string> = {
  BOOLEAN: 'boolean',
  NUMBER: 'number',
  STRING: 'string',
  BRACE: 'brace',
  BRACKET: 'bracket',
};

/** §4.2's table, from the wire end: the class an arriving JSON value's own kind names, or `undefined` for one that carries none (`null`, spent as the absent sentinel before any class question arises, §7). */
function classOfKind(event: JsonEvent): DiscriminationClass | undefined {
  switch (event.kind) {
    case 'boolean':
      return 'BOOLEAN';
    case 'number':
      return 'NUMBER';
    case 'string':
      return 'STRING';
    case 'object-start':
      return 'BRACE';
    case 'array-start':
      return 'BRACKET';
    default:
      return undefined;
  }
}

/** Builds the choice reader for one linked schema entry, reachable only through `json/schema/compile.ts`'s own `build`. */
export function buildChoiceReader(
  name: string,
  body: ChoiceBody,
  schemaLocation: SchemaLocation,
  ctx: CompileContext,
): JsonTypeReader {
  const variantNames = body.variants.map((v) => v.name);
  const namesList = variantNames.join(' | ');
  const disjoint = isDisjoint(ctx, name);

  const byClass = new Map<DiscriminationClass, string>();
  if (disjoint) {
    for (const variantName of variantNames) {
      const variantClass = discriminationClassOf(variantName, ctx.linkedSchema.entries);
      if (variantClass === undefined || byClass.has(variantClass)) {
        byClass.clear();
        break;
      }
      byClass.set(variantClass, variantName);
    }
  }
  const classNames = Array.from(byClass.keys())
    .map((c) => CLASS_LABEL[c])
    .sort()
    .join(', ');

  const routes = new Map<string, Route>();
  for (const variantName of variantNames) {
    routes.set(
      variantName,
      routeTo(() => ctx.resolve(variantName)),
    );
  }

  return {
    *read(readCtx: JsonReadContext): Task<unknown> {
      const rctx = readCtx.underDeclaration(schemaLocation);
      const first = yield* rctx.peek();

      // §8.2's decode order, step 1, and §8.3.1's escape: an object whose first member is
      // reserved is the tagged form, before any other reading -- checked from one member name
      // alone, never the object's content.
      if (first.kind === 'object-start') {
        const lead = yield* leadOf(rctx);
        if (leadPresent(lead)) {
          return yield* tagged(rctx, lead, name, namesList, routes, ctx.linkedSchema.entries);
        }
      }

      // Step 2: the untagged route, where §8.2's condition holds -- a direct read at the class's
      // own variant, never through `Route`: an untagged value carries no `$type` for a wrapper or
      // a deeper tag to apply to, so there is nothing for `Route`'s two forms to choose between.
      const arriving = classOfKind(first);
      const variant = arriving === undefined ? undefined : byClass.get(arriving);
      if (variant !== undefined) {
        return yield* ctx.resolve(variant).read(rctx);
      }
      return yield* untagged(rctx, first, name, namesList, byClass.size > 0, classNames);
    },
  };
}

function isDisjoint(ctx: CompileContext, name: string): boolean {
  const def = ctx.linkedSchema.entries.get(name);
  return def !== undefined && choiceDisjoint(def) === true;
}

function* tagged(
  ctx: JsonReadContext,
  lead: Lead,
  displayName: string,
  namesList: string,
  routes: ReadonlyMap<string, Route>,
  entries: ReadonlyMap<string, TypeDefinition>,
): Task<unknown> {
  const { schema, type } = lead;
  if (schema) {
    ctx
      .field(SCHEMA)
      .report(
        'UNRECOGNIZED_FIELD',
        `'$schema' opens a schema scope, which [TSON-SCHEMA] §7.8 admits only at a scoped ` +
          `position -- '${displayName}' is a choice, whose variants its own schema declares`,
        'no $schema at this position',
        SCHEMA,
      );
    yield* skipNextValue(ctx);
    return undefined;
  }
  if (type === undefined) {
    ctx.report(
      'TYPE_MISMATCH',
      `this object leads with this encoding's reserved members but no '$type' naming a variant ` +
        `of '${displayName}' (§3.3)`,
      `a '$type' member holding a variant name`,
      'no $type',
    );
    yield* skipNextValue(ctx);
    return undefined;
  }
  const route = routes.get(type);
  if (route === undefined) {
    if (!nameHygieneRefuses(ctx.field(TYPE), type)) {
      // §7.2's own two-step resolution rule, the same split `compiler/choiceReader.ts` and
      // `json/schema/dispatchTag.ts` both apply: a name `entries` declares nothing under is
      // `UNKNOWN_TYPE_REF` (it resolves nowhere); a name that resolves to a real entry that just
      // isn't one of this choice's variants is `TYPE_MISMATCH` (admitted somewhere, not admitted
      // here).
      const resolves = entries.has(type);
      ctx
        .field(TYPE)
        .report(
          resolves ? 'TYPE_MISMATCH' : 'UNKNOWN_TYPE_REF',
          resolves
            ? `'$type' names '${type}', which is not a variant of '${displayName}'`
            : `'$type' names '${type}', which does not resolve in the governing schema's ` +
                `namespace (§7.2) -- expected one of (${namesList})`,
          namesList,
          type,
        );
    }
    yield* skipNextValue(ctx);
    return undefined;
  }
  return yield* route.read(ctx, lead);
}

function* untagged(
  ctx: JsonReadContext,
  peeked: JsonEvent,
  displayName: string,
  namesList: string,
  hasClasses: boolean,
  classNames: string,
): Task<undefined> {
  const found = describeEvent(peeked);
  if (peeked.kind === 'null') {
    ctx.report(
      'FIELD_REQUIRED',
      `'${displayName}' admits no absence, and JSON null is this encoding's spelling of the ` +
        `absent sentinel (§7)`,
      `a value of one of (${namesList})`,
      'null',
    );
  } else if (!hasClasses) {
    ctx.report(
      'TYPE_MISMATCH',
      `'${displayName}' cannot be discriminated from the JSON form alone, so a value here carries ` +
        `a '$type' naming its variant (§8.2) -- its variants are (${namesList})`,
      `a '$type'-tagged value`,
      found,
    );
  } else {
    ctx.report(
      'TYPE_MISMATCH',
      `no variant of '${displayName}' takes ${found} -- this choice discriminates on the JSON ` +
        `value kind (§8.2), and the kinds its variants take are ${classNames}`,
      namesList,
      found,
    );
  }
  yield* skipNextValue(ctx);
  return undefined;
}
