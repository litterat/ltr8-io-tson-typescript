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
 */
import type { Task } from '../io/bytes.js';
import type { SchemaLocation } from '../core/diagnostic.js';
import type { ReadContext, TypeReader } from '../reader/contracts.js';
import { lookingAhead } from '../reader/context.js';
import type { ChoiceBody } from '../schema/meta/bodies.js';
import type { Value } from '../tree/nodes.js';
import { absentNode } from '../tree/nodes.js';
import { skipAnnotations, skipDataValue } from '../reader/tree/grammar.js';
import type { TreeTypeResolver } from '../reader/tree/support.js';

/** Builds a `choice` tree reader for one compiled schema entry. `resolveType` resolves every variant's own reader once, at construction. */
export function choiceTreeReader(
  name: string,
  displayName: string,
  body: ChoiceBody,
  resolveType: TreeTypeResolver,
  schemaLocation: SchemaLocation,
): TypeReader<Value> {
  const variants = body.variants.map((variant) => ({
    name: variant.name,
    parser: resolveType(variant.name),
  }));
  const names = variants.map((variant) => variant.name).join(' | ');

  return {
    *read(ctx: ReadContext): Task<Value> {
      const choiceCtx = ctx.underDeclaration(schemaLocation);
      // Looked ahead, never consumed: whichever variant's own reader runs next must see the
      // whole data-value -- its annotations, its type-ref, its core-value -- exactly as it would
      // if nothing had dispatched to it first. Mirrors `reader/bind.ts`'s own `readVariant`.
      const typeRefName = yield* lookingAhead(choiceCtx, function* (aheadCtx): Task<
        string | undefined
      > {
        yield* skipAnnotations(aheadCtx);
        const peeked = yield* aheadCtx.peek();
        return peeked.kind === 'type-ref' ? peeked.name : undefined;
      });
      if (typeRefName === undefined) {
        choiceCtx.report(
          'UNKNOWN_TYPE_REF',
          `a '${displayName}' value needs its own !type-ref to say which member it is (${names})`,
          `a !type-ref naming one of (${names})`,
          '(none)',
        );
        yield* skipDataValue(choiceCtx);
        return absentNode();
      }
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
