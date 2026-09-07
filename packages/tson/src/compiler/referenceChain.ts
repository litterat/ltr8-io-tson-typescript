/**
 * Following a chain of `REFERENCE` entries to the type at the end of it -- [TSON-SCHEMA] §8.3's
 * walk, stated once.
 *
 * **Why this is a shared module rather than a loop each caller writes.** Resolved output states
 * the chain as the author wrote it: a use site naming an alias names the alias, and a processor
 * collapses the chain only when it actually needs the type at the end of it. That makes the walk
 * the only mechanism -- several passes need it: subsumption's own admissible-name set
 * (`subsumption.ts`), a choice variant's distinctness and its void check (`link/
 * referenceValidation.ts`), a field's stated value checked against its declared type
 * (`link/referenceValidation.ts`, §5.2), a discrimination class (`link/disjointness.ts`, §5.4),
 * and a constructor-application head (`definitionResolver.ts`'s `resolveConstructorTarget`,
 * §5.5). One decision lives inside it -- where the walk stops -- and a copy of the loop per
 * caller would be that decision restated per caller, free to drift.
 *
 * **The walk stops at three things**, and the second is the one worth knowing:
 * - an entry whose body is not a {@link Reference} -- the type at the end;
 * - an **argument-bearing** target, which is an application rather than a hop to another entry:
 *   there is no entry at the end of one until materialisation mints it (§5.10);
 * - a name the namespace does not declare, and a cycle. {@link terminal} answers both with the
 *   name it stopped at (an undeclared name may be a template parameter to its own caller, and a
 *   cycle's answer depends on where the walk began, so no false equality follows from it);
 *   {@link terminalDefinition} answers both with `undefined`, having been asked for an entry and
 *   having none to give.
 *
 * **Not every walk over references is this one.** A held body's own substitution (`templates.ts`)
 * follows a slot to its declared *vocabulary*, and deliberately does not stop at an argument-
 * bearing target -- it is after the constructor applied there, where the template is the answer.
 * It keeps its own loop, and this note exists so a future reader does not assume there were only
 * ever these five.
 */
import type { Reference, Top, TypeDefinition } from '../schema/meta/typedef.js';

/** A single-name lookup -- a finished `Map`'s `get`, or a namespace still being built one declaration at a time (`definitionResolver.ts`'s own `DefinitionGetter`). */
export type EntryLookup = (name: string) => TypeDefinition | undefined;

/** Where the walk stopped, and whether it stopped on a type rather than on nothing or on itself. */
interface Stop {
  readonly name: string;
  readonly reached: boolean;
}

// Matches `compile.ts`'s own `isReference` guard, which reads the same way for the same reason:
// a `Reference`-shaped body is REFERENCE-kind by derivation's own second branch
// (`schema/meta/typedef.ts`'s `typeKind`), with no further lookup needed to tell it apart from a
// `Data` body that merely happens to share the literal `'reference'` head.
function isReferenceBody(body: Top): body is Reference {
  return 'kind' in body && body.kind === 'reference';
}

function walk(name: string, entries: EntryLookup): Stop {
  const walked = new Set<string>();
  let current = name;
  while (!walked.has(current)) {
    walked.add(current);
    const definition = entries(current);
    if (definition === undefined) {
      return { name: current, reached: false };
    }
    const body = definition.body;
    if (isReferenceBody(body) && body.target.arguments.length === 0) {
      current = body.target.name;
      continue;
    }
    return { name: current, reached: true };
  }
  return { name: current, reached: false }; // a cycle has no terminal
}

/**
 * The name at the end of `name`'s reference chain -- `name` itself when it does not start one,
 * and the name the walk stopped at when it cannot reach a type (an undeclared name, or a cycle;
 * see this module's own top note).
 */
export function terminal(name: string, entries: EntryLookup): string {
  return walk(name, entries).name;
}

/** The entry at the end of `name`'s chain, or `undefined` where the walk reaches no type. */
export function terminalDefinition(name: string, entries: EntryLookup): TypeDefinition | undefined {
  const stop = walk(name, entries);
  return stop.reached ? entries(stop.name) : undefined;
}
