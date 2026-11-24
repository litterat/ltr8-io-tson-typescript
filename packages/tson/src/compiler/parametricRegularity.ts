/**
 * §5.10.1's regularity boundary, checked where a parametric record is _declared_: within a parametric record's body,
 * a recursive application -- direct or mutual -- must pass each parameter through unchanged.
 *
 * **Growth is unwritable before this runs.** An argument is a name or a parameter (§5.3), so `weird => <T> { next?:
 * weird<box<T>> }` is refused where its field resolves, and every application a closing reaches draws its arguments
 * from the schema's finitely many names: each recursion repeats an application, which ties to the declaration closing
 * it or is refused where none does (`parametricMaterialiser.ts`). What this rule still refuses is a recursive
 * application that permutes the parameters (`swap => <A, B> { x?: swap<B, A> }`), duplicates one (`dup => <A, B> {
 * x?: dup<A, A> }`) or passes a name for one (`c => <T> { next?: c<text> }`), at the declaration, applied or not: with
 * it a cycle of heads is a cycle of applications, which is what lets `heldRecursion.ts` judge at the declaration from
 * the heads alone. It is §5.10.1's positional identity, deliberately stricter than termination requires.
 *
 * **Mutual recursion needs reachability, not just a self-edge.** Neither parametric record in an `a → b → a` cycle
 * applies itself, so an application is checked whenever its head can reach the declaration it sits in.
 *
 * Arity is _not_ checked here: the linker checks it over every application a parametric record writes. This compares
 * positionally only where the arity already matches.
 *
 * @module
 */
import { TsonSchemaValidationError } from '../core/errors.js';
import type { Top, TypeRef } from '../schema/meta/typedef.js';
import { typeParameters } from '../schema/meta/typedef.js';
import { applicationsOf } from '../schema/meta/typeInline.js';
import type { AncestryLookup } from './ancestry.js';
import { parametricHead } from './ancestry.js';

/** Where an irregular recursive application is reported, per declaration. */
export type IrregularityReporter = (declaration: string, error: TsonSchemaValidationError) => void;

/** One application written inside a parametric record's body: the head it applies and its arguments. */
interface Application {
  readonly head: string;
  readonly arguments: readonly TypeRef[];
}

/**
 * Checks every parametric record in `entries`, reporting each irregular application against the declaration that
 * wrote it; with no `reporter` the first failure throws. Returns the parametric records found irregular, for the
 * caller to replace before anything closes an application of one. An application's head is followed through
 * `lookup` -- the whole namespace -- to the parametric record it applies, an alias of one being applied as it is
 * (§8.3, §5.10), so `sw<B, A>` over `sw => swap` is judged as `swap<B, A>` is.
 */
export function check(
  entries: ReadonlyMap<string, Top>,
  lookup: AncestryLookup,
  reporter: IrregularityReporter | undefined,
): Set<string> {
  const irregular = new Set<string>();
  const applications = new Map<string, Application[]>();
  for (const [name, value] of entries) {
    if (typeParameters(value).length > 0) {
      applications.set(
        name,
        applicationsOf(value).map((application) => ({
          head: parametricHead(application.head.name, lookup),
          arguments: application.arguments,
        })),
      );
    }
  }
  for (const [name, written] of applications) {
    const parameters = typeParameters(entries.get(name));
    for (const application of written) {
      if (!reaches(application.head, name, applications)) continue;
      const problem = irregularity(name, parameters, application);
      if (problem === undefined) continue;
      const error = new TsonSchemaValidationError(problem);
      if (reporter === undefined) throw error;
      reporter(name, error);
      irregular.add(name);
    }
  }
  return irregular;
}

/**
 * The reason this recursive application is irregular, or `undefined` when it passes every parameter through
 * unchanged. An arity mismatch yields `undefined`: an arity error is a different verdict reported elsewhere.
 */
function irregularity(
  name: string,
  parameters: readonly string[],
  application: Application,
): string | undefined {
  if (application.arguments.length !== parameters.length) return undefined;
  for (let i = 0; i < parameters.length; i++) {
    const argument = application.arguments[i];
    const parameter = parameters[i];
    if (argument === undefined || parameter === undefined || argument.name === parameter) continue;
    return (
      `'${name}' applies '${application.head}' recursively but does not pass '${parameter}' through unchanged: ` +
      `argument ${String(i + 1)} is '${argument.name}'. A recursive application must be applied to the enclosing ` +
      "declaration's own parameters, in order (§5.10) -- otherwise the argument grows at every level and there " +
      'is no finite set of types to build'
    );
  }
  return undefined;
}

/** Whether `from` reaches `target` by applying parametric records, `from === target` included. */
function reaches(
  from: string,
  target: string,
  applications: ReadonlyMap<string, readonly Application[]>,
): boolean {
  const seen = new Set<string>();
  const pending = [from];
  for (let head = pending.pop(); head !== undefined; head = pending.pop()) {
    if (head === target) return true;
    if (seen.has(head)) continue;
    seen.add(head);
    for (const application of applications.get(head) ?? []) pending.push(application.head);
  }
  return false;
}
