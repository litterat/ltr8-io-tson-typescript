/**
 * The fields each entry restates over a source its closed chain does not reach ([TSON-SCHEMA] §5.8, §5.9), collected
 * for the linker to judge (`Schema.restatements`): the resolver cannot ask IS-A, the names a restated type holds
 * being ready only once every entry is.
 *
 * **A parametric record's restatements travel with its applications.** Its own hold its parameters, and every place
 * one of its applications becomes part of an entry -- absorbed at an operand, closed into a declaration, closed in
 * place at a slot -- makes them that entry's, substituted. So `wrap<text>`, over `wrap => <T> box<T> & { v: int32 }`,
 * is judged against `box<text>`'s `v` wherever it stands, whether or not a declaration names `box<text>`. The
 * transfers are settled to a fixed point once every entry has closed, since a parametric record gains restatements
 * from the applications materialisation closes inside it after another entry absorbed it.
 *
 * @module
 */
import { TsonNotImplementedError, TsonSchemaValidationError } from '../core/errors.js';
import type { RecordField } from '../schema/meta/bodies.js';
import type { Restatement, TypeExpr, TypeRef } from '../schema/meta/typedef.js';
import * as Substitution from './substitution.js';

/** The restatements of one resolution, and the applications that carry them from entry to entry. */
export interface Restatements {
  /** `restatement` is `entry`'s. */
  restates(entry: string, restatement: Restatement): void;
  /** An application of the parametric record `head`, bound by `bindings`, is in `entry`. */
  absorbs(entry: string | undefined, head: string, bindings: Substitution.Bindings): void;
  /**
   * Every entry's restatements, each transfer applied until none adds one, and then each type's applications closed by
   * `closing`. A restatement whose types do not close is dropped: the application is refused where it is written, and
   * a second verdict on it would name its consequence.
   */
  settled(closing: (type: TypeExpr) => TypeExpr): Map<string, Restatement[]>;
}

/** A store seeded with the imports' restatements, each schema's settled when it resolved. */
export function createRestatements(
  imported: ReadonlyMap<string, readonly Restatement[]>,
): Restatements {
  const held = new Map<string, Map<string, Restatement>>();
  const transfers = new Map<
    string,
    { entry: string; head: string; bindings: Substitution.Bindings }
  >();
  for (const [name, restatements] of imported) {
    held.set(
      name,
      new Map(restatements.map((restatement) => [identity(restatement), restatement])),
    );
  }

  const into = (entry: string): Map<string, Restatement> => {
    const known = held.get(entry);
    if (known !== undefined) return known;
    const fresh = new Map<string, Restatement>();
    held.set(entry, fresh);
    return fresh;
  };

  return {
    restates(entry, restatement): void {
      into(entry).set(identity(restatement), restatement);
    },
    absorbs(entry, head, bindings): void {
      if (entry === undefined || entry === head) return;
      const key = JSON.stringify([
        entry,
        head,
        ...[...bindings].map(([p, a]) => [p, a.name, a.param === true]),
      ]);
      transfers.set(key, { entry, head, bindings: new Map(bindings) });
    },
    settled(closing): Map<string, Restatement[]> {
      for (let changed = true; changed;) {
        changed = false;
        for (const transfer of transfers.values()) {
          const from = held.get(transfer.head);
          if (from === undefined) continue;
          const target = into(transfer.entry);
          for (const restatement of [...from.values()]) {
            const substituted = substitutedBy(restatement, transfer.bindings);
            const key = identity(substituted);
            if (!target.has(key)) {
              target.set(key, substituted);
              changed = true;
            }
          }
        }
      }
      const settled = new Map<string, Restatement[]>();
      for (const [name, restatements] of held) {
        const closed: Restatement[] = [];
        for (const restatement of restatements.values()) {
          try {
            closed.push({
              source: restatement.source,
              field: restatement.field,
              inherited: withType(restatement.inherited, closing(restatement.inherited.type)),
              restated: withType(restatement.restated, closing(restatement.restated.type)),
            });
          } catch (error: unknown) {
            if (!(
              error instanceof TsonSchemaValidationError || error instanceof TsonNotImplementedError
            ))
              throw error;
          }
        }
        settled.set(name, closed);
      }
      return settled;
    },
  };
}

function withType(field: RecordField, type: TypeExpr): RecordField {
  return type === field.type ? field : { ...field, type };
}

function substitutedBy(
  restatement: Restatement,
  bindings: ReadonlyMap<string, TypeRef>,
): Restatement {
  return {
    source: Substitution.type(restatement.source, bindings),
    field: restatement.field,
    inherited: withType(
      restatement.inherited,
      Substitution.type(restatement.inherited.type, bindings),
    ),
    restated: withType(
      restatement.restated,
      Substitution.type(restatement.restated.type, bindings),
    ),
  };
}

/** A restatement's identity as a string, for the set each entry's are held in. */
function identity(restatement: Restatement): string {
  return JSON.stringify(restatement, (key, value: unknown) => {
    if (key === 'annotations') return undefined;
    if (typeof value === 'bigint') return `${value.toString()}n`;
    if (value instanceof Map) return [...(value as Map<unknown, unknown>).entries()];
    return value;
  });
}
