/**
 * §5.10 materialisation: closes the applications a resolved schema holds, over the resolved form, not the AST. An
 * application reaches here as a `meta.apply` written in place, so closing is a walk over `schema/meta` values
 * (`schema/meta/typeSlots.ts`).
 *
 * **Every application here applies a parametric record** ([TSON-SCHEMA] §5.10, §5.3), or a head nothing names: a
 * constructor's application is its construction before anything reads it (`constructionRewrite.ts`), so
 * `meta.array<text>` arrives as the construction `[text]` is. `page<order>` substitutes: the record's parameters are
 * replaced by the arguments on the model and each application at a slot of a field's type closed in turn
 * ({@link closeParametricRecord}). An application held inside a parametric record, `box<T>` at a field or in
 * `[box<T>]`, closes the same way once the record holding it is applied and its parameter substituted.
 *
 * **Nothing is minted.** A declaration naming an application of a parametric record, `page_order => page<order>`, is
 * the record under that name with the application recorded (`closeApplicationInto`, `@meta.application`, §8.2). At a
 * type slot -- of a closed record, or left by substitution in another record's body -- an application closes in
 * place to the substituted record, `{ of: !meta.record { … } }`: no name, no chain, nothing recorded, and never looked
 * up to a declaration ({@link instantiate}). The one nested application that names a declaration is the one a
 * declaration is closing itself: `next: node<text>` inside `node_text => node<text>` names `node_text`, so a
 * recursion, direct or through records in place, ties to the declaration it closes (§5.10.1). Two applications are
 * refused: one that would put in place a member of a declared type (`k: dog_of<text>` over `dog_of => <T> pet & { …
 * }`, §5.2), and a recursive one with no declaration closing it (`f: node<text>`, §5.10.1).
 *
 * **Where a name is required** -- an argument of an application, a map's key, a reference's `of`, an alias's target
 * -- an application closes nowhere: a construction and an application of a parametric record are each refused there,
 * and declared under a name first ([TSON-SCHEMA] §4.2, §5.3).
 *
 * @module
 */
import { TsonNotImplementedError, TsonSchemaValidationError } from '../core/errors.js';
import type { RecordBody } from '../schema/meta/bodies.js';
import { mapFields } from '../schema/meta/bodies.js';
import type {
  ApplyBody,
  Param,
  Top,
  TypeExpr,
  TypeInline,
  TypeRef,
} from '../schema/meta/typedef.js';
import {
  applyText,
  EMPTY_CHAIN,
  isParametric,
  parametersOf,
  supertypesOf,
  typeParameters,
  withChain,
} from '../schema/meta/typedef.js';
import { metaName } from '../schema/meta/kernel.js';
import { parameterIn } from '../schema/meta/typeInline.js';
import * as TypeSlots from '../schema/meta/typeSlots.js';
import { terminal } from '../link/aliasChain.js';
import { sealedExtern, terminalExtern } from '../link/externs.js';
import { isAThroughHops, type ExternHops } from '../link/externHops.js';
import * as Ancestry from './ancestry.js';
import * as CanonicalApplication from './canonicalApplication.js';
import * as Substitution from './substitution.js';
import type { HeldRecursion } from './heldRecursion.js';
import type { Restatements } from './restatements.js';
import type { DefinitionGetter, EntryFactsTable } from './resolverTypes.js';

/** The constructor a parametric record's applications are built with. */
const RECORD = metaName('record');

/** Where an application this pass cannot close is reported, entry by entry. */
export type MaterialisationFailureReporter = (
  entryName: string,
  error: TsonSchemaValidationError | TsonNotImplementedError,
) => void;

/** Where a deferred check's failure is reported, against the declaration whose resolution asked for it. */
export type DeferredFailureReporter = (
  declaration: string,
  error: TsonSchemaValidationError,
) => void;

/** What one resolution's materialiser is built over. */
export interface MaterialiserDeps {
  /**
   * Every entry visible to this schema -- local declarations and merged `!!import`s alike. A getter rather than a
   * fixed map, because an application closed on demand during resolution (a declaration naming one) may name a head
   * that has not been resolved yet: asking for it resolves it, with the wait-cycle guard still in front.
   */
  readonly namespace: DefinitionGetter;
  /** The facts of every entry this pass closes into a declaration -- the constructor its value applies. Shared. */
  readonly facts: EntryFactsTable;
  /**
   * The canonical application each declaration this pass closes an application into records, by entry name (§8.2) --
   * shared with `schemaResolver.ts`, which keys the applied-parent fold on it.
   */
  readonly applications: Map<string, ApplyBody>;
  /** Which parametric records are refused at their own declaration for a recursion they hold (§5.10.1). */
  readonly heldRecursion: HeldRecursion;
  /** The local declaration being made ready, innermost, or `undefined` once every one is. */
  readonly resolving: () => string | undefined;
  /** Where each application closed is recorded as part of the entry holding it. */
  readonly restatements: Restatements;
  /** The placeholder a refused parametric record leaves: an empty record keeping its parameters. */
  readonly placeholder: (parameters: readonly string[]) => Top;
  /**
   * How many applications may close in place one inside another before the declaration is refused: the
   * configurable nesting-depth limit on types written in place that [TSON-SCHEMA] §5.2 permits, in the manner of
   * [TSON-DATA] §9.1, so a chain of applications as deep as the schema's entries ends as a verdict at its
   * declaration rather than exhausting the host's stack.
   */
  readonly maxNestingDepth: number;
  /**
   * The namespace's hops through its externs, asked once every declaration is ready: an argument or a bound naming
   * an extern is judged at the entry it lands on, by identity (§5.10, §5.13). Absent, a name is judged as written.
   */
  readonly hops?: () => ExternHops;
}

/** One resolution's materialiser: the on-demand half resolution asks, and the whole-schema pass after it. */
export interface ParametricMaterialiser {
  /**
   * The entry a declaration naming a fully-bound application **is** (§8.2): the parametric record's application
   * closed into `declaredName`, its key recording the application. `undefined` for an unresolved head, a head taking
   * no parameters, or an arity mismatch, each the ordinary path's to report.
   */
  closeApplicationInto(declaredName: string, application: ApplyBody): Top | undefined;
  /**
   * §5.10's call-site check: each argument must name a type that IS-A the bound of the parameter it binds. A check
   * asked for while a declaration is being made ready is deferred to {@link checkDeferred}, so judging an argument
   * never makes the declaration wait on it (§3.4.1).
   */
  checkArguments(head: string, record: Top, args: readonly TypeRef[]): void;
  /** Runs every check deferred while declarations were made ready, one verdict per declaration. */
  checkDeferred(reporter: DeferredFailureReporter): void;
  /**
   * Closes every application reachable from `entries`, rewritten in place, and reports one this pass cannot close
   * against the entry that wrote it, which is left as it was. With no `reporter` the first failure throws.
   */
  materialise(
    entries: Map<string, Top>,
    reporter: MaterialisationFailureReporter | undefined,
  ): void;
  /** `type` with each application in it closed in place, as {@link materialise} closes a closed body's. */
  closedInPlace(type: TypeExpr): TypeExpr;
  /** The application `name`'s entry closes, as written, where it is a declared application. */
  writtenApplication(name: string): ApplyBody | undefined;
}

/** One deferred argument check: the declaration it answers to, the head and the arguments. */
interface DeferredCheck {
  readonly declaration: string;
  readonly head: string;
  readonly args: readonly TypeRef[];
}

/**
 * A record closed in place, kept for the next application of the same canonical key in the same context
 * ({@link MemoFrame}): the closed record, the deepest nesting of closings it holds, and every canonical key its
 * closing looked up.
 */
interface Memoised {
  readonly inline: TypeInline;
  readonly height: number;
  readonly reached: ReadonlySet<string>;
}

/** What one closing in place under way has seen so far: the keys it reached and the deepest closing beneath it. */
interface MemoFrame {
  readonly reached: Set<string>;
  height: number;
}

/** One deferred applied-parent membership check (§5.2), judged once every declaration has closed. */
interface DeferredMembership {
  readonly declaration: string;
  readonly head: RecordBody;
  readonly bindings: Substitution.Bindings;
  readonly written: ApplyBody;
}

export function createParametricMaterialiser(deps: MaterialiserDeps): ParametricMaterialiser {
  const { namespace, facts, applications, heldRecursion, resolving, restatements } = deps;
  /** The declaration each application being closed into one is closing into, by canonical application key. */
  const closingInto = new Map<string, string>();
  /** Each application closing in place, by canonical key, against the application as written; a stack. */
  const closingInPlace = new Map<string, ApplyBody>();
  /** The application each declaration naming one closes into it, as written: `@meta.application`. */
  const writtenApplications = new Map<string, ApplyBody>();
  const deferred: DeferredCheck[] = [];
  const deferredKeys = new Set<string>();
  const deferredMemberships: DeferredMembership[] = [];
  /** The entry {@link materialise} is closing applications in, or `undefined` outside that pass. */
  let materialising: string | undefined;
  /**
   * Each record closed in place, by context and canonical key ({@link memoKey}). Closing in place is a pure function
   * of the application, the namespace and the declarations closing applications around it, so a second application of
   * one key in one context is the first one's record; without this a record applying the next twice doubles the work
   * at every level. Cleared wherever the namespace a closing reads changes under it.
   */
  const memo = new Map<string, Memoised>();
  /** The closings in place under way, innermost last, each collecting what its memo entry records. */
  const frames: MemoFrame[] = [];
  const { maxNestingDepth } = deps;

  /**
   * The context a record closed in place is memoised in: the entry its restatements and deferred checks answer to,
   * whether those checks are deferred or immediate, and the declarations closing applications around it, which a
   * recursion inside it ties to.
   */
  function memoKey(key: string): string {
    const declaration = resolving();
    return JSON.stringify([
      declaration === undefined ? 'materialising' : 'resolving',
      declaration ?? materialising ?? '',
      [...closingInto],
      key,
    ]);
  }

  /** Records, in the closing in place enclosing this one, that it reached `reached` and holds `height` closings. */
  function reported(reached: Iterable<string>, height: number): void {
    const parent = frames.at(-1);
    if (parent === undefined) return;
    for (const key of reached) parent.reached.add(key);
    parent.height = Math.max(parent.height, height);
  }

  /** The verdict on an application that would close in place one level past {@link maxNestingDepth}. */
  function tooDeep(): TsonSchemaValidationError {
    const outermost = closingInPlace.values().next().value;
    const where = outermost === undefined ? 'an application' : `'${applyText(outermost)}'`;
    return new TsonSchemaValidationError(
      `closing ${where} in place nests applications of parametric records more than ` +
        `${String(maxNestingDepth)} deep, past the configured nesting-depth limit on types written in place ` +
        '(§5.2, [TSON-DATA] §9.1): declare an application along the chain under a name and write that name ' +
        'where it is used',
    );
  }

  /** The parametric record an application's head names, past its alias hops. */
  const parametricHead = (head: string): string => Ancestry.parametricHead(head, namespace);

  /**
   * A type argument named by its own type rather than by a name for it: a bare reference is replaced with the entry
   * at the end of its chain. An alias is a pure rename, so an application of one denotes the same type (§8.2); a
   * refinement or a fresh type is an entry of its own and is not dereferenced.
   */
  function dereferenced(ref: TypeRef): TypeRef {
    if (ref.param === true) return ref;
    const end = terminal(ref.name, namespace);
    return end === ref.name ? ref : { name: end, annotations: [] };
  }

  /** Whether `head`, past its alias hops, is a parametric record. */
  function appliesAParametricRecord(head: string): boolean {
    return isParametric(namespace(terminal(head, namespace)));
  }

  /** The arguments of `application` past their alias hops; a name naming a parametric record is refused (§5.10). */
  function argumentsOf(application: ApplyBody): TypeRef[] {
    return application.arguments.map((name) => {
      if (name.param !== true && appliesAParametricRecord(name.name)) {
        throw new TsonSchemaValidationError(
          `'${name.name}', passed as an argument of '${applyText(application)}', is a parametric record, and no ` +
            'position names a parametric record bare -- write it with its arguments, declared under a name, and ' +
            'pass that name (§5.10)',
        );
      }
      return dereferenced(name);
    });
  }

  /**
   * `record`, or its placeholder where the parametric record is refused at its own declaration for a recursion it
   * holds: the refusal is reported there once (§5.10.1).
   */
  function closable(head: string, record: Top | undefined): Top | undefined {
    return isParametric(record) && heldRecursion.refusedLocally(head)
      ? deps.placeholder(typeParameters(record))
      : record;
  }

  function closeApplicationInto(declaredName: string, application: ApplyBody): Top | undefined {
    const head = parametricHead(application.head.name);
    const record = closable(head, namespace(head));
    if (record?.kind !== 'record' || !isParametric(record)) return undefined;
    const parameters = typeParameters(record);
    if (parameters.length !== application.arguments.length) return undefined;
    // §8.2 keys an instantiation on the canonical application -- arguments compared after following alias chains.
    const args = argumentsOf(application);
    checkArguments(head, record, args);
    const canonical = CanonicalApplication.of(head, args);
    const key = CanonicalApplication.key(canonical);
    if (closingInto.has(key)) return undefined;
    closingInto.set(key, declaredName);
    try {
      const known = facts.get(declaredName) ?? {};
      facts.set(declaredName, { ...known, head: RECORD });
      const bindings = bind(parameters, args);
      restatements.absorbs(declaredName, head, bindings);
      const closed = closeParametricRecord(record, bindings);
      applications.set(declaredName, canonical);
      writtenApplications.set(declaredName, asWritten(application));
      return closed;
    } finally {
      closingInto.delete(key);
    }
  }

  /** An application of a parametric record at a slot, left written in place where its head names nothing to close. */
  function closeApplicationOfRecord(application: ApplyBody): TypeExpr {
    const args = argumentsOf(application);
    const closed = instantiate(parametricHead(application.head.name), args, application);
    return (
      closed ?? { kind: 'inline', head: metaName('apply'), of: { ...application, arguments: args } }
    );
  }

  /** A walk that closes each application written in place where it stands. */
  function closing(close: (application: ApplyBody) => TypeExpr): TypeSlots.Rewrite {
    return {
      atName: (reference) => reference,
      atInPlace: (inline) => (inline.of.kind === 'apply' ? close(inline.of) : inline),
    };
  }

  /** What `materialise` applies to a closed body: each application written in place closed where it stands. */
  const slotRewrite = (): TypeSlots.Rewrite => closing(closeApplicationOfRecord);

  /**
   * What `materialise` applies inside a parametric record: an application naming none of its parameters means the
   * same thing in every application, so it is closed now; one over a parameter stays written in place.
   */
  const parametricRewrite = (): TypeSlots.Rewrite =>
    closing((application) =>
      parameterIn({ kind: 'inline', head: metaName('apply'), of: application }) === undefined
        ? closeApplicationOfRecord(application)
        : { kind: 'inline', head: metaName('apply'), of: application },
    );

  /**
   * What a fully-bound application of a parametric record at a type slot closes to (§5.10): the declaration closing
   * this very application, where one is (a recursion, §5.10.1), and otherwise the substituted record in place, with
   * no name, no chain and no application recorded. `undefined` where the head names nothing in scope -- the linker's
   * verdict as an unresolved reference -- or an argument is a parameter, substitution closing it later.
   */
  function instantiate(
    head: string,
    args: readonly TypeRef[],
    written: ApplyBody,
  ): TypeExpr | undefined {
    const record = closable(head, namespace(head));
    if (record === undefined) return undefined;
    const parameters = typeParameters(record);
    const extern = terminalExtern(head, namespace);
    if (parameters.length === 0 && extern !== undefined) {
      throw sealedExtern(
        `'${head}<...>'`,
        `'${head}<...>' applies`,
        head,
        terminal(head, namespace),
        extern,
      );
    }
    if (parameters.length === 0) {
      throw new TsonSchemaValidationError(
        `'${head}' declares no type parameters, so '${head}<...>' applies arguments to something that takes ` +
          'none (§5.10); drop the argument list',
      );
    }
    if (parameters.length !== args.length) {
      throw new TsonSchemaValidationError(
        `'${head}' takes ${String(parameters.length)} type argument${parameters.length === 1 ? '' : 's'} ` +
          `[${parameters.join(', ')}], but ${String(args.length)} ${args.length === 1 ? 'was' : 'were'} ` +
          'applied (§5.10)',
      );
    }
    if (args.some((argument) => argument.param === true)) return undefined;
    const body = record as RecordBody;
    checkArguments(head, body, args);
    const canonical = CanonicalApplication.of(head, args);
    const key = CanonicalApplication.key(canonical);
    const owner = closingInto.get(key);
    // The declaration closing this application reached it again while substituting: the recursion names it.
    if (owner !== undefined) {
      reported([key], 0);
      return { name: owner, annotations: [] };
    }
    const bindings = bind(parameters, args);
    refuseMembership(body, bindings, written);
    const repeated = closingInPlace.get(key);
    if (repeated !== undefined) {
      throw new TsonSchemaValidationError(
        `'${applyText(repeated)}' applies the recursive parametric record '${head}' where no declaration is ` +
          `closing it, so its recursion has nothing to tie to (§5.10.1): declare it ('${suggestedName(repeated)} ` +
          `=> ${applyText(repeated)}') and write that name where it is used`,
      );
    }
    restatements.absorbs(resolving() ?? materialising, head, bindings);
    const context = memoKey(key);
    const known = memo.get(context);
    // A record closed in this context before is reused where nothing it reached is being closed around it now, and
    // its own nesting still fits under the closings standing here: the verdict a second closing would reach.
    if (
      known !== undefined &&
      ![...closingInPlace.keys()].some((open) => known.reached.has(open))
    ) {
      if (closingInPlace.size + known.height > maxNestingDepth) throw tooDeep();
      reported([key, ...known.reached], known.height);
      return known.inline.application === written
        ? known.inline
        : { ...known.inline, application: written };
    }
    if (closingInPlace.size >= maxNestingDepth) throw tooDeep();
    closingInPlace.set(key, written);
    const frame: MemoFrame = { reached: new Set([key]), height: 0 };
    frames.push(frame);
    try {
      const closed = closeParametricRecord(body, bindings);
      const inline: TypeInline = {
        kind: 'inline',
        head: RECORD,
        of: withChain(closed, EMPTY_CHAIN),
        application: written,
      };
      const height = frame.height + 1;
      memo.set(context, { inline, height, reached: frame.reached });
      frames.pop();
      reported(frame.reached, height);
      return inline;
    } finally {
      if (frames.at(-1) === frame) frames.pop();
      closingInPlace.delete(key);
    }
  }

  /**
   * Refuses an application that would close in place to a member of a declared type (§5.2): one whose head reaches
   * a declared type through its written parents, or whose applied parent, substituted, is an application a
   * declaration names. The second is judged once every declaration has closed where this runs while declarations are
   * being made ready.
   */
  function refuseMembership(
    record: RecordBody,
    bindings: Substitution.Bindings,
    written: ApplyBody,
  ): void {
    const member = supertypesOf(record)[0];
    if (member !== undefined) throw notAMember(written, member);
    const declaration = resolving();
    if (declaration !== undefined) {
      deferredMemberships.push({ declaration, head: record, bindings, written });
      return;
    }
    refuseAppliedMembership(record, bindings, written);
  }

  /** The applied-parent half of {@link refuseMembership}. */
  function refuseAppliedMembership(
    record: RecordBody,
    bindings: Substitution.Bindings,
    written: ApplyBody,
  ): void {
    for (const parent of Substitution.parents(record, bindings)) {
      if (parent.kind !== 'inline' || parent.of.kind !== 'apply') continue;
      const applied = parent.of;
      const canonical = CanonicalApplication.key(
        CanonicalApplication.of(
          parametricHead(applied.head.name),
          applied.arguments.map(dereferenced),
        ),
      );
      for (const [entry, application] of applications) {
        if (CanonicalApplication.key(application) === canonical) throw notAMember(written, entry);
      }
    }
  }

  /**
   * A parametric record applied: its fields and parents substituted on the model, each field's type closed -- every
   * application at a slot of it closed now that the parameter is bound -- and the record's own facts kept as written:
   * its `extension`, `discriminators`, groups and name type, so an abstract parametric record's application is an
   * abstract record (§5.10). The chain is computed after substitution, from the parents as written: a parent applied
   * to the record's own parameter stays in `parents` for the resolver's fold. The result has no `parameters`.
   */
  function closeParametricRecord(record: RecordBody, bindings: Substitution.Bindings): RecordBody {
    const close = slotRewrite();
    const fields = mapFields(Substitution.fields(record, bindings), (field) => {
      const type = TypeSlots.map(field.type, close);
      return type === field.type ? field : { ...field, type };
    });
    const { parameters: _parameters, chain: _chain, ...rest } = record;
    void _parameters;
    void _chain;
    const closed: RecordBody = { ...rest, fields };
    return withChain(closed, Ancestry.chainOf(Substitution.parents(record, bindings), namespace));
  }

  /** `application` as `@meta.application` states it: its head as written, each argument past its alias hops. */
  function asWritten(application: ApplyBody): ApplyBody {
    return {
      kind: 'apply',
      head: { name: application.head.name, annotations: [] },
      arguments: application.arguments.map(dereferenced),
    };
  }

  function checkArguments(head: string, record: Top, args: readonly TypeRef[]): void {
    const declaration = resolving();
    if (declaration !== undefined) {
      // A parameter and an entry spelled alike are two arguments, as they are two `meta.type_ref` values.
      const key = JSON.stringify([
        declaration,
        head,
        ...args.map((argument) => [argument.name, argument.param === true]),
      ]);
      if (!deferredKeys.has(key)) {
        deferredKeys.add(key);
        deferred.push({ declaration, head, args: [...args] });
      }
      return;
    }
    checkBounds(head, record, args);
  }

  /** Each argument against the bound of the parameter it binds (§5.10); a name nothing declares is the linker's. */
  function checkBounds(head: string, record: Top | undefined, args: readonly TypeRef[]): void {
    const parameters = parametersOf(record);
    if (!isParametric(record) || parameters.length !== args.length) return;
    parameters.forEach((parameter: Param, index) => {
      const argument = args[index];
      if (parameter.bound !== undefined && argument !== undefined && argument.param !== true) {
        checkBound(head, parameter, argument.name, parameter.bound.name);
      }
    });
  }

  function checkBound(head: string, parameter: Param, argument: string, bound: string): void {
    const end = terminal(argument, namespace);
    const target = namespace(end);
    if (target === undefined) return; // an unresolved argument -- the linker's verdict
    const boundEnd = terminal(bound, namespace);
    const chain = supertypesOf(target);
    const admitted =
      end === boundEnd ||
      chain.includes(boundEnd) ||
      chain.includes(bound) ||
      (deps.hops !== undefined && isAThroughHops(argument, bound, namespace, deps.hops()));
    if (!admitted) {
      throw new TsonSchemaValidationError(
        `'${head}<...>' binds '${parameter.name}' to '${argument}', which is not a type that IS-A ${bound} -- ` +
          `'${head}' declares '${parameter.name}: ${bound}' (§5.10)`,
      );
    }
  }

  return {
    closeApplicationInto,
    checkArguments,
    checkDeferred(reporter: DeferredFailureReporter): void {
      memo.clear();
      const refused = new Set<string>();
      for (const check of deferredMemberships) {
        try {
          refuseAppliedMembership(check.head, check.bindings, check.written);
        } catch (error: unknown) {
          if (!(error instanceof TsonSchemaValidationError)) throw error;
          if (!refused.has(check.declaration)) {
            refused.add(check.declaration);
            reporter(check.declaration, error);
          }
        }
      }
      deferredMemberships.length = 0;
      for (const check of deferred) {
        const record = namespace(check.head);
        if (refused.has(check.declaration) || !isParametric(record)) continue;
        try {
          checkBounds(check.head, record, check.args);
        } catch (error: unknown) {
          if (!(error instanceof TsonSchemaValidationError)) throw error;
          refused.add(check.declaration);
          reporter(check.declaration, error);
        }
      }
      deferred.length = 0;
      deferredKeys.clear();
    },
    materialise(
      entries: Map<string, Top>,
      reporter: MaterialisationFailureReporter | undefined,
    ): void {
      memo.clear();
      for (const [name, value] of entries) {
        materialising = name;
        try {
          entries.set(
            name,
            value.kind === 'record' && isParametric(value)
              ? TypeSlots.mapBody(value, parametricRewrite())
              : TypeSlots.mapBody(value, slotRewrite()),
          );
        } catch (error: unknown) {
          if (!(
            error instanceof TsonSchemaValidationError || error instanceof TsonNotImplementedError
          ))
            throw error;
          if (reporter === undefined) throw error;
          // Reported against the entry that wrote the application, and left as it was.
          reporter(name, error);
        }
      }
      materialising = undefined;
      memo.clear();
    },
    closedInPlace: (type) => TypeSlots.map(type, slotRewrite()),
    writtenApplication: (name) => writtenApplications.get(name),
  };
}

/** Each parameter of the applied signature against the argument applied for it, in order. */
function bind(parameters: readonly string[], args: readonly TypeRef[]): Map<string, TypeRef> {
  const bindings = new Map<string, TypeRef>();
  parameters.forEach((parameter, index) => {
    const argument = args[index];
    if (argument !== undefined) bindings.set(parameter, argument);
  });
  return bindings;
}

function notAMember(written: ApplyBody, member: string): TsonSchemaValidationError {
  return new TsonSchemaValidationError(
    `'${applyText(written)}' would close in place to a record IS-A '${member}', a member of a declared type that ` +
      'no declaration names, and a member is read, tagged and bound by its name (§5.2): declare it ' +
      `('${suggestedName(written)} => ${applyText(written)}') and write that name where it is used`,
  );
}

/**
 * A name for a declaration of `application`, for a message: the head, then each argument, as [TSON-SCHEMA] §5.10.1
 * writes `node_text => node<text>`.
 */
export function suggestedName(application: Pick<ApplyBody, 'head' | 'arguments'>): string {
  const last = (name: string): string => name.slice(name.lastIndexOf('.') + 1);
  return [application.head, ...application.arguments].map((ref) => last(ref.name)).join('_');
}
