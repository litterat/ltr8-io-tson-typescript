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
 * constructor's reader. What differs is only what the result *is*: a **record** template's
 * closure is the instantiation entry itself ({@link closeHeldRecord}), because a substituted
 * record is the type the author named by writing the application; every other held form closes
 * to a *synthetic* named for the form, which the instantiation then references
 * ({@link closeHeldTemplate}), because a form has no author-written name to be keyed on.
 *
 * **An alias closes by a third path and mints nothing.** §5.10's partial application,
 * `uuid_pair => <B> pair<uuid, B>`, holds `!reference { target: pair<uuid, B> }` like any other
 * open entry, but it *is* the application it names with some arguments still open — so closing it
 * composes the two argument lists and hands back what that denotes, minting no entry of its own
 * (§5.10: "no intermediate entry per alias hop"). See {@link closeHeldAlias}.
 *
 * **So the three cases are told apart by the constructor head, not by the body's shape.** Every
 * open entry's body is a `HeldBody` (`heldBody.ts`) — a record, composition or refinement
 * template, a sugar form's lift, an alias, and an error placeholder alike. `record` closes to the
 * instantiation, `reference` to a name, everything else to a synthetic.
 *
 * **Identity (§8.2).** An instantiation entry is keyed on the flattened application recorded in
 * `source`, so two `box<text>` anywhere land on one entry. The derived name is built by
 * `derivedName.ts`'s own `ofApplication` from the application itself, which is what makes that
 * dedup fall out of naming rather than needing a second table: it is a pure function of a head
 * and an argument list, nothing else, so the same application derives the same name whichever
 * declaration happens to reach it first. `mintedNames.ts`'s own instance below decides §8.2's
 * freshness MUST over every name this materialiser mints.
 *
 * **Knot-tying.** The memo entry is registered *before* the body is substituted, so a recursive
 * application reached during substitution (`tree<T>` inside `tree`, which becomes `tree<text>`
 * once `T` is bound) finds the entry under construction and references it by name rather than
 * recursing forever.
 *
 * **The depth backstop, and what it is not.** §5.10.1's own static check — that a recursive
 * application must pass every parameter through unchanged, so a well-formed schema's recursion
 * always ties the knot on its first repeat — is a separate, later pass over the *resolved*
 * entries before any of them are closed (the Java's `TemplateRegularity`, a later work package's
 * own file here). What this module carries instead is the guard the Java documents as a
 * **backstop, not the rule**: `MAX_CLOSING_DEPTH` bounds how many nested instantiations one
 * `close` chain may open before materialisation gives up and reports a diagnostic naming the
 * outermost application and the chain that grew rather than repeated. Ported for its semantics,
 * not its mechanism — a fixed depth counter over a `Set` of in-progress entry names, checked
 * after each new link is added — so that a hole in the earlier static check (or, in this port,
 * simply not having reached that later work package yet) fails as a `TsonSchemaValidationError`
 * a caller can report, never as a host stack overflow.
 */
import {
  TsonInternalError,
  TsonNotImplementedError,
  TsonReadError,
  TsonSchemaValidationError,
} from '../core/errors.js';
import type { CoreValue, DataValue, RecordField, TokenValue } from '../ast/value.js';
import type { TypeArgument, TypeDefinition, TypeRef, Top } from '../schema/meta/typedef.js';
import { canonicalApplication, canonicalBinding, ofApplication, ofBinding } from './derivedName.js';
import { createMintedNames, type MintedNames } from './mintedNames.js';
import { field, isApplication, rescope, typeRefOf } from './wireForm.js';
import type { HeldBody } from './heldBody.js';
import { substitute } from './templateSubstitution.js';
import { inferOne, type Kind } from './parameterKinds.js';
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
   * `closeHeldRecord` calls the same shared `closeHeld` an open-instance template does, so a
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
   * classifying a template's parameters by use (§5.10, `parameterKinds.ts`). Needed only for the
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
   * batch pass (`parameterKinds.ts`'s `inferAll`) has computed them — every declaration has
   * resolved, so every slot's declared type is available, and nothing has closed yet. An
   * application closed *before* this is called (the on-demand half, reached from a composition
   * supertype or refinement source during resolution's own driving loop) classifies its own
   * template in isolation instead, through {@link TemplateMaterialiserDeps.metaTypes} — see this
   * module's own `byParameterKind`.
   */
  setParameterKinds(kinds: ReadonlyMap<string, ReadonlyMap<string, Kind>>): void;

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
 * rule. See this module's own doc for why this stays even once §5.10.1's static check lands
 * elsewhere.
 */
const MAX_CLOSING_DEPTH = 64;

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
   * §5.10's parameter kinds, by entry name then parameter name — empty until
   * {@link TemplateMaterialiser.setParameterKinds} supplies `schemaResolver.ts`'s own batch
   * pass's result. An application closed before that point classifies as it always did.
   */
  let parameterKinds: ReadonlyMap<string, ReadonlyMap<string, Kind>> = new Map();

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
    const parameters = template.parameters;
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
    // suggested at parse time.
    const args = byParameterKind(head, template, parameters, rawArgs);
    const name = ofApplication(head, args);
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
      // is whichever link happened to tip the depth over.
      throw new TsonSchemaValidationError(
        `'${heads[0] ?? head}<...>' does not close: materialising it needs more than ` +
          `${String(MAX_CLOSING_DEPTH)} nested instantiations and each one differs from the last, so the ` +
          'arguments are growing rather than repeating and there is no finite set of types to build ' +
          `(§5.10). The chain begins ${chain()}. A recursive template must reach an argument it has ` +
          'already been applied to',
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
        return closeHeldAlias(head, template, template.body, bind(parameters, args));
      }
      // A record template's closure is the instantiation itself, where every other held form
      // closes to a synthetic the instantiation then references.
      if (target === RECORD_HEAD) {
        const instantiation = closeHeldRecord(
          head,
          template,
          template.body,
          args,
          bind(parameters, args),
        );
        materialised.set(name, instantiation);
        deps.publish(name, instantiation);
        return name;
      }
      const formName = closeHeldTemplate(head, template, template.body, bind(parameters, args));
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
    template: TypeDefinition,
    open: HeldBody,
    bindings: ReadonlyMap<string, TypeArgument>,
  ): Closed {
    const target = open.application.typeRef;
    if (target === undefined) {
      throw new TsonInternalError(
        `'${head}<...>' is a held body whose own application carries no constructor name`,
      );
    }
    // One walk does what three steps used to: a parameter in a slot, a parameter inside an
    // application a slot holds (`tree<p0>` becoming `tree<text>`), and a parameter inside a
    // collection are all the same thing here -- a token in a tree -- because the body was never
    // read against the constructor's vocabulary in the first place.
    const substituted = substitute(open.application.coreValue, head, template.parameters, bindings);
    const wire = closeApplications(substituted);
    if (deps.definitionMetaReader === undefined) {
      throw new TsonNotImplementedError(
        `'${head}<...>' closes to a '${target}' body, and this materialiser was built without a compiled ` +
          'meta reader to bind it through',
      );
    }
    try {
      const value: DataValue = { annotations: [], typeRef: target, coreValue: wire };
      return { wire, body: deps.definitionMetaReader(target, value) };
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
   * A record template's closure, which is the instantiation entry itself rather than a synthetic
   * with a reference to it. Substituting a record yields a record — what the author declared,
   * not a form derived from a sugar spelling — so there is nothing for the extra hop to record,
   * and the entry carries the application in its own `source` the way §8.2 says every
   * instantiation does.
   */
  function closeHeldRecord(
    head: string,
    template: TypeDefinition,
    open: HeldBody,
    args: readonly TypeArgument[],
    bindings: ReadonlyMap<string, TypeArgument>,
  ): TypeDefinition {
    const closed = closeHeld(head, template, open, bindings);
    return {
      source: { name: head, arguments: args, annotations: [] },
      kind: template.kind,
      parameters: [],
      constructor: template.constructor,
      supertypes: template.supertypes,
      subtypes: template.subtypes,
      body: fixRoutedValues(closed.body),
      annotations: [],
    };
  }

  /**
   * The entry an application of an open *instance* denotes — a template whose body is neither a
   * record nor an alias. Two entries come out of it, because one cannot carry two identities: the
   * body itself is a closed *synthetic*, named for the form and sourced to the constructor it
   * builds (§8.2) — an open synthetic's own name is internal, so keying it on the application
   * would make identity depend on an unstable name. But the same closure is also an
   * *instantiation* of the template, and §8.2 keys that on the flattened application. So this
   * publishes the synthetic and returns the name of a reference entry pointing at it, whose
   * `source` is the application (built by {@link instantiate}'s own caller, {@link
   * instantiationOf}).
   */
  function closeHeldTemplate(
    head: string,
    template: TypeDefinition,
    open: HeldBody,
    bindings: ReadonlyMap<string, TypeArgument>,
  ): string {
    const target = open.application.typeRef;
    if (target === undefined) {
      throw new TsonInternalError(
        `'${head}<...>' is a held body whose own application carries no constructor name`,
      );
    }
    const closed = closeHeld(head, template, open, bindings);
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
      kind: template.kind,
      parameters: [],
      constructor: false,
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
    template: TypeDefinition,
    open: HeldBody,
    bindings: ReadonlyMap<string, TypeArgument>,
  ): string {
    const substituted = substitute(open.application.coreValue, head, template.parameters, bindings);
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
    materialise(
      entries: ReadonlyMap<string, TypeDefinition>,
      reporter?: MaterialisationFailureReporter,
    ): MaterialiseResult {
      const rewritten = new Map<string, TypeDefinition>();
      for (const [key, definition] of entries) {
        if (definition.parameters.length > 0) {
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

/** §5.7's fixation, applied where the section says it happens: "fixation happens downstream, where values are concrete". A field routed by `= P` is held as `state: REQUIRED` with the parameter standing in `value`; once substitution has made the value concrete the field takes the state its literal spelling would have had. A `~ P` default arrives as `REQUIRED_DEFAULT` and stays one. */
function fixRoutedValues(body: Top): Top {
  // `'fields' in body`, not `body.kind === 'record'`: see `mapBodyRefs`'s own note on why a
  // `Data` body's bare-`string` `kind` cannot be excluded by a literal comparison.
  if (!('fields' in body)) {
    return body;
  }
  return {
    ...body,
    fields: body.fields.map((field) =>
      field.state === 'REQUIRED' && field.value !== undefined
        ? { ...field, state: 'REQUIRED_FIXED' as const }
        : field,
    ),
  };
}

/** The entry for an application whose closure is a synthetic: a reference to that synthetic, sourced to the application itself. */
function instantiationOf(
  head: string,
  args: readonly TypeArgument[],
  formName: string,
): TypeDefinition {
  return {
    source: { name: head, arguments: args, annotations: [] },
    kind: 'REFERENCE',
    parameters: [],
    constructor: false,
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
