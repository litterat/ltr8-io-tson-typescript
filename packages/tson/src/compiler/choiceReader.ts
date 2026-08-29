/**
 * Tree mode's `choice` (SUM-kind) reader -- reads a value governed by a resolved
 * {@link ChoiceBody} by dispatching on its own leading `!type-ref` to the matching variant's own
 * compiled reader (§3.2, §5.4). The one dispatch `reader/tree/grammar.ts`'s own top note reserves
 * for "Wave 5's compiler, not this package": `EventSkip.java`'s port there deliberately drops the
 * `aheadOfValue`/`typeRefAhead` lookahead pair for exactly this reason.
 *
 * Mirrors `reader/bind.ts`'s own `readVariant` algorithm (bind mode's equivalent dispatch over a
 * `VariantBinding`) rather than importing it -- `reader/bind.ts` reaches into `bind/` for
 * `VariantBinding`'s own shape, and `compiler/`'s zone forbids that path outright; the dispatch
 * *rule* itself (look ahead past annotations for the type-ref, never consume, delegate the whole
 * value unconsumed) has nothing schema- or binding-specific in it, so it is restated here rather
 * than factored out across a boundary this package cannot cross.
 *
 * **The lookahead always rewinds here, where bind mode can sometimes skip that.** Bind mode
 * consumes the annotation run outright when no member would keep it -- most bindings treat a
 * value's leading annotations as framing and discard them, so consuming here is the same as
 * consuming one call later, and nothing is buffered. Tree mode has no such case: every node in
 * `tree/nodes.ts` carries its own `annotations`, so the variant's reader must see the run intact,
 * and it has to be rewound. Closing that would mean a `TypeReader` able to be handed annotations
 * already read, which is a change to the compiled reader contract rather than to this file.
 *
 * **Untagged recovery at a disjoint choice (§5.4).** When the choice is `disjoint`, a value MAY
 * omit its `!type-ref` and is then recovered from the encoding's own single form-resolution pass:
 * [TSON-DATA] §4 base type resolution for a token, plus the brace/bracket delimiter for a
 * container. This is the same discrimination-class partition `link/disjointness.ts` already
 * derives `disjoint` from -- `discriminationClassOf` is reused here, at construction time, to
 * build the `class -> variant` map this factory dispatches an untagged value through, rather than
 * a second, drifting classification of the schema. Classifying the *value's own peeked form* at
 * read time, below, is new work this module owns: the schema-side classification only says which
 * class each variant's declared type occupies, never what a document actually wrote.
 */
import type { Task } from '../io/bytes.js';
import type { SchemaLocation } from '../core/diagnostic.js';
import type { ReadContext, TypeReader } from '../reader/contracts.js';
import { lookingAhead } from '../reader/context.js';
import type { ChoiceBody } from '../schema/meta/bodies.js';
import type { TypeDefinition } from '../schema/meta/typedef.js';
import type { Value } from '../tree/nodes.js';
import { absentNode } from '../tree/nodes.js';
import { describeEvent, skipAnnotations, skipDataValue } from '../reader/tree/grammar.js';
import type { TreeTypeResolver } from '../reader/tree/support.js';
import { resolveBaseType, type BaseValue } from '../base/baseTypeResolver.js';
import { discriminationClassOf, type DiscriminationClass } from '../link/disjointness.js';
import type { TsonEvent } from '../stream/event.js';

/** [TSON-DATA] §4's fixed base-type order, mapped onto §5.4's own classes -- the token half of {@link classifyEvent}. */
const BASE_KIND_TO_CLASS: Record<BaseValue['kind'], DiscriminationClass> = {
  null: 'NULL',
  boolean: 'BOOLEAN',
  number: 'NUMBER',
  string: 'STRING',
};

/** §5.4's own lowercase spelling for each class, for a diagnostic naming the classes a choice admits. */
const CLASS_LABEL: Record<DiscriminationClass, string> = {
  NULL: 'null',
  BOOLEAN: 'boolean',
  NUMBER: 'number',
  STRING: 'string',
  BRACE: 'brace',
  BRACKET: 'bracket',
};

/** One lookahead's own verdict: either the value's own `!type-ref`, or the core-value event that starts where a type-ref would have been (for untagged classification). */
type Lookahead = { readonly typeRefName: string } | { readonly firstEvent: TsonEvent };

/**
 * The peeked event's own discrimination class ([TSON-DATA] §4 base type resolution for a token,
 * the brace/bracket delimiter for a container) -- or `undefined` for an event no class recovers
 * (the absent sentinel `_`: §5.4's classes partition *values*, and an omitted value has none to
 * classify). `empty-brace` (§2.8's `{}`) is `BRACE`: record and map share the class precisely
 * because `{}` cannot yet say which, and the dispatched variant's own reader resolves that the
 * same way it would for a tagged `!record {}` / `!map {}`.
 */
function classifyEvent(event: TsonEvent): DiscriminationClass | undefined {
  switch (event.kind) {
    case 'record-start':
    case 'map-start':
    case 'empty-brace':
      return 'BRACE';
    case 'array-start':
      return 'BRACKET';
    case 'token':
      return BASE_KIND_TO_CLASS[resolveBaseType({ text: event.text, form: event.form }).kind];
    default:
      return undefined;
  }
}

/** Builds a `choice` tree reader for one compiled schema entry. `resolveType` resolves every variant's own reader once, at construction. `disjoint` is `name`'s own `TypeDefinition.disjoint` (§5.4); `namespace` is the linked schema's merged entries, passed through only so a variant's discrimination class can be derived (`link/disjointness.ts`'s own `discriminationClassOf`) without a second copy of that logic. */
export function choiceTreeReader(
  name: string,
  displayName: string,
  body: ChoiceBody,
  resolveType: TreeTypeResolver,
  schemaLocation: SchemaLocation,
  disjoint: boolean,
  namespace: ReadonlyMap<string, TypeDefinition>,
): TypeReader<Value> {
  const variants = body.variants.map((variant) => ({
    name: variant.name,
    parser: resolveType(variant.name),
  }));
  const names = variants.map((variant) => variant.name).join(' | ');

  // Untagged recovery's own `class -> variant` map -- built only when `disjoint` says the classes
  // are distinct, and rebuilt from the classes themselves rather than trusted blindly: a
  // hand-assembled `TypeDefinition` could in principle carry `disjoint: true` over variants the
  // classes disagree with, and the safe reading of that disagreement is no recovery at all (mirrors
  // the reference implementation's own `ChoiceReader.untaggedRecovery`).
  let byClass: Map<DiscriminationClass, (typeof variants)[number]> | undefined;
  if (disjoint) {
    byClass = new Map();
    for (const variant of variants) {
      const variantClass = discriminationClassOf(variant.name, namespace);
      if (variantClass === undefined || byClass.has(variantClass)) {
        byClass = undefined;
        break;
      }
      byClass.set(variantClass, variant);
    }
  }
  const recovery = byClass;
  const classNames =
    recovery === undefined
      ? ''
      : Array.from(recovery.keys())
          .map((c) => CLASS_LABEL[c])
          .sort()
          .join(', ');

  return {
    *read(ctx: ReadContext): Task<Value> {
      const choiceCtx = ctx.underDeclaration(schemaLocation);
      // Looked ahead, never consumed: whichever variant's own reader runs next must see the
      // whole data-value -- its annotations, its type-ref, its core-value -- exactly as it would
      // if nothing had dispatched to it first. Mirrors `reader/bind.ts`'s own `readVariant`.
      const lookahead = yield* lookingAhead(choiceCtx, function* (aheadCtx): Task<Lookahead> {
        yield* skipAnnotations(aheadCtx);
        const peeked = yield* aheadCtx.peek();
        return peeked.kind === 'type-ref' ? { typeRefName: peeked.name } : { firstEvent: peeked };
      });

      if (!('typeRefName' in lookahead)) {
        // No tag. §5.4: recoverable only when this choice is disjoint, and only by the
        // encoding's own single form-resolution pass over the value actually written -- never a
        // second, type-directed inspection that tries each variant's own parser to see which
        // sticks.
        if (recovery === undefined) {
          choiceCtx.report(
            'UNKNOWN_TYPE_REF',
            `a '${displayName}' value needs its own !type-ref to say which member it is (${names})`,
            `a !type-ref naming one of (${names})`,
            '(none)',
          );
          yield* skipDataValue(choiceCtx);
          return absentNode();
        }
        const valueClass = classifyEvent(lookahead.firstEvent);
        const variant = valueClass === undefined ? undefined : recovery.get(valueClass);
        if (variant === undefined) {
          choiceCtx.report(
            'TYPE_MISMATCH',
            `'${displayName}' is untagged and admits (${classNames}); found ${describeEvent(lookahead.firstEvent)}, which matches none of them`,
            `one of (${classNames})`,
            describeEvent(lookahead.firstEvent),
          );
          yield* skipDataValue(choiceCtx);
          return absentNode();
        }
        return yield* variant.parser.read(choiceCtx);
      }

      const typeRefName = lookahead.typeRefName;
      const variant = variants.find((candidate) => candidate.name === typeRefName);
      if (variant === undefined) {
        choiceCtx.report(
          'UNKNOWN_TYPE_REF',
          `'!${typeRefName}' names no member of '${displayName}' (${names})`,
          `one of (${names})`,
          `!${typeRefName}`,
        );
        yield* skipDataValue(choiceCtx);
        return absentNode();
      }
      return yield* variant.parser.read(choiceCtx);
    },
  };
}
