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
 * checked against the variant list **flattened for alias, not for subtype** -- an alias of a
 * variant is admitted, a proper subtype of one is not, matching this port's own text-encoding
 * choice reader (`compiler/choiceReader.ts`).
 *
 * **Alias flattening.** §3.3 requires `$type` to be "admissible at the position under
 * [TSON-SCHEMA] §7.2's subsumption rule (... a variant of it at choice positions ...)", and §5.4's
 * own "Resolution" paragraph already reads a variant by what it *resolves to*, not by its written
 * spelling ("the resolver validates that each variant resolves to a distinct type"); §8.3 states
 * the general principle a variant reference shares with every other one -- "a reference is a hop,
 * not a rewrite... the same type under another name" -- so an alias of a variant names the variant
 * it points to, the same identity question `link/referenceChain.ts`'s own `admitting` already
 * answers for record subsumption and this reader now shares it for (`ctx.linkedSchema.entries`
 * flattens the written variant names the same way `dispatchTag.ts` flattens a family's declared
 * subtypes). The reference implementation's own `DispatchChoiceReader` agrees: `context.admitting`
 * over the variant list, in its own Javadoc's words, "an alias of one... by its tag".
 *
 * **No subtype admission, a deliberate divergence from the reference.** The reference additionally
 * flattens each variant's own `subtypes` into the route table ("a subtype of one by its tag", its
 * own Javadoc). This port does not: §7.2's own text carves this position out of the rule its
 * subtype-inclusive supertype-chain test governs -- "Choice-typed positions discriminate by
 * variant membership (§5.4) ... under their own membership relations; this rule governs every
 * *other* typed position" -- and §8.4 gives the structural reason a choice has none to extend: "a
 * choice has no expected supertype for a tag to be admitted *into*, only a closed variant list a
 * name either names or does not... the discriminator is a property of a record family and lives
 * with the records (§6.1.5)". An author who wants a subtype reachable by tag types the position by
 * the record family instead (§8.4's own closing paragraph), which is the edit that buys it.
 *
 * **§8.3.1's map escape.** An object whose first member is reserved is read as the tagged form
 * before anything else, even at an untagged, disjoint choice whose brace-class variant is an
 * object-form map: a map's keys are data that may legitimately spell a reserved name, and this is
 * the one combination where an untagged object could be misread as an annotation object.
 *
 * **A sealed or abstract-with-subtypes variant's own name is still an admissible tag, and reading
 * it does not reach that variant's own "the base has no direct instances" refusal.** No-subtype-
 * admission (above) means a choice over such a family admits no more specific written name than
 * the variant's own -- `json/schema/dispatchMember.ts`'s own reader would otherwise be the only
 * thing standing between an author and an unwritable schema for this shape (§8.4's closing
 * paragraph assumes it is usable). Where the resolved variant offers
 * `json/schema/route.ts`'s own `ChoiceSelfTagReadable` capability, `tagged` (below) consumes the
 * object's opening brace and that leading tag for real and hands off to it directly, instead of
 * going through the ordinary `Route`; every other variant (records with direct instances, atoms,
 * arrays, ...) is unaffected; and a tag naming a *subtype* of such a variant is still refused --
 * this fix is about the variant's own name, never about admitting a name the choice does not
 * otherwise admit.
 */
import type { SchemaLocation } from '../../core/diagnostic.js';
import type { Task } from '../../io/bytes.js';
import { choiceDisjoint, type TypeDefinition } from '../../schema/meta/typedef.js';
import { discriminationClassOf, type DiscriminationClass } from '../../link/disjointness.js';
import { admitting, terminal } from '../../link/referenceChain.js';
import type { ChoiceBody } from '../../schema/meta/bodies.js';
import type { JsonReadContext } from '../readContext.js';
import type { JsonEvent } from '../stream.js';
import { describeEvent } from './atoms.js';
import type { CompileContext } from './compile.js';
import { skipNextValue } from './eventSkip.js';
import { nameHygieneRefuses } from './nameHygiene.js';
import { lead as leadOf, leadPresent, SCHEMA, TYPE, type Lead } from './reservedMembers.js';
import { hasChoiceSelfTag, routeTo, type Route } from './route.js';
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

  // Alias-flattened (this module's own top note): every name whose reference chain terminates at
  // a variant is admitted, routed to the variant itself -- never to a subtype, which this reader
  // does not flatten in. A written variant name is flattened to *its own* terminal first
  // (`terminal`), then `admitting` collects every name (including the variant's own
  // written spelling) whose chain ends there too: a variant that is itself an alias (`either2 =>
  // (n_of | count)`, `n_of => note`) admits its target (`note`) and every sibling alias
  // (`n2 => note`) as well, not only its own written spelling -- §5.4's own "resolves to a
  // distinct type" reading, applied one hop further than a variant that already names a terminal
  // needs it to be. `resolvers` keeps each written name's own lazy resolver alongside its
  // `Route`, so `tagged` (below) can reach the raw reader directly for the sealed/abstract
  // self-tag continuation (`route.ts`'s own `ChoiceSelfTagReadable`), which needs the reader
  // itself rather than the `Route` wrapper built around it.
  const variantTerminals = Array.from(
    new Set(
      variantNames.map((written) => terminal(written, (n) => ctx.linkedSchema.entries.get(n))),
    ),
  );
  const routes = new Map<string, Route>();
  const resolvers = new Map<string, () => JsonTypeReader>();
  for (const written of admitting(variantTerminals, ctx.linkedSchema.entries)) {
    const resolveThis = () => ctx.resolve(written);
    resolvers.set(written, resolveThis);
    routes.set(written, routeTo(resolveThis));
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
          return yield* tagged(
            rctx,
            lead,
            name,
            namesList,
            routes,
            resolvers,
            ctx.linkedSchema.entries,
          );
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
  resolvers: ReadonlyMap<string, () => JsonTypeReader>,
  entries: ReadonlyMap<string, TypeDefinition>,
): Task<unknown> {
  const { schema, type } = lead;
  if (schema) {
    // §3.3, §9.4: resolver category, not `UNRECOGNIZED_FIELD` -- see `reservedMembers.ts`'s top
    // note.
    ctx
      .field(SCHEMA)
      .report(
        'UNKNOWN_TYPE_REF',
        `'$schema' opens a schema scope, which [TSON-SCHEMA] §7.8 admits only at a scoped ` +
          `position -- '${displayName}' is a choice, whose variants its own schema declares`,
        'no $schema at this position',
        SCHEMA,
      );
    yield* skipNextValue(ctx);
    return undefined;
  }
  if (type === undefined) {
    // `tagged` is reached only when `leadPresent(lead)` held and `schema` has already been ruled
    // out above, so this is always a bare `$value` with no leading `$type` (`lead.wrapper`) --
    // §9.4's table: "a `$value` in an object not led by `$type`" is resolver category, not
    // `TYPE_MISMATCH`'s validation one.
    ctx.report(
      'UNKNOWN_TYPE_REF',
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
  // The sealed/abstract-with-subtypes self-tag continuation (this module's own top note, and
  // `route.ts`'s own `ChoiceSelfTagReadable`): only ever offered by a variant whose own name is
  // what `type` names here (`routes`/`resolvers` are alias-flattened but never subtype-flattened,
  // this module's top note), and only reachable inline -- a wrapper's `$value` is always a fresh
  // object with room for its own tag, so the ordinary `Route` already handles it correctly.
  if (!lead.wrapper) {
    const resolved = resolvers.get(type)?.();
    if (resolved !== undefined && hasChoiceSelfTag(resolved)) {
      return yield* resolved.readChoiceSelfTag(ctx);
    }
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
