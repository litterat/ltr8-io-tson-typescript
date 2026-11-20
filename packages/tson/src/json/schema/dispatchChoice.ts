/**
 * A choice-typed position ([TSON-JSON] §8): §8.2's discrimination predicate, over the
 * resolver-derived `disjoint` fact this port already computes for the text encoding
 * (`link/disjointness.ts`'s `discriminationClassOf`/`choiceDisjoint`, whose class derivation
 * already folds in §5.4's class-stability rule -- see that module's own top note. There is
 * therefore no separate "class stability" question to ask here, unlike the pinned Java reference,
 * whose own `DiscriminationClass.stable` predicate is a separate check §5.4 folds into this
 * port's derivation instead).
 *
 * A value at a choice position MAY omit the tag **if and only if** the choice is `disjoint`, and
 * selection is then by the JSON value kind, which names a discrimination class (§4.2) and so names
 * the one variant bearing it -- no member-shape matching, no trying variants in order. Where it
 * does not hold, the tag is REQUIRED.
 *
 * **A tag is always accepted**, disjoint or not (§8.1): a value's own `$type` places it by name,
 * and §5.4 says which variant a name selects (`choiceSelection.ts`): a name meaning a variant
 * selects it, before any variant it only IS-A; a name IS-A exactly one variant and meaning none
 * selects that one; a name IS-A more than one and meaning none selects none. "Meaning" is
 * §8.3's identity: a reference is a hop, not a rewrite, so an alias of a variant is the variant
 * (`link/aliasChain.ts`'s `admitting`, which `dispatchTag.ts` applies to a family's subtypes too).
 * A type IS-A one variant by the namespace's `subtypes` index, and is read **as itself**: the
 * `$type` names it directly, never through the variant -- `{ "$type": "circle", … }` at a choice
 * holding `shape`, and no wrapper naming `shape` around a value naming `circle` (§3.3's one type
 * name). A subtype of a variant that is no record is read at the subtype's own reader, whose facets
 * the variant's would not check; one below a sealed family's variant is placed by that family's own
 * selectors, which a choice cannot bypass.
 *
 * **§8.3.1's map escape.** An object whose first member is an annotation member is read as the
 * tagged form before anything else, even at an untagged, disjoint choice whose brace-class variant
 * is an object-form map: a map's keys are data that may legitimately spell one of the three, and this is
 * the one combination where an untagged object could be misread as an annotation object.
 *
 * **A sealed or abstract-with-subtypes variant's own name is an admissible tag, and reading it
 * does not reach that variant's own "the base has no direct instances" refusal.**
 * `json/schema/dispatchMember.ts`'s own reader would otherwise be the only thing standing between
 * an author and an unwritable schema for this shape (§8.4's closing paragraph assumes it is
 * usable). Where the resolved variant offers `json/schema/route.ts`'s own `ChoiceSelfTagReadable`
 * capability, `tagged` (below) consumes the object's opening brace and that leading tag for real
 * and hands off to it directly, instead of going through the ordinary `Route`; every other variant
 * (records with direct instances, atoms, arrays, ...) is unaffected.
 */
import type { TypeExpr } from '../../schema/meta/typedef.js';
import { typeExprText } from '../../schema/meta/bodies.js';
import type { SchemaLocation } from '../../core/diagnostic.js';
import type { Task } from '../../io/bytes.js';
import { choiceDisjoint, subtypesOf, type Top } from '../../schema/meta/typedef.js';
import { discriminationClassOf, type DiscriminationClass } from '../../link/disjointness.js';
import { admitting, terminal } from '../../link/aliasChain.js';
import type { ChoiceBody } from '../../schema/meta/bodies.js';
import type { JsonReadContext } from '../readContext.js';
import type { JsonEvent } from '../stream.js';
import { describeEvent } from './atoms.js';
import type { CompileContext } from './compile.js';
import { skipNextValue } from './eventSkip.js';
import { nameHygieneRefuses } from './nameHygiene.js';
import { lead as leadOf, leadPresent, TYPE, type Lead } from './tagMembers.js';
import { CHOICE, refusesScope } from './tags.js';
import { selectChoice } from './choiceSelection.js';
import { hasChoiceSelfTag, isKeyedType, routeTo, type Route } from './route.js';
import type { JsonTypeReader } from './types.js';

const CLASS_LABEL: Record<DiscriminationClass, string> = {
  BOOLEAN: 'boolean',
  NUMBER: 'number',
  STRING: 'string',
  BRACE: 'brace',
  BRACKET: 'bracket',
};

/** §4.2's table, from the wire end: the class an arriving JSON value's own kind names, or `undefined` for one that carries none (`null`, spent as the void sentinel before any class question arises, §7). */
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
  // A type written in place is named by no tag (§4.2): only a named variant is reached by `$type`.
  const variantNames = body.variants.flatMap((v) => (v.kind === 'inline' ? [] : [v.name]));
  const namesList = body.variants.map(typeExprText).join(' | ');
  // The body's own fact: a choice written in place is no entry, so its fact is on the body the link set it on.
  const disjoint = choiceDisjoint(body) === true;

  const byClass = new Map<DiscriminationClass, TypeExpr>();
  if (disjoint) {
    for (const variant of body.variants) {
      const variantClass = discriminationClassOf(variant, ctx.linkedSchema.entries);
      if (variantClass === undefined || byClass.has(variantClass)) {
        byClass.clear();
        break;
      }
      byClass.set(variantClass, variant);
    }
  }
  const classNames = Array.from(byClass.keys())
    .map((c) => CLASS_LABEL[c])
    .sort()
    .join(', ');

  // §5.4's selection ({@link selectChoice}): a name meaning a variant -- the variant itself, or an alias
  // of what it resolves to ("resolves to a distinct type", §5.4's own "Resolution" paragraph) -- selects
  // it before any variant the name only IS-A, and a name IS-A exactly one variant selects that one. A
  // written variant name is flattened to *its own* terminal first (`terminal`), then `admitting`
  // collects every name whose chain ends there too: a variant that is itself an alias (`either2 =>
  // (n_of | count)`, `n_of => note`) admits its target (`note`) and every sibling alias (`n2 => note`)
  // as well. `resolvers` keeps each name's own lazy resolver alongside its `Route`, so `tagged` (below)
  // can reach the raw reader directly for the sealed/abstract self-tag continuation (`route.ts`'s own
  // `ChoiceSelfTagReadable`), which needs the reader itself rather than the `Route` wrapper.
  const entries = ctx.linkedSchema.entries;
  const lookup = (n: string): Top | undefined => entries.get(n);
  const terminalOf = new Map<string, string>(
    variantNames.map((written) => [written, terminal(written, lookup)]),
  );
  const selection = selectChoice(
    variantNames,
    (variant) => admitting([terminalOf.get(variant) ?? variant], entries),
    (variant) => {
      const definition = lookup(terminalOf.get(variant) ?? variant);
      return definition === undefined ? [] : admitting(subtypesOf(definition), entries);
    },
  );
  const routes = new Map<string, Route>();
  const resolvers = new Map<string, () => JsonTypeReader>();
  for (const [written, variant] of selection.selects) {
    const keyed = isKeyedType(written, entries);
    if (selection.named.has(written)) {
      const resolveThis = () => ctx.resolve(written);
      resolvers.set(written, resolveThis);
      routes.set(written, routeTo(resolveThis, keyed));
      continue;
    }
    // A subtype of the variant, selected by its own name and read as itself: a record variant that
    // places by its own selectors -- a sealed family, whose discriminators this position cannot bypass --
    // receives the value and places it itself, and anything else reads the subtype at its own reader,
    // whose facets the variant's reader would not check.
    const variantDefinition = lookup(terminalOf.get(variant) ?? variant);
    const sealed =
      variantDefinition?.kind === 'record' &&
      variantDefinition.extension === 'ABSTRACT' &&
      variantDefinition.discriminators !== undefined;
    routes.set(
      written,
      sealed ? routeTo(() => ctx.resolve(variant)) : routeTo(() => ctx.resolve(written), keyed),
    );
  }
  const selectsNone = selection.selectsNone;

  return {
    *read(readCtx: JsonReadContext): Task<unknown> {
      const rctx = readCtx.underDeclaration(schemaLocation);
      const first = yield* rctx.peek();

      // §8.2's decode order, step 1, and §8.3.1's escape: an object whose first member is one of
      // the three is the tagged form, before any other reading -- checked from one member name
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
            selectsNone,
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

function* tagged(
  ctx: JsonReadContext,
  lead: Lead,
  displayName: string,
  namesList: string,
  routes: ReadonlyMap<string, Route>,
  resolvers: ReadonlyMap<string, () => JsonTypeReader>,
  selectsNone: ReadonlyMap<string, readonly string[]>,
  entries: ReadonlyMap<string, Top>,
): Task<unknown> {
  const { type } = lead;
  // §3.3: `$import` stands at the top of the document alone, so a choice position refuses it.
  if (yield* refusesScope(ctx, lead, displayName, CHOICE)) return undefined;
  if (type === undefined) {
    // `tagged` is reached only when `leadPresent(lead)` held and `$import` has already been ruled
    // out above, so this is always a bare `$value` with no leading `$type` (`lead.wrapper`) --
    // §9.4's table: "a `$value` in an object not led by `$type`" is resolver category, not
    // `TYPE_MISMATCH`'s validation one.
    ctx.report(
      'UNKNOWN_TYPE_REF',
      `this object leads with this encoding's annotation members but no '$type' naming a variant ` +
        `of '${displayName}' (§3.3)`,
      `a '$type' member holding a variant name`,
      'no $type',
    );
    yield* skipNextValue(ctx);
    return undefined;
  }
  const route = routes.get(type);
  if (route === undefined) {
    const among = selectsNone.get(type);
    if (among !== undefined) {
      // §5.4: a name IS-A more than one variant and meaning none selects none.
      ctx
        .field(TYPE)
        .report(
          'TYPE_MISMATCH',
          `'$type' names '${type}', a subtype of more than one variant of '${displayName}' -- ` +
            `(${among.join(' | ')}) -- and of none by name, so it selects none (§8.1)`,
          among.join(' | '),
          type,
        );
    } else if (!nameHygieneRefuses(ctx.field(TYPE), type)) {
      // §7.2's own two-step resolution rule, the same split `compiler/choiceReader.ts` and
      // `json/schema/dispatchTag.ts` both apply: a name `entries` declares nothing under is
      // `UNKNOWN_TYPE_REF` (it resolves nowhere); a name that resolves to a real entry that is
      // neither a variant nor a type IS-A exactly one is `TYPE_MISMATCH` (admitted somewhere, not
      // admitted here).
      const resolves = entries.has(type);
      ctx
        .field(TYPE)
        .report(
          resolves ? 'TYPE_MISMATCH' : 'UNKNOWN_TYPE_REF',
          resolves
            ? `'$type' names '${type}', which is neither a variant of '${displayName}' nor a ` +
                'subtype of exactly one (§5.4, §8.1)'
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
      `'${displayName}' is not voidable, and JSON null is this encoding's spelling of the ` +
        `void sentinel (§7)`,
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
