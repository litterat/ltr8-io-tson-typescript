/**
 * §5.10 materialisation: closes a template application by substituting its arguments into the
 * template's recorded open form, and replaces the application with a reference to the entry that
 * results. Ported from the reference implementation's `TemplateMaterialiser`
 * (`tson-compiler/.../resolver/TemplateMaterialiser.java`) — the other half of §5.10 from
 * `definitionResolver.ts` (14a), which resolves one declaration; this module closes the
 * applications a whole schema's worth of declarations write once every one of them has resolved.
 *
 * **It runs over the resolved form, not the AST.** An application reaches here as a
 * `schema/meta` {@link TypeRef} carrying `arguments` — the one thing that shape means, a closed
 * form always being an entry named by a bare reference — so substitution is a walk over
 * `schema/meta` values, and the entry it mints can record its own `source`, which §8.2 keys
 * identity on.
 *
 * **A held body closes by one process, whatever wrote it.** `<T> [T]` and `<T> { x: T }` are both
 * an application with a parameter standing in a slot, so both substitute by the same walk
 * ({@link substitute}, `templateSubstitution.ts`) and are read back through their own
 * constructor's reader. What the result *is* then splits three ways:
 *
 * - **A record template's closure is the instantiation entry itself**
 *   ({@link closeHeldInstantiation}), declared or not: a substituted record is the type the
 *   author named by writing the application, so there is nothing for a synthetic hop to buy
 *   (§5.10, §8.2).
 * - **Every other author-written template's closure depends on who is asking.** A *declaration*
 *   naming a fully-bound application ({@link TemplateMaterialiser.closeApplicationAs}) is that
 *   application's entry too, whatever it applies, exactly like a record — "nothing minted beside
 *   it and no `!reference` hop" (§5.10's last paragraph, §8.2, §8.3). A *use site* with no owning
 *   declaration ({@link instantiate}, reached through {@link close}) has no author-given name to
 *   carry that identity, so it keeps §8.2's older two-entry shape instead: the substituted body
 *   closes to a *synthetic* named for its content — mergeable with an identical form written
 *   directly elsewhere — and the use site's own instantiation entry is a `!reference` to it, kept
 *   distinct so two applications that happen to close to the same content still get their own
 *   entries ({@link closeHeldTemplate}, {@link instantiationOf}).
 * - **A compiler-generated form** — desugar's own lift of a sugar shape (`[T]`'s own `<T> [T]`),
 *   never an author-written template — has no author-given name at all, so closing it produces
 *   only the content-keyed synthetic, with no instantiation entry wrapping it.
 *
 * **An alias closes by a fourth path and mints nothing.** §5.10's partial application,
 * `uuid_pair => <B> pair<uuid, B>`, holds `!reference { target: pair<uuid, B> }` like any other
 * open entry, but it *is* the application it names with some arguments still open — so closing it
 * composes the two argument lists and hands back what that denotes, minting no entry of its own
 * (§5.10: "no intermediate entry per alias hop"). See {@link closeHeldAlias}.
 *
 * **So the cases are told apart by the constructor head and by provenance, not by the body's
 * shape.** Every open entry's body is a `HeldBody` (`heldBody.ts`) — a record, composition or
 * refinement template, a sugar form's lift, an alias, and an error placeholder alike. `reference`
 * closes to a name; a generated head always closes to a synthetic; a record head always closes to
 * the instantiation; everything else closes to the instantiation only when a declaration owns it,
 * and to a synthetic-plus-reference pair otherwise.
 *
 * **Identity (§8.2).** An instantiation entry is keyed on the application recorded in `source`, so
 * two `box<text>` anywhere land on one entry — and, since §8.2's identity follows a *reference*
 * argument to its terminal entry (§8.3), `box<user_id>` over `user_id => uuid` lands on that same
 * entry too ({@link canonicalArgs}, this module's own WP4.8). The derived name is built by
 * `derivedName.ts`'s own `ofApplication`, called only after `canonicalArgs` has walked every bare
 * reference argument through `deps.namespaceDefinitions` to its chain's terminal — so the name is
 * a function of the head and the argument list's *resolved* identities, not of the spelling the
 * author wrote, which is what makes the dedup fall out of naming rather than needing a second
 * table: the same application derives the same name whichever declaration happens to reach it
 * first, and an aliased spelling of one derives it too. `mintedNames.ts`'s own instance below
 * decides §8.2's freshness MUST over every name this materialiser mints.
 *
 * **Knot-tying.** The memo entry is registered *before* the body is substituted, so a recursive
 * application reached during substitution (`tree<T>` inside `tree`, which becomes `tree<text>`
 * once `T` is bound) finds the entry under construction and references it by name rather than
 * recursing forever.
 *
 * **The depth backstop is [TSON-SCHEMA] §11.5's materialisation-depth limit.** §5.10.1's own
 * static check — that a recursive application must pass every parameter through unchanged, so a
 * well-formed schema's recursion always ties the knot on its first repeat — is a separate, later
 * pass over the *resolved* entries before any of them are closed (the Java's `TemplateRegularity`,
 * a later work package's own file here). What this module carries instead is the guard the Java
 * documents as a **backstop, not the rule**: `MAX_CLOSING_DEPTH` bounds how many nested
 * instantiations one `close` chain may open before materialisation gives up -- exactly §11.5's own
 * "nested open synthetics closed for one application", at its own default of 64. Ported for its
 * semantics, not its mechanism — a fixed depth counter over a `Set` of in-progress entry names,
 * checked after each new link is added — so that a hole in the earlier static check (or, in this
 * port, simply not having reached that later work package yet) fails as a limit refusal
 * (`core/limits.ts`'s own `materialisationDepthLimitRefusal`) naming the outermost application and
 * the chain that grew rather than repeated, a caller can report, never as a host stack overflow.
 */
import {
  TsonAtomParseError,
  TsonAtomValidationError,
  TsonInternalError,
  TsonLimitRefusedError,
  TsonNotImplementedError,
  TsonReadError,
  TsonSchemaValidationError,
} from '../core/errors.js';
import { DEFAULT_MAX_MATERIALISATION_DEPTH, MATERIALISATION_DEPTH_LIMIT } from '../core/limits.js';
import type { CoreValue, DataValue, RecordField, TokenValue } from '../ast/value.js';
import type { Token, TypeArgument, TypeDefinition, TypeRef, Top } from '../schema/meta/typedef.js';
import { isDataBody } from '../link/bodyKind.js';
import { isTemplateBody, typeParameters } from '../schema/meta/typedef.js';
import type { RecordBody } from '../schema/meta/bodies.js';
import { checkAtomCoherence, isAtom } from './atomChecks.js';
import { canonicalApplication, canonicalBinding, ofApplication, ofBinding } from './derivedName.js';
import { createMintedNames, type MintedNames } from './mintedNames.js';
import { field, isApplication, rescope, typeRefOf } from './wireForm.js';
import type { HeldBody } from './heldBody.js';
import { substitute } from './templateSubstitution.js';
import { inferOne, kindOf, readsInStructure, type Kind } from './parameterTypes.js';
import { terminal } from '../link/referenceChain.js';
import { atomParserFor, isScalarBody } from '../atom/forType.js';
import { enumLabelForm } from '../link/enumLabels.js';
import { lexerFormOfMeta } from './tokenForms.js';
import type { DefinitionGetter, DefinitionMetaReader } from './resolverTypes.js';

// ── Public surface ───────────────────────────────────────────────────────────────────────────

/**
 * Every dependency {@link createTemplateMaterialiser} needs beyond the applications it is asked
 * to close.
 */
export interface TemplateMaterialiserDeps {
  /**
   * Every entry visible to this schema — local declarations and merged `!!import`s alike. A
   * getter rather than a fixed map, because an application closed on demand during resolution (at
   * a supertype or refinement source, `definitionResolver.ts`'s own `ApplicationCloser`) may name
   * a head that has not been resolved yet; the getter is the caller's own growing map, so asking
   * for it resolves it first.
   */
  readonly namespaceDefinitions: DefinitionGetter;

  /**
   * Where each entry this materialiser mints is published as it is built, so the namespace can
   * see it immediately. Load-bearing for the on-demand half: a composition supertype closes an
   * application and then looks the resulting name up through {@link namespaceDefinitions} to
   * absorb its fields, which is the very next thing that happens — an entry only in this
   * materialiser's own memo would be invisible to it.
   */
  readonly publish: (name: string, definition: TypeDefinition) => void;

  /**
   * How a closed held body becomes an ordinary constructor body — the constructor's own compiled
   * reader, the same one a written `!array { ... }` or `!record { ... }` binds through. Using it
   * is what makes `min_items: "two"` an ordinary read error rather than a check this module would
   * have to grow.
   *
   * **Needed for every held shape except a reference template** — record templates included:
   * `closeHeldInstantiation` calls the same shared `closeHeld` every other held form does, so a
   * record's own substituted field set is bound through the `record` constructor's reader too,
   * not merely assumed well-formed. (The Java reference's own Javadoc on the equivalent field
   * claims a record template "needs none of this and is unaffected" — its own `closeHeld` method
   * calls the reader unconditionally, so that line does not describe the code beside it; this
   * port follows the code.) Only {@link closeHeldAlias}'s composition path never touches this
   * dependency, since a reference template mints no body to bind.
   *
   * Omitted for a caller with no compiled meta reader to offer — a hand-built test that never
   * closes a template application at all, or one built to check only the reference-composition
   * path. Closing any other held body then fails loudly ({@link TsonNotImplementedError}) instead
   * of silently producing an entry with an unread body.
   */
  readonly definitionMetaReader?: DefinitionMetaReader;

  /**
   * The entry names desugaring generated rather than the author writing them (`desugar.ts`'s own
   * `lifted`). An application of one is machinery, not a use site: closing an authored template
   * records the application in an instantiation entry, because `grid<pixel, 3>` is something
   * someone wrote and §8.2 keys identity on it. Closing a generated open synthetic records
   * nothing — nobody wrote `array_p0_p1_06c4e11f<pixel, 3>`, and an entry named for it would key
   * identity on an internal name §8.2 says must not be relied on. Omitted means "none", the
   * ordinary case for a hand-built test.
   */
  readonly generatedNames?: ReadonlySet<string>;

  /**
   * The governing meta's own entries — where a slot's declared type is read from when
   * classifying a template's parameters by use (§5.10, `parameterTypes.ts`). Needed only for the
   * *on-demand* half of that classification: an application closed during resolution's own
   * driving loop (a composition supertype or a refinement source, before the batch pass in
   * `setParameterKinds` has run) infers its one template's kinds in isolation, memoised per head
   * since a template is typically applied more than once.
   *
   * Omitted means no parameter-kind classification is available for an on-demand closing: its
   * arguments close exactly as §12.1's own token-shape rule classified them at parse time,
   * unreclassified. A caller that also never calls {@link TemplateMaterialiser.setParameterKinds}
   * gets that behaviour throughout — the ordinary shape for a hand-built test.
   */
  readonly metaTypes?: DefinitionGetter;

  /**
   * The local declaration resolution is inside, or `undefined` outside resolution — who an early
   * argument check answers to ({@link TemplateMaterialiser.recheckEarly}).
   */
  readonly resolving?: () => string | undefined;
}

/** Where an application this pass cannot close is reported, entry by entry. */
export interface MaterialisationFailureReporter {
  reportFailedApplication(entryName: string, error: TsonSchemaValidationError): void;
}

/**
 * What {@link TemplateMaterialiser.materialise} hands back: `entries` is the caller's own map,
 * every application inside it closed to a bare reference; `materialised` is every entry this
 * pass minted to do that (instantiations and synthetics alike, in the order they were first
 * built); `synthetics` is the subset of `materialised`'s keys that are synthetic rather than
 * instantiation entries (§8.2 — see {@link TemplateMaterialiser.syntheticNames}).
 *
 * `materialised`/`synthetics` are separate from `entries` because the caller decides where the
 * new entries land — they are local to this schema and carry no source position, being named by
 * derivation rather than declared.
 */
export interface MaterialiseResult {
  readonly entries: ReadonlyMap<string, TypeDefinition>;
  readonly materialised: ReadonlyMap<string, TypeDefinition>;
  readonly synthetics: ReadonlySet<string>;
}

export interface TemplateMaterialiser {
  /**
   * The entry a fully-bound application denotes, closing it if this is the first sight of it —
   * the on-demand half, reached from a supertype or refinement-source position during resolution
   * rather than from the batch pass afterwards (`definitionResolver.ts`'s own
   * `ApplicationCloser`). Shares this instance's own memo with {@link materialise}, so an
   * application closed here and the same one met later in a field land on one entry.
   */
  closeApplication(application: TypeRef): string;

  /**
   * The argument check of {@link closeApplication} for an application that denotes no entry — a
   * composition operand (§5.8) — so a bound or a value type holds there as it does at a field.
   * Throws the same `TsonSchemaValidationError`; does nothing for a head that is not a template
   * or an arity that does not match, which the position reports.
   */
  checkApplication(application: TypeRef): void;

  /**
   * §8.2's "a declaration whose body denotes a type is that type's entry": closes `application`
   * (as {@link closeApplication} would) but publishes the result under `name` — the declaration's
   * own name — instead of a content-derived one, and registers `name` so every *other* occurrence
   * of the identical canonical application, reached generically through {@link closeApplication}
   * or {@link materialise}'s own walk, resolves to `name` too rather than minting a second entry
   * beside it (§5.10, §8.2: "a use-site application resolves to a declaration that owns it where
   * one exists").
   *
   * Returns `undefined`, doing nothing, when `application`'s head is not a template at all, when
   * its arity does not match (left for the ordinary path to diagnose), or when the template is
   * **reference**-headed (§5.10's partial application composes away and mints nothing — there is
   * no entry for a declared name to own): the caller falls back to its own, ordinary handling for
   * those cases.
   *
   * **Never deduplicates against another declared name.** Two declarations naming one application
   * are two entries, neither privileged (§8.2) — so this always builds a fresh entry under `name`,
   * even when `application`'s canonical identity was already claimed by an earlier declared name;
   * only the *first* such claim is what a later generic (undeclared) use site resolves to.
   */
  closeApplicationAs(name: string, application: TypeRef): TypeDefinition | undefined;

  /**
   * Closes every application reachable from `entries`, returning the rewritten entries alongside
   * everything this pass minted to do it. Only a *closed* entry is scanned — one whose own
   * `parameters` is empty — since a template's own body is open (`chain<T>` inside `chain` awaits
   * substitution and is not an application to close); closing those would mint an entry per
   * level, keyed on the literal parameter name.
   *
   * Failures report per entry, through `reporter` when one is given (two bad applications in one
   * schema are both reported against their own declarations rather than the first aborting the
   * run) — omit it to let the first `TsonSchemaValidationError` propagate.
   */
  materialise(
    entries: ReadonlyMap<string, TypeDefinition>,
    reporter?: MaterialisationFailureReporter,
  ): MaterialiseResult;

  /**
   * The subset of every entry this materialiser has minted so far (on-demand closures included)
   * that is a *synthetic* entry, whose key carries the derived `@synthetic` marker (§8.2).
   * Everything else this instance has minted is an instantiation entry, which deliberately
   * carries none.
   */
  syntheticNames(): ReadonlySet<string>;

  /**
   * Supplies §5.10's parameter kinds for the whole namespace, once `schemaResolver.ts`'s own
   * batch pass (`parameterTypes.ts`'s `inferAll`) has computed them — every declaration has
   * resolved, so every slot's declared type is available, and nothing has closed yet. An
   * application closed *before* this is called (the on-demand half, reached from a composition
   * supertype or refinement source during resolution's own driving loop) classifies its own
   * template in isolation instead, through {@link TemplateMaterialiserDeps.metaTypes} — see this
   * module's own `byParameterKind`.
   */
  setParameterKinds(kinds: ReadonlyMap<string, ReadonlyMap<string, Kind>>): void;

  /**
   * Replays every argument check that could not be judged before the parameters were stamped
   * (§5.10). An application closed during resolution — a declaration naming it, a composition
   * operand, a refinement source, or an argument nested in one — meets a local template whose
   * parameters carry no written or inherited bound yet. One verdict per declaration: the first
   * failing application of each is reported, against the declaration whose resolution closed it.
   */
  recheckEarly(report: (declaration: string, error: TsonSchemaValidationError) => void): void;

  /**
   * The name `head`'s binding record derives once every application inside `fields` is closed —
   * `syntheticMerge.ts`'s own question, over the exact fields an eagerly lifted synthetic's
   * declaration wrote. Reads this materialiser's own memo (every application in `fields` must
   * already have been closed by {@link materialise} for this to answer correctly), so this is
   * meaningless to call before that pass has run.
   */
  closedFormName(head: string, fields: readonly RecordField[]): string;
}

/**
 * How deep the closing chain may go before materialisation is abandoned — a backstop, not the
 * rule, and [TSON-SCHEMA] §11.5's own "materialisation depth" limit at its own default. See this
 * module's own doc for why this stays even once §5.10.1's static check lands elsewhere.
 */
const MAX_CLOSING_DEPTH = DEFAULT_MAX_MATERIALISATION_DEPTH;

/** The constructor a held record template carries — its closure is the instantiation itself. */
const RECORD_HEAD = 'record';

/** The constructor a held alias carries — §5.10's partial application, which mints no entry. */
const REFERENCE_HEAD = 'reference';

export function createTemplateMaterialiser(deps: TemplateMaterialiserDeps): TemplateMaterialiser {
  /** The entries produced, keyed by their derived internal name, in creation order. */
  const materialised = new Map<string, TypeDefinition>();

  /** Which of {@link materialised} are synthetic entries rather than instantiation entries. */
  const synthetics = new Set<string>();

  /** Applications currently being closed — the knot-tying memo and the depth guard's chain. */
  const closing = new Set<string>();

  /**
   * Applications of *reference* templates currently composing. They mint no entry of their own,
   * so {@link closing}'s knot-tying answer — name the entry under construction — has nothing to
   * name for them, and an alias that applies itself would hand back a name nothing ever defines.
   * Tracked separately so that case is a diagnosis instead.
   */
  const aliasClosing = new Set<string>();

  /** The author-written head each link of {@link closing} came from, outermost first. */
  const heads: string[] = [];

  const generated = deps.generatedNames ?? new Set<string>();

  /**
   * §8.2's freshness MUST over the names this materialiser mints, one instance for this whole
   * materialisation phase — see `mintedNames.ts`'s own doc on why one phase gets exactly one
   * instance, never one shared with `desugar.ts`'s own.
   */
  const minted: MintedNames = createMintedNames();

  /**
   * A canonical application's identity key (what {@link instantiate} would otherwise derive as its
   * own published name, via `ofApplication`) to the **declared** name that owns it (§8.2) —
   * populated by {@link closeApplicationAs}, consulted by {@link instantiate} so a generic use site
   * reaching the identical application resolves to the declaration that named it rather than
   * minting a content-derived twin beside it. Only the first declared owner of one identity is
   * recorded; a second declaration naming the same application still gets its own entry (this
   * module's own top note on {@link TemplateMaterialiser.closeApplicationAs}), just not this slot.
   */
  const owners = new Map<string, string>();

  /**
   * §5.10's parameter kinds, by entry name then parameter name — empty until
   * {@link TemplateMaterialiser.setParameterKinds} supplies `schemaResolver.ts`'s own batch
   * pass's result. An application closed before that point classifies as it always did.
   */
  let parameterKinds: ReadonlyMap<string, ReadonlyMap<string, Kind>> = new Map();

  /** Whether {@link TemplateMaterialiser.setParameterKinds} has run, after which every check sees stamped parameters. */
  let stamped = false;

  /**
   * The applications closed during resolution, whose argument checks wait for stamped parameters
   * ({@link TemplateMaterialiser.recheckEarly}), in the order they were met.
   */
  const early: { declaration: string; head: string; args: readonly TypeArgument[] }[] = [];

  /**
   * The same question answered one template at a time, for an application closed before the
   * batch pass could run — a composition supertype or a refinement source, both of which close
   * during resolution's own driving loop. Memoised because a template is typically applied more
   * than once.
   */
  const kindsOnDemand = new Map<string, ReadonlyMap<string, Kind>>();

  /** The first few links of the closing chain, for the depth guard's own message. */
  function chain(): string {
    const shown = [...closing].slice(0, 4);
    return shown.join(' -> ') + (closing.size > shown.length ? ' -> ...' : '');
  }

  /**
   * The arguments reclassified by the kind of the parameter each binds (§5.10).
   *
   * §12.1 decides an argument's channel by the shape of the token that spells it, so an unquoted
   * non-numeric argument always arrives as a reference. That is the right default with nothing
   * else known, but once a parameter's kind is inferred, the position is known before
   * substitution rather than after: `e<c>` against `e => <M> !enum { members: [a b M] }` records
   * `value: c`, so nothing downstream asks the namespace for a type called `c`.
   *
   * Only a bare reference converts — one carrying arguments is an application, which no value
   * parameter could bind (§5.10 confines value parameters to scalars), and is left for the
   * position to refuse.
   */
  function byParameterKind(
    head: string,
    template: TypeDefinition,
    parameters: readonly string[],
    args: readonly TypeArgument[],
  ): readonly TypeArgument[] {
    if (!stamped) {
      const declaration = deps.resolving?.();
      if (declaration !== undefined) {
        early.push({ declaration, head, args });
      }
      return classify(head, template, parameters, args);
    }
    const classified = classify(head, template, parameters, args);
    checkArguments(head, template, classified);
    return classified;
  }

  function classify(
    head: string,
    template: TypeDefinition,
    parameters: readonly string[],
    args: readonly TypeArgument[],
  ): readonly TypeArgument[] {
    let kinds = parameterKinds.get(head);
    if (kinds === undefined) {
      if (deps.metaTypes === undefined) {
        return args; // no batch pass and nothing to infer with on demand -- classify as parsed
      }
      let onDemand = kindsOnDemand.get(head);
      if (onDemand === undefined) {
        onDemand = inferOne(template, deps.metaTypes);
        kindsOnDemand.set(head, onDemand);
      }
      kinds = onDemand;
    }
    if (kinds.size === 0) {
      return args;
    }
    return args.map((argument, i): TypeArgument => {
      const parameter = parameters[i];
      if (
        argument.kind === 'ref' &&
        argument.ref.arguments.length === 0 &&
        parameter !== undefined &&
        kinds.get(parameter) === 'VALUE'
      ) {
        return { kind: 'value', value: { text: argument.ref.name, form: 'UNQUOTED' } };
      }
      return argument;
    });
  }

  /**
   * `args` with every reference argument's chain followed to its terminal entry (§8.2, §8.3) --
   * what makes `box<user_id>` over `user_id => uuid` denote the same type as `box<uuid>` and mint
   * the same entry, a reference being the same type under another name. Only a *bare* reference
   * argument is a hop to follow: one still carrying its own arguments is an application, which
   * {@link close} has already resolved to its own entry's bare name (or left unresolved for the
   * linker to report) before `instantiate` ever sees it, so there is no further hop to take here.
   * A refinement or a fresh instance never reaches this as a bare reference at all -- desugaring
   * lifts each to its own synthetic entry first, and a synthetic's body is never a `Reference`, so
   * {@link terminal} stops on it immediately and returns it unchanged, keeping its own identity
   * exactly as §8.2's table says a refinement and a fresh instance do. A value argument's own
   * equivalence is `derivedName.ts`'s concern, untouched here.
   *
   * Applied once, to the same `args` that go on to name the application, hash it, bind its
   * template's parameters, and record the minted entry's own `source` -- so `source` states the
   * canonical application (§8.1's own "`source` is structured provenance"), and the body a
   * canonicalised bind substitutes is the same recomputation an ingesting reader would perform
   * from that `source`.
   */
  function canonicalArgs(args: readonly TypeArgument[]): readonly TypeArgument[] {
    return args.map((argument) => {
      if (argument.kind !== 'ref' || argument.ref.arguments.length > 0) {
        return argument;
      }
      const name = terminal(argument.ref.name, deps.namespaceDefinitions);
      return name === argument.ref.name
        ? argument
        : { kind: 'ref', ref: { name, arguments: [], annotations: argument.ref.annotations } };
    });
  }

  /** A name in the schema's namespace first, then in the governing meta's: a slot type is the meta's. */
  function lookup(name: string): TypeDefinition | undefined {
    return deps.namespaceDefinitions(name) ?? deps.metaTypes?.(name);
  }

  /**
   * Each argument against the parameter it binds (`template_param`, §5.10): a type argument must
   * name a type that IS-A the parameter's `bound`, and a value argument must be a value of the
   * parameter's `type` (or of the type an earlier parameter's argument names, where the type is
   * that parameter). What makes a wrong argument a verdict at the application, wherever it stands,
   * rather than inside a substituted body where it would read as an ordinary field.
   *
   * An argument this cannot judge is left to the position after substitution: an application as an
   * argument (its entry is not closed yet), a name nothing declares (the linker's verdict), and a
   * parameter whose type has no scalar reading.
   */
  function checkArguments(
    head: string,
    template: TypeDefinition,
    args: readonly TypeArgument[],
  ): void {
    if (!isTemplateBody(template.body) || template.body.parameters.length !== args.length) {
      return;
    }
    const parameters = template.body.parameters;
    parameters.forEach((parameter, i) => {
      const argument = args[i];
      if (argument === undefined) return;
      if (kindOf(parameter.type) === 'TYPE') {
        if (
          parameter.bound !== undefined &&
          argument.kind === 'ref' &&
          argument.ref.arguments.length === 0
        ) {
          checkBound(head, parameter.name, argument.ref.name, parameter.bound.name);
        }
      } else if (argument.kind === 'value') {
        checkValue(
          head,
          parameter.name,
          argument.value,
          valueType(parameters, args, parameter.type.name),
          readsInStructure(template, (n) => deps.namespaceDefinitions(n)),
        );
      }
    });
  }

  function checkBound(head: string, parameter: string, argument: string, bound: string): void {
    const argumentTerminal = terminal(argument, lookup);
    const target = lookup(argumentTerminal);
    if (target === undefined) {
      return; // an unresolved argument -- the linker's verdict
    }
    // By name, so a core type and the kernel original it copies are one bound, as they are at the declaration.
    const boundTerminal = terminal(bound, lookup);
    const admitted =
      argumentTerminal === boundTerminal ||
      target.supertypes.includes(boundTerminal) ||
      target.supertypes.includes(bound);
    if (!admitted) {
      throw new TsonSchemaValidationError(
        `'${head}<...>' binds '${parameter}' to '${argument}', which is not a type that IS-A ${bound} -- ` +
          `'${head}' declares '${parameter}: ${bound}' (§5.10)`,
      );
    }
  }

  /** The type a value parameter's argument is read as, following a type that names an earlier parameter. */
  function valueType(
    parameters: readonly { readonly name: string }[],
    args: readonly TypeArgument[],
    type: string,
  ): string | undefined {
    const index = parameters.findIndex((p) => p.name === type);
    if (index < 0) return type;
    const named = args[index];
    return named?.kind === 'ref' && named.ref.arguments.length === 0 ? named.ref.name : undefined;
  }

  /**
   * `argument` as a value of `type`, read in the structure namespace where the template applies a
   * meta constructor ({@link readsInStructure}) -- so a schema's own entry under a meta type's name
   * never stands in for the type the constructor's slot declares -- and in the schema's otherwise.
   */
  function checkValue(
    head: string,
    parameter: string,
    argument: Token,
    type: string | undefined,
    structural: boolean,
  ): void {
    if (type === undefined) return;
    const resolve: DefinitionGetter = structural ? (n) => deps.metaTypes?.(n) : (n) => lookup(n);
    const name = terminal(type, resolve);
    const definition = resolve(name);
    const body = definition?.body;
    if (
      body === undefined ||
      !('kind' in body) ||
      isDataBody(body) ||
      body.kind === 'reference' ||
      !isScalarBody(body)
    ) {
      return; // no scalar reading -- the substituted body's own position judges it
    }
    // An enum matches in its label type's form (§7.4, §5.5), so `Content-Type` binds to the member
    // written `content-type` under a case-folding type.
    const form =
      definition === undefined
        ? 'NONE'
        : enumLabelForm(
            definition,
            (n) => deps.namespaceDefinitions(n) ?? deps.metaTypes?.(n),
            deps.metaTypes,
          );
    const parser = atomParserFor(name, body, form);
    if (parser === undefined) return;
    try {
      parser.read({ text: argument.text, form: lexerFormOfMeta(argument.form) });
    } catch (e: unknown) {
      if (!(e instanceof TsonAtomParseError || e instanceof TsonAtomValidationError)) throw e;
      throw new TsonSchemaValidationError(
        `'${head}<...>' binds '${parameter}' to '${argument.text}', which is not a value of ${type}: ` +
          `${e.message} (§5.10)`,
      );
    }
  }

  /** Each parameter of the applied signature against the argument applied for it, in order. */
  function bind(
    parameters: readonly string[],
    args: readonly TypeArgument[],
  ): ReadonlyMap<string, TypeArgument> {
    const bindings = new Map<string, TypeArgument>();
    parameters.forEach((parameter, i) => {
      const argument = args[i];
      if (argument === undefined) {
        throw new TsonInternalError(
          `bind: '${parameter}' has no argument at index ${String(i)} -- arity was already checked equal`,
        );
      }
      bindings.set(parameter, argument);
    });
    return bindings;
  }

  /**
   * One type-ref with its application closed, or itself when it carries no arguments. Arguments
   * close first, so `box<box<text>>` produces the inner entry before the outer one names it.
   *
   * An application this pass cannot close **keeps its argument list**, rather than collapsing to
   * its bare head — the list is the evidence the author supplied arguments, and the linker
   * reports on what it is handed. A name the type-name namespace does not hold is an unresolved
   * reference, applied or not; that verdict is the linker's, not this pass's to guess at.
   */
  function close(ref: TypeRef): TypeRef {
    if (ref.arguments.length === 0) {
      return ref;
    }
    const args: TypeArgument[] = ref.arguments.map((argument) =>
      argument.kind === 'ref' ? { kind: 'ref', ref: close(argument.ref) } : argument,
    );
    const entry = instantiate(ref.name, args);
    return entry === undefined
      ? { name: ref.name, arguments: args, annotations: ref.annotations }
      : { name: entry, arguments: [], annotations: [] };
  }

  /**
   * The entry name a fully-bound application denotes, creating the entry on first sight, or
   * `undefined` when the head names nothing in scope.
   */
  function instantiate(head: string, rawArgs: readonly TypeArgument[]): string | undefined {
    const template = deps.namespaceDefinitions(head);
    if (template === undefined) {
      return undefined; // unresolved head -- the linker's verdict, not this pass's
    }
    const parameters = typeParameters(template);
    if (parameters.length === 0) {
      throw new TsonSchemaValidationError(
        `'${head}' declares no type parameters, so '${head}<...>' applies arguments to something that ` +
          'takes none (§5.10); drop the argument list',
      );
    }
    if (parameters.length !== rawArgs.length) {
      throw new TsonSchemaValidationError(
        `'${head}' takes ${String(parameters.length)} type argument${parameters.length === 1 ? '' : 's'} ` +
          `(${parameters.join(', ')}), but ${String(rawArgs.length)} ${rawArgs.length === 1 ? 'was' : 'were'} ` +
          'applied (§5.10)',
      );
    }
    // §5.10's parameter kinds, applied before the application is named: a bare reference bound to
    // a VALUE parameter reclassifies to a literal here, so the name and every downstream `source`
    // record what the parameter always meant rather than what the argument's own token shape
    // suggested at parse time. Chain-following (§8.2) applies after that reclassification, over
    // only what is left a reference by it -- see `canonicalArgs`'s own doc on why the order
    // matters.
    const args = canonicalArgs(byParameterKind(head, template, parameters, rawArgs));
    const identityKey = ofApplication(head, args);
    // §8.2: "a use-site application resolves to a declaration that owns it where one exists" --
    // `owners` is populated by `closeApplicationAs`, ahead of any generic occurrence reaching the
    // identical canonical application through this path.
    const name = owners.get(identityKey) ?? identityKey;
    if (aliasClosing.has(name)) {
      throw new TsonSchemaValidationError(
        `'${head}<...>' is a reference template whose own body applies it again, so composing it never ` +
          `reaches a type with a body (§5.10). The chain begins ${chain()}. A reference template must ` +
          'eventually name a declared type; recursion belongs in a record, tuple or choice body, where a ' +
          'field can carry it',
      );
    }
    // §8.2's freshness MUST, decided rather than assumed -- covers both branches below, since
    // either an application closed here for the first time or one already built/under
    // construction must be *this* application, not another that happens to derive the same name.
    minted.claim(name, canonicalApplication(head, args));
    if (materialised.has(name) || closing.has(name)) {
      return name; // already built, or under construction -- the knot-tying case
    }
    closing.add(name);
    if (closing.size > MAX_CLOSING_DEPTH) {
      closing.delete(name);
      // Named for the *outermost* head, which is the one the author wrote; the head in hand here
      // is whichever link happened to tip the depth over. A limit refusal ([TSON-SCHEMA] §11.5),
      // not a resolver error: the application may tie its own knot eventually (arguments growing
      // rather than repeating looks identical to this deployment's own bound from the inside), and
      // §8.1's fifth outcome is what names that distinction rather than reporting the schema itself
      // as malformed.
      throw new TsonLimitRefusedError(
        `'${heads[0] ?? head}<...>' does not close: materialising it needs more than ` +
          `${String(MAX_CLOSING_DEPTH)} nested instantiations, exceeding the configured ` +
          `'${MATERIALISATION_DEPTH_LIMIT}' limit of ${String(MAX_CLOSING_DEPTH)} -- either the arguments are ` +
          'growing rather than repeating and there is no finite set of types to build (§5.10), or this ' +
          `deployment simply declined to spend the resources. The chain begins ${chain()}. A recursive ` +
          'template must reach an argument it has already been applied to',
        { limit: MATERIALISATION_DEPTH_LIMIT, configuredThreshold: MAX_CLOSING_DEPTH },
      );
    }
    heads.push(head);
    try {
      if (!isHeldBody(template.body)) {
        // Every open entry's body is held -- a record, composition or refinement template, a
        // sugar form's lift, an alias, and an error placeholder alike. So this is a broken
        // invariant, not an author error and not a gap.
        throw new TsonInternalError(
          `'${head}' declares type parameters but its body is not a held application -- every open entry's ` +
            'body is held, and nothing else can be substituted into',
        );
      }
      const target = template.body.application.typeRef;
      if (target === undefined) {
        throw new TsonInternalError(
          `'${head}' is a held body whose own application carries no constructor name to dispatch on`,
        );
      }
      // §5.10's partial application mints nothing at all: the alias *is* the application it
      // names with some arguments still open, so closing it composes the two argument lists and
      // hands back whatever that denotes.
      if (target === REFERENCE_HEAD) {
        aliasClosing.add(name);
        return closeHeldAlias(head, template.body, bind(parameters, args));
      }
      // A record template's closure is the instantiation itself. This is the ANONYMOUS
      // (use-site, no owning declaration -- `owners` found none for this identity above) path;
      // {@link closeApplicationAs} is the declared one, and the two agree here because a
      // record's own substituted body IS the type an application denotes either way (§5.10,
      // §8.2). Every other held form closes to a *synthetic* the instantiation then references
      // (below): unlike a record, a non-record form has no author-written body of its own to be
      // -- it is what §8.2 calls a synthetic's own content identity, kept separately mergeable
      // with an identically-shaped sugar form written elsewhere -- and only a *declaration*
      // naming the application collapses that hop (§8.2, §8.3, §5.10 last paragraph).
      if (target === RECORD_HEAD) {
        const instantiation = closeHeldInstantiation(
          head,
          template,
          template.body,
          args,
          bind(parameters, args),
          false,
        );
        materialised.set(name, instantiation);
        deps.publish(name, instantiation);
        return name;
      }
      const formName = closeHeldTemplate(head, template.body, bind(parameters, args));
      if (generated.has(head)) {
        // A generated head closing its own intermediate form: the form entry *is* the answer,
        // and an instantiation naming this head would carry an internal name into identity.
        return formName;
      }
      const alias = instantiationOf(head, args, formName);
      materialised.set(name, alias);
      deps.publish(name, alias);
      return name;
    } finally {
      closing.delete(name);
      aliasClosing.delete(name);
      heads.pop();
    }
  }

  /** A held body substituted, its inner applications closed, and read back through its constructor. */
  function closeHeld(
    head: string,
    open: HeldBody,
    bindings: ReadonlyMap<string, TypeArgument>,
  ): Closed {
    const target = open.application.typeRef;
    if (target === undefined) {
      throw new TsonInternalError(
        `'${head}<...>' is a held body whose own application carries no constructor name`,
      );
    }
    // One walk covers all three shapes at once: a parameter in a slot, a parameter inside an
    // application a slot holds (`tree<p0>` becoming `tree<text>`), and a parameter inside a
    // collection are all the same thing here -- a token in a tree -- because the body was never
    // read against the constructor's vocabulary in the first place.
    const substituted = substitute(open.application.coreValue, head, open.parameterNames, bindings);
    const wire = closeApplications(substituted);
    if (deps.definitionMetaReader === undefined) {
      throw new TsonNotImplementedError(
        `'${head}<...>' closes to a '${target}' body, and this materialiser was built without a compiled ` +
          'meta reader to bind it through',
      );
    }
    try {
      const value: DataValue = { annotations: [], typeRef: target, coreValue: wire };
      const body = deps.definitionMetaReader(target, value);
      checkMaterialisedCoherence(head, target, body);
      return { wire, body };
    } catch (e) {
      if (e instanceof TsonReadError) {
        // The bindings a template defers are checked here and nowhere else (§8.2): `<T, N>
        // [T; N]` is a fine declaration, and `vector<text, "two">` is where it stops being one.
        throw new TsonSchemaValidationError(
          `'${head}<...>' substitutes into a body that is not valid data for '${target}', the ` +
            `constructor's own constraint vocabulary -- ${e.message}`,
          { cause: e },
        );
      }
      throw e;
    }
  }

  /**
   * §7.4's "Coherence of a body's facets" re-run at materialisation, over the operands that were
   * parameters: "every family coherence rule that §5.3 and §5.5 state for a literally written
   * body applies again at materialisation, over the operands that were parameters" (§8.2). A
   * literal body gets this from `definitionResolver.ts`'s own `checkCoherent`, run once the body
   * is bound; a held body's own facets are not known until *this* function has substituted and
   * closed them, so this is where the same question is asked a second time -- the constraint
   * vocabulary a template's parameters close onto can admit no value just as easily as one an
   * author writes out directly (`bounded => <N> !integer_type { min: N max: 10 }` applied as
   * `bounded<20>` is `{ min: 20 max: 10 }` in another spelling, and the identical literal
   * declaration is already refused by `checkCoherent`).
   */
  function checkMaterialisedCoherence(head: string, constructorName: string, body: Top): void {
    if (!isAtom(body)) return;
    const violations = checkAtomCoherence(body);
    if (violations.length > 0) {
      throw new TsonSchemaValidationError(
        `'${head}<...>' closes to a '${constructorName}' body whose own constraints contradict ` +
          `each other: ${violations.join('; ')} (§7.4, §8.2)`,
      );
    }
  }

  /**
   * A fully-bound application's closure: the instantiation entry itself, whatever constructor the
   * template's held body applies -- a record, an array, a refined atom, anything (§5.10, §8.2,
   * §8.3). Substituting yields the type the author named by writing the application, so there is
   * nothing for a synthetic-plus-reference hop to buy, and the entry carries the application in
   * its own `source` the way §8.2 says every instantiation does.
   */
  function closeHeldInstantiation(
    head: string,
    template: TypeDefinition,
    open: HeldBody,
    args: readonly TypeArgument[],
    bindings: ReadonlyMap<string, TypeArgument>,
    declared: boolean,
  ): TypeDefinition {
    const closed = closeHeld(head, open, bindings);
    const body = closeFamilyClaims(closed.body);
    return {
      source: { name: head, arguments: args, annotations: [] },
      supertypes: instantiationSupertypes(head, template, body, declared),
      subtypes: template.subtypes,
      body,
      annotations: [],
    };
  }

  /**
   * §8.1's "Entry shape": an instantiation entry's `supertypes` is "the template's supertypes,
   * plus the closed parent an open `record.supertypes` application named (§5.8) and, where the
   * template is a family base, the template itself (§5.10)" — the last **only where a declaration
   * names the application** (`declared`): an application written at a use site is a type read
   * where it is written and no member of the template's family (§5.10, §8.2). `template.supertypes` is the OPEN
   * template's own, pre-closing value, which never carries the IS-A edge an open composition
   * operand (`ok => <T> result<T> & { ... }`) only gains once its parameter closes: `result<T>`
   * substitutes to `result<text>` and closes to a bare reference inside `body`'s own (now-closed)
   * `record.supertypes` -- `closeHeld` (above) already ran that substitution -- so this function
   * reads the closed parents from there, folds in each parent's own transitive chain, and appends
   * `head` itself unless the template composes with `top` (the one case §5.10 exempts: a
   * constructor refinement in a meta-schema, not a family base).
   */
  function instantiationSupertypes(
    head: string,
    template: TypeDefinition,
    body: Top,
    declared: boolean,
  ): readonly string[] {
    const result: string[] = [...template.supertypes];
    const seen = new Set(result);
    const addOne = (n: string): void => {
      if (!seen.has(n)) {
        seen.add(n);
        result.push(n);
      }
    };
    if (isRecordTop(body)) {
      for (const parentRef of body.supertypes) {
        addOne(parentRef.name);
        const parentDef = deps.namespaceDefinitions(parentRef.name);
        if (parentDef !== undefined) {
          for (const ancestor of parentDef.supertypes) addOne(ancestor);
        }
      }
    }
    if (declared && isTemplateBody(template.body) && template.body.extension === 'ABSTRACT') {
      addOne(head);
    }
    return result;
  }

  /**
   * The entry an application of an open *instance* denotes — a template whose body is neither a
   * record nor an alias. Two entries come out of it, because one cannot carry two identities: the
   * body itself is a closed *synthetic*, named for the form and sourced to the constructor it
   * builds (§8.2) — an open synthetic's own name is internal, so keying it on the application
   * would make identity depend on an unstable name. But the same closure is also an
   * *instantiation* of the template, and §8.2 keys that on the application itself (this module's
   * own top note on {@link canonicalArgs}). So this
   * publishes the synthetic and returns the name of a reference entry pointing at it, whose
   * `source` is the application (built by {@link instantiate}'s own caller, {@link
   * instantiationOf}).
   */
  function closeHeldTemplate(
    head: string,
    open: HeldBody,
    bindings: ReadonlyMap<string, TypeArgument>,
  ): string {
    const target = open.application.typeRef;
    if (target === undefined) {
      throw new TsonInternalError(
        `'${head}<...>' is a held body whose own application carries no constructor name`,
      );
    }
    const closed = closeHeld(head, open, bindings);
    // Named before the entry is built and from the wire slots as written, which is what keeps
    // one type on one entry: the desugar phase lifts innermost-first, so a form it writes already
    // names the entry its inner form became, and a form closed here has to agree with it or
    // `[[pixel; 3]; 3]` written out and `grid<pixel, 3>` closed would be two entries for one type.
    const fields = closed.wire.kind === 'record' ? closed.wire.fields : [];
    const formName = ofBinding(target, fields);
    // §8.2's freshness MUST: the desugar phase mints from the same rendering when a form is
    // written out directly, so a genuine mismatch here is a real 32-bit collision, never the
    // ordinary "already built" case below.
    minted.claim(formName, canonicalBinding(target, fields));
    if (deps.namespaceDefinitions(formName) !== undefined) {
      return formName; // already built, here or by the desugar phase -- one entry per form, schema-wide
    }
    const definition: TypeDefinition = {
      source: { name: target, arguments: [], annotations: [] },
      supertypes: [],
      subtypes: [],
      body: closed.body,
      annotations: [],
    };
    materialised.set(formName, definition);
    synthetics.add(formName);
    deps.publish(formName, definition);
    return formName;
  }

  /**
   * A held alias closed: §5.10's partial application, which mints no entry of its own. The first
   * two steps are every held body's — substitute the parameters, then close the application
   * standing in a slot. What differs is what is left afterwards: nothing to build.
   */
  function closeHeldAlias(
    head: string,
    open: HeldBody,
    bindings: ReadonlyMap<string, TypeArgument>,
  ): string {
    const substituted = substitute(open.application.coreValue, head, open.parameterNames, bindings);
    const closed = closeApplications(substituted);
    const target = closed.kind === 'record' ? field(closed, 'target') : undefined;
    if (target?.kind !== 'token') {
      throw new TsonInternalError(
        `'${head}<...>' is an alias whose target did not close to a name -- heldBody.ts writes ` +
          "'!reference { target: <type_ref> }' and closeApplications reduces an application there to the " +
          'entry it denotes',
      );
    }
    return target.text;
  }

  /**
   * Every application still written in `type_ref`'s record form, closed to a bare reference to
   * the entry it denotes — the inverse of the shape `wireForm.ts`'s `refValue` writes when a
   * slot holds one. Runs on the wire value rather than on the body read from it because the
   * *name* {@link closeHeldTemplate} derives depends on it.
   */
  function closeApplications(value: CoreValue): CoreValue {
    switch (value.kind) {
      case 'record':
        if (isApplication(value)) {
          const token: TokenValue = {
            kind: 'token',
            text: close(typeRefOf(value)).name,
            form: 'unquoted',
          };
          return token;
        }
        return {
          kind: 'record',
          fields: value.fields.map((field) => ({
            name: field.name,
            value: rescope(field.value, closeApplications(field.value.value.coreValue)),
          })),
        };
      case 'array':
        return {
          kind: 'array',
          elements: value.elements.map((element) =>
            rescope(element, closeApplications(element.value.coreValue)),
          ),
        };
      case 'map':
      case 'empty-brace':
      case 'absent':
      case 'token':
        return value;
    }
  }

  return {
    closeApplication(application: TypeRef): string {
      return close(application).name;
    },
    checkApplication(application: TypeRef): void {
      const template = deps.namespaceDefinitions(application.name);
      if (template === undefined) return;
      const parameters = typeParameters(template);
      if (parameters.length === 0 || parameters.length !== application.arguments.length) return;
      byParameterKind(application.name, template, parameters, application.arguments);
    },
    closeApplicationAs(name: string, application: TypeRef): TypeDefinition | undefined {
      const head = application.name;
      const template = deps.namespaceDefinitions(head);
      if (template === undefined || !isHeldBody(template.body)) {
        return undefined;
      }
      const target = template.body.application.typeRef;
      if (target === undefined || target === REFERENCE_HEAD) {
        return undefined; // an alias template composes away and mints nothing to own (§5.10)
      }
      const parameters = typeParameters(template);
      if (parameters.length !== application.arguments.length) {
        return undefined; // arity mismatch -- the ordinary path reports it
      }
      const args = application.arguments.map((argument) =>
        argument.kind === 'ref' ? { kind: 'ref' as const, ref: close(argument.ref) } : argument,
      );
      const canonical = canonicalArgs(byParameterKind(head, template, parameters, args));
      const identityKey = ofApplication(head, canonical);
      if (!owners.has(identityKey)) {
        owners.set(identityKey, name);
      }
      minted.claim(name, canonicalApplication(head, canonical));
      const already = materialised.get(name);
      if (already !== undefined) {
        return already;
      }
      closing.add(name);
      heads.push(head);
      try {
        // §8.2, §8.3: a declaration naming a fully-bound application IS that application's
        // instantiation entry, whatever the applied constructor -- no minted twin beside it and
        // no `!reference` hop, record-bodied or not.
        const bindings = bind(parameters, canonical);
        const instantiation = closeHeldInstantiation(
          head,
          template,
          template.body,
          canonical,
          bindings,
          true,
        );
        materialised.set(name, instantiation);
        deps.publish(name, instantiation);
        return instantiation;
      } finally {
        closing.delete(name);
        heads.pop();
      }
    },
    materialise(
      entries: ReadonlyMap<string, TypeDefinition>,
      reporter?: MaterialisationFailureReporter,
    ): MaterialiseResult {
      const rewritten = new Map<string, TypeDefinition>();
      for (const [key, definition] of entries) {
        if (typeParameters(definition).length > 0) {
          // A template's own body is open: `chain<T>` inside `chain` awaits substitution and is
          // not an application to close. Closing it here would mint an entry per level, keyed on
          // the literal parameter name.
          rewritten.set(key, definition);
          continue;
        }
        try {
          rewritten.set(key, mapRefs(definition, close));
        } catch (e) {
          if (!(e instanceof TsonSchemaValidationError)) {
            throw e;
          }
          if (reporter === undefined) {
            throw e;
          }
          // Reported against the entry that wrote the application, and left as it was: an entry
          // still naming an open template is one the linker reports again, but that second
          // complaint is about the same line and does not invent a new problem.
          reporter.reportFailedApplication(key, e);
          rewritten.set(key, definition);
        }
      }
      return {
        entries: rewritten,
        materialised: new Map(materialised),
        synthetics: new Set(synthetics),
      };
    },
    syntheticNames(): ReadonlySet<string> {
      return new Set(synthetics);
    },
    setParameterKinds(kinds: ReadonlyMap<string, ReadonlyMap<string, Kind>>): void {
      parameterKinds = kinds;
      stamped = true;
    },
    recheckEarly(report): void {
      const refused = new Set<string>();
      for (const check of early) {
        const template = deps.namespaceDefinitions(check.head);
        if (
          refused.has(check.declaration) ||
          template === undefined ||
          !isTemplateBody(template.body)
        ) {
          continue;
        }
        try {
          checkArguments(
            check.head,
            template,
            classify(check.head, template, typeParameters(template), check.args),
          );
        } catch (e: unknown) {
          if (!(e instanceof TsonSchemaValidationError)) throw e;
          refused.add(check.declaration);
          report(check.declaration, e);
        }
      }
      early.length = 0;
    },
    closedFormName(head: string, fields: readonly RecordField[]): string {
      const wire = closeApplications({ kind: 'record', fields });
      return ofBinding(head, wire.kind === 'record' ? wire.fields : []);
    },
  };
}

// ── Structural walks ─────────────────────────────────────────────────────────────────────────

/** A closed held body, and the wire form it was read from -- the one an entry name derives from. */
interface Closed {
  readonly wire: CoreValue;
  readonly body: Top;
}

function isHeldBody(body: Top): body is HeldBody {
  return 'application' in body;
}

/** `Top`'s open `Data.kind: string` member defeats a plain `body.kind === 'record'` narrowing (`compiler/compile.ts`'s own note); this guard is this module's own copy. */
function isRecordTop(body: Top): body is RecordBody {
  return 'kind' in body && body.kind === 'record';
}

/**
 * What closing a record leaves of its template's own claims about a family (§5.7, §5.10). A
 * parametric modifier takes the name mark its literal spelling takes, so there is no presence fact
 * left to supply here: `w?: T ~ N` closes to an optional default, `w?: T = N` to an optional pin and
 * `w: T = N` to a required marker, with `optional` and `role` as the declaration wrote them.
 *
 * What does not travel to a member is **dispatch on members**. ABSTRACT is a claim about the
 * marked type alone and holds of every instantiation identically, but `discriminators` names the
 * fields a base's members pin; the instantiation that closes the template has pinned them, or is
 * itself a member that states none of its own. So a closed body names no selector and a base that
 * dispatches on members closes to OPEN rather than carrying its abstractness into every member.
 *
 * Exported and shared with `definitionResolver.ts`'s `openOperand`, so a composition operand and a
 * named type position close one way.
 */
export function closeFamilyClaims(body: Top): Top {
  // `'fields' in body`, not `body.kind === 'record'`: see `mapBodyRefs`'s own note on why a
  // `Data` body's bare-`string` `kind` cannot be excluded by a literal comparison.
  if (!('fields' in body)) {
    return body;
  }
  const { discriminators, ...rest } = body;
  if (discriminators === undefined || discriminators.length === 0) {
    return body;
  }
  return rest.extension === 'ABSTRACT' ? { ...rest, extension: 'OPEN' } : rest;
}

/**
 * The entry for a use-site (undeclared) application whose closure is a synthetic: a reference to
 * that synthetic, sourced to the application itself -- §8.2's other lift channel, distinct from a
 * *declared* application, which is its own instantiation entry with no such hop
 * ({@link closeHeldInstantiation}, {@link TemplateMaterialiser.closeApplicationAs}).
 */
function instantiationOf(
  head: string,
  args: readonly TypeArgument[],
  formName: string,
): TypeDefinition {
  return {
    source: { name: head, arguments: args, annotations: [] },
    supertypes: [],
    subtypes: [],
    body: { kind: 'reference', target: { name: formName, arguments: [], annotations: [] } },
    annotations: [],
  };
}

/** One definition with every application inside it closed, `source` and whatever its body carries alike. */
function mapRefs(definition: TypeDefinition, map: (ref: TypeRef) => TypeRef): TypeDefinition {
  return {
    ...definition,
    ...(definition.source === undefined ? {} : { source: map(definition.source) }),
    body: mapBodyRefs(definition.body, map),
  };
}

/**
 * Every {@link TypeRef} a body holds, mapped. Exported so a later work package's own
 * `TemplateRegularity` port can walk a body by the same code that rewrites one — a body shape
 * added here must not need remembering in a second place.
 *
 * A held body maps nothing: its references are tokens that have not been resolved against
 * anything yet, and rewriting one would be rewriting a name whose meaning is not settled until
 * substitution supplies the arguments. In practice this branch is unreachable from
 * {@link createTemplateMaterialiser}'s own `materialise`, which never scans an entry whose
 * `parameters` is non-empty — the only entries whose body is ever held — but the case is kept
 * total (never a `TsonInternalError`) so a body shape that adds a held variant later fails no
 * differently than an atom body does.
 */
export function mapBodyRefs(body: Top, map: (ref: TypeRef) => TypeRef): Top {
  // Narrowed by which field each shape alone carries, not by `body.kind`: `Data.kind` is a bare
  // `string` (a meta-schema's own constructor name, unknown to this package in advance), so a
  // `switch` on the discriminant cannot exclude it from any one case the way it can for a closed
  // union of literal tags. Every check below names a field only its own shape has, so a `Data`
  // body -- and a held body, which carries none of them either -- falls through to `return body`
  // unchanged without needing a separate check for either.
  if ('fields' in body) {
    return { ...body, fields: body.fields.map((field) => ({ ...field, type: map(field.type) })) };
  }
  if ('elementType' in body) {
    return { ...body, elementType: map(body.elementType) };
  }
  if ('keyType' in body) {
    return { ...body, keyType: map(body.keyType), valueType: map(body.valueType) };
  }
  if ('elements' in body) {
    return {
      ...body,
      elements: body.elements.map((element) => ({
        ...element,
        elementType: map(element.elementType),
      })),
    };
  }
  if ('variants' in body) {
    return { ...body, variants: body.variants.map(map) };
  }
  if ('target' in body) {
    return { ...body, target: map(body.target) };
  }
  return body; // an atom body, a Data body, or a held body holds no type reference this walk rewrites
}

// ── Instantiation names (§8.2) ───────────────────────────────────────────────────────────────
//
// `derivedName.ts`'s own `ofApplication`/`canonicalApplication` do the rendering; this module's
// only remaining business is calling them and claiming the result through `mintedNames.ts`.
