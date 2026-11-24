/**
 * Tree mode's leaf readers -- the port of `AtomTypeReader` (the bridge from one {@link AtomType} to a
 * soft-failing `TsonTypeReader`) and `AtomTreeReader` (which wraps that bridge to yield an
 * {@link AtomNode}). Two functions rather than two classes: `atomTypeReader` reads one token through a
 * known {@link AtomType} and reports/soft-fails on a shape or constraint problem; `atomTreeReader` wraps
 * that to produce a tree node, capturing this value's own leading annotations first.
 *
 * A soft failure is `undefined`, never a thrown error -- {@link AtomType.read} still throws for its own
 * two exception shapes, and this is where they are caught and turned into a diagnostic instead, so a
 * collecting read keeps going past a bad atom exactly as it does past any other problem (`CLAUDE.md`'s
 * "collecting mode always keeps reading").
 */
import type { Task } from '../../io/bytes.js';
import { TsonAtomTypeError } from '../../core/errors.js';
import { diagnosticCodeForAtomError } from '../../core/diagnostic.js';
import type { AtomType } from '../../atom/contract.js';
import type { ReadContext, TypeReader } from '../contracts.js';
import type { AtomValue, Value } from '../../tree/nodes.js';
import { atomNode } from '../../tree/nodes.js';
import { captureAnnotations } from './annotations.js';
import { describeEvent, skipAnnotationsAndTypeRef, skipCoreValue } from './grammar.js';
import { abandonedValue } from './support.js';

/**
 * Reads one token through `atomType`, consuming this value's own `annotation* type-ref?` framing first
 * (discarded -- a caller wrapping this, e.g. {@link atomTreeReader}, captures the annotations itself
 * before delegating, so this framing pass is a no-op by the time it runs; see this directory's own
 * hoisting note in `annotations.ts`). Reports and returns `undefined` rather than throwing when the
 * core-value isn't a token at all, or when `atomType.read` rejects the token's shape or value.
 *
 * `refuses`, when given, judges the value `atomType` read and answers whether the processor
 * declines it -- reporting the refusal itself -- as an identifier family's value is judged under
 * the name-hygiene policy (§8.2). A refused value yields `undefined`, like any other soft failure.
 */
export function atomTypeReader<T>(
  atomType: AtomType<T>,
  displayName: string,
  refuses?: (ctx: ReadContext, value: T) => boolean,
): TypeReader<T | undefined> {
  return {
    *read(ctx: ReadContext): Task<T | undefined> {
      yield* skipAnnotationsAndTypeRef(ctx);
      // Peek, not next: on a mismatch the whole core-value has to be discarded, and skipCoreValue
      // consumes the opening event itself. Consuming it here and returning left every enclosing
      // reader positioned inside a container it never entered — a desynchronised cursor, which in
      // collecting mode turns one diagnostic into a cascade of unrelated ones.
      const e = yield* ctx.peek();
      if (e.kind !== 'token') {
        ctx.report(
          'TYPE_MISMATCH',
          `'${displayName}' expects a scalar value`,
          `a scalar for '${displayName}'`,
          describeEvent(e),
        );
        yield* skipCoreValue(ctx);
        return undefined;
      }
      yield* ctx.next();
      try {
        const value = atomType.read({ text: e.text, form: e.form });
        // A value the processor declines under its name-hygiene policy (§8.2) is no value of the
        // document: it has already been reported, apart from §8.1's four categories.
        return refuses?.(ctx, value) === true ? undefined : value;
      } catch (error) {
        if (error instanceof TsonAtomTypeError) {
          ctx.report(diagnosticCodeForAtomError(error), error.message, error.expected, e.text);
          return undefined;
        }
        throw error;
      }
    },
  };
}

/**
 * Wraps `delegate` -- ordinarily {@link atomTypeReader} -- so it yields a {@link Value} instead of a
 * bare host value: an {@link AtomNode} carrying the value and this leaf's declared type-ref, or the
 * construction-guard placeholder ({@link abandonedValue}) when the delegate reported anything (a
 * soft-failed read, per this module's own top note -- the diagnostic already carries the real
 * problem, and tree mode is all-or-nothing at every leaf, not only every container). This is
 * how every atom position produces a node uniformly, so a container reader's children are always
 * nodes and an atom read at the root is a node too.
 */
export function atomTreeReader<T extends AtomValue>(
  delegate: TypeReader<T | undefined>,
  typeRef: string,
): TypeReader<Value> {
  return {
    *read(ctx: ReadContext): Task<Value> {
      const annotations = yield* captureAnnotations(ctx);
      const mark = ctx.reported();
      const value = yield* delegate.read(ctx);
      if (value === undefined || ctx.reported() > mark) {
        return abandonedValue();
      }
      return atomNode(value, typeRef, annotations);
    },
  };
}
