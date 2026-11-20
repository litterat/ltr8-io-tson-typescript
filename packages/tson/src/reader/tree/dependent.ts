/**
 * Tree mode's dependent-field reader, `v?: kind!` ([TSON-SCHEMA] §5.2): the value is read against the type
 * its sibling's value names in the same record instance. This is the declared-position dispatch by tag, the
 * tag taken from the sibling instead of from a `!` before the value, and it builds nothing of its own: the
 * named type's reader builds the value.
 *
 * **Read through its record, never on its own.** The record reader (`record.ts`) knows which sibling value
 * this instance holds -- written, defaulted or pinned -- and hands it to {@link DependentReader.readAgainst};
 * {@link DependentReader.read} is reached only where no record stands around the field, an invariant broken.
 *
 * **The sibling's value names a type a value can be read against**, or the value is not read: a parametric
 * record is no type until it is applied, an incomplete entry is no type at all, and a name reaching nothing
 * names nothing. Each is refused naming the
 * sibling, since that is the value the author has to change; the dependent value is skipped unjudged. The
 * rule is `link/dependentFields.ts`'s `typeNamed`, which a qualified name going on through a dependent field
 * is judged by too.
 */
import type { Task } from '../../io/bytes.js';
import { TsonInternalError } from '../../core/errors.js';
import type { RefBody } from '../../schema/meta/bodies.js';
import type { TypeRef } from '../../schema/meta/typedef.js';
import type { EntryLookup } from '../../link/aliasChain.js';
import { referenceIn, siblingNamesNoType, typeNamed } from '../../link/dependentFields.js';
import type { Value } from '../../tree/nodes.js';
import type { ReadContext, TypeReader } from '../contracts.js';
import { skipDataValue } from './grammar.js';

/** A dependent field's reader: the record that holds it hands it the reference its sibling names. */
export interface DependentReader extends TypeReader<Value> {
  readonly dependent: true;
  /** The field this reader's type is taken from. */
  readonly sibling: string;
  /**
   * The value at `ctx`'s cursor read against the type `named` names, `siblingCtx` being where a refusal of
   * the sibling's value is reported. `named` is `undefined` where the sibling's own read was refused, which
   * has been reported: the value is then skipped unjudged, and `undefined` returned.
   */
  readAgainst(
    ctx: ReadContext,
    named: TypeRef | undefined,
    siblingCtx: ReadContext,
  ): Task<Value | undefined>;
}

/** Whether `reader` is a {@link DependentReader}. */
export function isDependentReader(reader: TypeReader<Value>): reader is DependentReader {
  return (reader as Partial<DependentReader>).dependent === true;
}

/**
 * The reader of the dependent field `field` of the record `record`, typed by its sibling `sibling`.
 * `siblingType` is the reference typing the sibling, past its alias hops, which an application the sibling's
 * value writes resolves through; `entries` is the namespace the entry the value names is found in, and
 * `resolve` the reader of that entry.
 */
export function dependentFieldReader(
  record: string,
  field: string,
  sibling: string,
  siblingType: RefBody | undefined,
  entries: EntryLookup,
  resolve: (name: string) => TypeReader<Value>,
): DependentReader {
  return {
    dependent: true,
    sibling,
    read: (): Task<Value> => {
      throw new TsonInternalError(
        `the dependent field '${record}.${field}' is read through its record, which knows the value ` +
          `of its sibling '${sibling}'`,
      );
    },
    *readAgainst(ctx, named, siblingCtx): Task<Value | undefined> {
      if (named === undefined) {
        yield* skipDataValue(ctx);
        return undefined;
      }
      const typed = typeNamed(named, siblingType, entries);
      if (typed.kind === 'none') {
        const refusal = siblingNamesNoType(record, sibling, field, typed.held, named.name);
        siblingCtx.report(refusal.code, refusal.message, refusal.expected, refusal.found);
        yield* skipDataValue(ctx);
        return undefined;
      }
      return yield* resolve(typed.name).read(ctx);
    },
  };
}

/**
 * The reference a sibling's read produced: a reference position delivers its value as the canonical text,
 * which an atom node holds; `undefined` where the read produced nothing.
 */
export function referenceOfValue(value: Value | undefined): TypeRef | undefined {
  if (value?.kind !== 'atom' || typeof value.value !== 'string') {
    return undefined;
  }
  return referenceIn(value.value);
}
