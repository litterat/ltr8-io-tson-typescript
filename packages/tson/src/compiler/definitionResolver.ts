/**
 * Resolves declarations from a `SchemaMap` (the grammar-layer AST, `ast/schema/`) into entry values
 * (`schema/meta`'s `Top`, Part 2 §4, §8). Ported from the reference implementation's `DefinitionResolver`.
 *
 * **The one structural divergence from the Java, worth restating here.** §5.7's refinement merge
 * (`mergeWithSource` below) must run on the *wire record* before binding -- the Java achieves that by holding
 * an object writer, which is why the writers cannot leave `tson-compiler`. This port does not reproduce that: a
 * caller supplies {@link SourceBodyEncoder} (`resolverTypes.ts`), a plain `(body: Top) => CoreValue` function
 * assembled from `bind/encode.ts`'s `toCoreValue` and `schema/bindings.ts`'s `topBinding` -- from a place that
 * can see both `bind/` and `schema/meta/`, which `compiler/` itself may not. No text round trip.
 *
 * **One namespace (§3.3.1).** Every name -- a construction head, a refinement source, an operand, a type at a
 * slot, an annotation -- resolves in the schema's one namespace, read through the {@link DefinitionGetter} a
 * caller supplies, which makes an entry ready the first time it is asked for (§3.4.1).
 *
 * **Applicability is IS-A `top` (§3.3.1, §4.2), never a marker.** `!C value` requires {@link isConstructor}
 * (IS-A `top`, derived from `supertypes`); a head that is no constructor makes the entry a value of that type.
 *
 * **`^` follows `!name` and takes values (§5.5, §5.7).** Over an atom instance it refines the type; over a
 * constructor of types it leaves the construction open, an incomplete entry; over an incomplete entry it writes
 * further fields of one; a completion is the plain construction of the entry's constructor, carrying
 * `@meta.completion` on its key (§8.1). A record is derived by `&` alone.
 *
 * **A type slot holds a name or a type written in place (§4.2).** A field's type is a reference, or the
 * construction a sugar form or an applied constructor denotes, read through its constructor and held at the
 * field as a {@link TypeInline}, where it is used.
 *
 * **Field groups (§5.11) flatten**: each member becomes an ordinary `RecordField` with `optional: true`; the
 * group itself is recorded separately as a `FieldGroup`.
 *
 * **`subtypes` is never populated** -- the reverse index over a whole resolved schema is the linker's.
 */
import {
  TsonInternalError,
  TsonNotImplementedError,
  TsonSchemaValidationError,
} from '../core/errors.js';
import {
  TsonBindMismatchError,
  TsonMissingBindingError,
  TsonReadError,
  TsonNameHygieneRefusedError,
  TsonRefusedError,
} from '../core/errors.js';
import { DEFAULT_MAX_SUPERTYPE_CHAIN, supertypeChainLimitRefusal } from '../core/limits.js';
import type { DataValue, RecordValue } from '../ast/value.js';
import { asciiLowercase } from '../unicode/normalization.js';
import type { Annotation as WrittenAnnotation } from '../ast/value.js';
import type { Declaration } from '../ast/schema/document.js';
import type { ConstructionDef, TypeDef } from '../ast/schema/typedef.js';
import type {
  AtomRefinement,
  FieldDef,
  GroupDef,
  GroupMember,
  Instance,
  RecordEntry,
  RemovalSet,
} from '../ast/schema/fields.js';
import type {
  ApplicationRef,
  FieldTypeExpr,
  InlineConstruction,
  TypeExpr as AstTypeExpr,
} from '../ast/schema/typeref.js';
import type { SourcePosition } from '../schema/meta/position.js';
import type {
  Annotation,
  Annotations,
  ApplyBody,
  Completion,
  EntryFacts,
  IncompleteEntry,
  MetaValue,
  Param,
  Top,
  Type,
  TypeExpr,
  TypeInline,
  TypeRef,
} from '../schema/meta/typedef.js';
import {
  constructorOf,
  isConstructor,
  isParametric,
  parametersOf,
  isType,
  isValueEntry,
  namespaceOf,
  subtypesOf,
  supertypesOf,
  typeChain,
  withChain,
  withoutChain,
} from '../schema/meta/typedef.js';
import { groupMembers, lowerGroup } from './groupLowering.js';
import {
  spellGroup,
  fieldMapOf,
  fieldOmission,
  isGroupMember,
  namedFields,
  typeExprText,
  type FieldGroup,
  type FieldOmission,
  type NamedField,
  type RecordBody,
  type RecordExtensionType,
  type RecordField,
} from '../schema/meta/bodies.js';
import {
  discriminatorsRefusal,
  inlineRefusal,
  mapInPlace,
  parameterIn,
  sameTypeExpr,
  withParametersMarked,
} from '../schema/meta/typeInline.js';
import type { Token } from '../schema/meta/typedef.js';
import { tryParseNumber } from '../base/numberGrammar.js';
import { toExactDecimal, toExactInteger } from '../base/numberNarrowing.js';
import { toNfc } from '../unicode/nfc.js';
import type { TsonDecimal } from '../value/types.js';
import type {
  AnnotationValueReader,
  DefinitionGetter,
  DefinitionMetaReader,
  DefinitionValueReader,
  EntryFactsTable,
  SourceBodyEncoder,
} from './resolverTypes.js';
import { DESUGARED, WRITTEN_FIELDS, applicationValue } from './desugar.js';
import { DEFAULT_NAME_TYPE, SCHEMA, metaName } from '../schema/meta/kernel.js';
import { APPLY, FIELDS, PARAMETERS } from './wireForm.js';
import { resolveFieldMarks } from './fieldModifiers.js';
import { checkAtomNarrows, checkBodyCoherence, isAtom } from './atomChecks.js';
import { terminal, terminalDefinition } from '../link/aliasChain.js';
import { EXTERN_HEAD, sealedExtern, terminalExtern } from '../link/externs.js';
import { metaFormOfLexer } from './tokenForms.js';
import {
  argumentNotAName,
  createConstructionRewrite,
  suggestedName as suggestedNameOf,
  text as writtenText,
  type ConstructionRewrite,
} from './constructionRewrite.js';
import { constructs } from './constructionSugar.js';
import * as IncompleteEntries from './incompleteEntries.js';
import * as CollectionFacets from './collectionFacets.js';
import * as Ancestry from './ancestry.js';
import * as Substitution from './substitution.js';
import * as TypeSlots from '../schema/meta/typeSlots.js';
import { at as standsAt, checkSlots } from './parameterTypes.js';
import type { Restatements } from './restatements.js';

// ── Public surface ───────────────────────────────────────────────────────────────────────────

/**
 * Every dependency `resolve`/`annotationsFor` need beyond the declaration in hand -- see `resolverTypes.ts` for
 * what each function type is for.
 *
 * `facts` is the table each declaration's {@link EntryFacts} are recorded in as it resolves -- shared with the
 * caller, which assembles the resolved schema from it, and holding imported entries' facts too, so a refinement
 * finds the constructor its source was built with. Omitted, the resolver keeps a table of its own.
 *
 * `opens` answers whether a head, past its alias hops, is a parametric record, without making it ready: a
 * parametric record's application orders nothing (§3.4.1). Omitted, it asks the namespace.
 */
export interface DefinitionResolverDeps {
  readonly definitionMetaReader: DefinitionMetaReader;
  /** Reads a value entry's payload against the ordinary type its tag names (§4.1). Omitted means a value entry is a gap. */
  readonly definitionValueReader?: DefinitionValueReader;
  readonly annotationValueReader?: AnnotationValueReader;
  readonly metaDefinitions: DefinitionGetter;
  readonly namespaceDefinitions: DefinitionGetter;
  readonly facts?: EntryFactsTable;
  readonly encodeSourceBody?: SourceBodyEncoder;
  readonly opens?: (head: string) => boolean;
  /**
   * What a declaration needs of a §5.10 application while it resolves: the entry a declaration naming one is, and
   * the bound check of an operand absorbed by value. Omitted, a declared application is refused unclosed.
   */
  readonly applicationCloser?: ApplicationCloser;
  /** Where each restatement over a source the closed chain does not reach is recorded, for the linker (§5.8). */
  readonly restatements?: Restatements;
}

/**
 * `parametricMaterialiser.ts`'s on-demand half, seen by the resolver as a dependency the way its namespace getters
 * are: what a declaration needs of a §5.10 application while it resolves, before the rest of materialisation runs as
 * a whole-schema pass afterwards.
 */
export interface ApplicationCloser {
  /**
   * §5.10's call-site check, for an application absorbed by value rather than closed: each argument must name a type
   * that IS-A its parameter's bound. A composition operand is absorbed and never closes.
   */
  checkArguments(head: string, record: Top, args: readonly TypeRef[]): void;
  /**
   * The entry a declaration naming a fully-bound application is (§8.2): the parametric record's application closed
   * into this declaration's own name. `undefined` where this declaration cannot own an entry -- an unresolved head or
   * one that is no parametric record, or an arity mismatch -- for the ordinary path to report.
   */
  closeApplicationInto(declaredName: string, application: ApplyBody): Top | undefined;
}

/** What every resolution step reads: the dependencies, and the resolver's own working state. */
interface ResolverContext extends DefinitionResolverDeps {
  readonly facts: EntryFactsTable;
  readonly rewrite: ConstructionRewrite;
  /** What each declared completion closed, nearest first (§8.1). */
  readonly completions: Map<string, Completion>;
  /** The judgements left for after every entry is ready ({@link DefinitionResolver.judgeDeferred}). */
  readonly deferred: Deferred[];
}

/** One judgement left for after every entry is ready, against the declaration that needs it. */
interface Deferred {
  readonly declaration: string;
  readonly check: () => void;
}

export interface DefinitionResolver {
  /**
   * Resolves a single declaration to the value its entry holds (§8.1: an entry is its value). The entry's facts
   * -- `position` when given, the annotations written after `=>`, the constructor its value's tag names -- are
   * recorded in the facts table rather than on the value, since none of them is a field of any constructor.
   */
  resolve(declaration: Declaration, position?: SourcePosition): Top;

  /** `name`'s facts as resolution has recorded them so far. */
  factsOf(name: string): EntryFacts;

  /**
   * The incomplete entries `name`'s declaration completed, nearest first, where it is a completion: what its key
   * states as `@meta.completion` (§8.1).
   */
  completionOf(name: string): Completion | undefined;

  /**
   * A declaration's own annotations, bound -- exposed for the identical rule over a key's annotations (§6: the
   * resolver does not hoist annotations from key to value).
   */
  annotationsFor(name: string, written: readonly WrittenAnnotation[]): Annotations;

  /**
   * The bound a declaration's parameter list wrote after `parameter` (`<T: text>`, §5.10), as a reference. A bound
   * names a type; any other form is refused, to be declared under a name.
   */
  parameterType(parameter: string, written: AstTypeExpr): TypeRef;

  /**
   * Runs the judgements resolution left for after every entry is ready (§3.4.1's sixth rule), in the order they
   * were left, handing each failure to `failure` with the declaration it is against. A judgement that walks a name
   * to the entry it names belongs here: a name at a type position orders nothing, so walking it while entries are
   * still being made ready would make one wait on what it only names.
   */
  judgeDeferred(failure: (declaration: string, error: TsonSchemaValidationError) => void): void;
}

export function createDefinitionResolver(given: DefinitionResolverDeps): DefinitionResolver {
  const facts: EntryFactsTable = given.facts ?? new Map<string, EntryFacts>();
  const opens =
    given.opens ??
    ((head: string): boolean => isParametric(terminalDefinition(head, given.namespaceDefinitions)));
  const deps: ResolverContext = {
    ...given,
    facts,
    rewrite: createConstructionRewrite(given.namespaceDefinitions, opens),
    completions: new Map(),
    deferred: [],
  };
  return {
    resolve(declaration: Declaration, position?: SourcePosition): Top {
      const resolved = withBounds(
        declaration,
        resolveTypeDef(deps, declaration.name, declaration.typeDef),
      );
      const annotations = annotationsOf(deps, declaration.name, declaration.typeDefAnnotations);
      const known = facts.get(declaration.name) ?? {};
      const recordedPosition = position ?? known.position;
      const head = resolved.head ?? known.head;
      facts.set(declaration.name, {
        ...(recordedPosition === undefined ? {} : { position: recordedPosition }),
        ...(annotations.length > 0 ? { annotations } : {}),
        ...(head === undefined ? {} : { head }),
      });
      return resolved.value;
    },
    factsOf(name: string): EntryFacts {
      return facts.get(name) ?? {};
    },
    completionOf(name: string): Completion | undefined {
      return deps.completions.get(name);
    },
    annotationsFor(name: string, written: readonly WrittenAnnotation[]): Annotations {
      return annotationsOf(deps, name, written);
    },
    parameterType(parameter: string, written: AstTypeExpr): TypeRef {
      return boundOf(parameter, written);
    },
    judgeDeferred(failure: (declaration: string, error: TsonSchemaValidationError) => void): void {
      const judging = deps.deferred.splice(0);
      for (const judgement of judging) {
        try {
          judgement.check();
        } catch (e) {
          if (!(e instanceof TsonSchemaValidationError)) throw e;
          failure(judgement.declaration, e);
        }
      }
    },
  };
}

/**
 * A parametric record with each parameter carrying the bound its declaration wrote (`<T: text>`, §5.10), the others
 * unbounded: a parameter is its name and its written bound, known in full where it is declared. Whether a bound
 * names a type is judged once every declaration is ready (`parameterTypes.ts`).
 */
function withBounds(declaration: Declaration, resolved: Resolved): Resolved {
  const written = declaration.parameterTypes;
  const value = resolved.value;
  if (written === undefined || written.size === 0 || value.kind !== 'record') return resolved;
  if (!isParametric(value)) return resolved;
  const parameters = parametersOf(value).map((parameter): Param => {
    const bound = written.get(parameter.name);
    return bound === undefined
      ? parameter
      : { name: parameter.name, bound: boundOf(parameter.name, bound) };
  });
  return { ...resolved, value: { ...value, parameters } };
}

/** The bound written after `parameter`, as a reference: a bound names a type, and any other form is refused. */
function boundOf(parameter: string, written: AstTypeExpr): TypeRef {
  if (written.kind !== 'nameRef') {
    throw new TsonSchemaValidationError(
      `parameter '${parameter}' is bounded by '${writtenFormOf(written)}', and a bound names a type ` +
        '(§5.10): declare the form under a name and write that name',
    );
  }
  return { name: written.name, annotations: [] };
}

/** A form at a slot that holds a name, as the author wrote it, for a message. */
function writtenFormOf(written: AstTypeExpr): string {
  switch (written.kind) {
    case 'nameRef':
      return written.name;
    case 'applicationRef':
      return `${written.name}<...>`;
    case 'arrayExpr':
    case 'tupleExpr':
      return '[...]';
    case 'mapExpr':
    case 'recordExpr':
      return '{ ... }';
    case 'choiceExpr':
      return '( ... )';
    case 'inlineConstruction':
      return `!${written.value.typeRef ?? ''} { ... }`;
  }
}

/**
 * One declaration resolved: the value its entry holds, and the constructor the value's tag names
 * where resolution knows it -- the one fact a value's shape cannot always carry ({@link
 * EntryFacts.head}).
 */
interface Resolved {
  readonly value: Top;
  readonly head?: string;
}

/** `name`'s facts as the shared table holds them -- an imported entry's included. */
function factsOf(deps: ResolverContext, name: string): EntryFacts {
  return deps.facts.get(name) ?? {};
}

/**
 * The constructor `name`'s value was built with: the one its facts record, and otherwise the one
 * its shape is the body of ({@link constructorOf}).
 */
function headOf(deps: ResolverContext, name: string, value: Top): string {
  return factsOf(deps, name).head ?? constructorOf(value);
}

/**
 * §5.2's definition mark (`abstract`/`final`), lowered into `RecordBody.extension`, and ABSTRACT derived where a
 * record names selectors. On a parametric record the mark and the selectors are each application's (§5.10), and
 * `final` is refused on one: a parametric record is applied to be composed, each member of a family composing an
 * application of it.
 *
 * @throws TsonSchemaValidationError per §5.2's refusals.
 */
function applyRecordExtensionMark(
  name: string,
  body: RecordBody,
  mark: 'abstract' | 'final' | undefined,
  parameters: readonly string[],
): RecordBody {
  if (parameters.length > 0 && mark === 'final') {
    throw new TsonSchemaValidationError(
      `'${name}': 'final' is refused on a parametric record -- a parametric record is applied to be ` +
        'composed, each member of a family composing an application of it, and the mark would forbid that ' +
        "of every application. Declare a record composing the application and mark it instead, 'x => final " +
        `${name}<...> & { }' ([TSON-SCHEMA] §5.2, §5.10)`,
    );
  }
  // §5.2: `final` beside a selector is refused, the members it selects being subtypes that could then never
  // exist.
  if (mark === 'final' && body.discriminators !== undefined) {
    throw new TsonSchemaValidationError(
      `'${name}': 'final' says nothing may extend this record, and a field written '=?' says its members ` +
        'pin that field -- so the members the selector selects could never exist ([TSON-SCHEMA] §5.2)',
    );
  }
  let extension: RecordExtensionType = body.discriminators !== undefined ? 'ABSTRACT' : 'OPEN';
  if (mark === 'abstract') extension = 'ABSTRACT';
  if (mark === 'final') extension = 'FINAL';
  return extension === body.extension ? body : { ...body, extension };
}

/**
 * A record draft as the value its entry holds: the record with its chain and, for a parametric record (§5.10), its
 * `parameters`, each name among its field types and its parents' arguments that one of them declares marked as that
 * parameter. A parametric record keeps its parents as written; a closed record keeps only its applied ones.
 */
function recordValue(draft: Draft, record: RecordBody): Resolved {
  const parameters = draft.parameters;
  const body: RecordBody =
    parameters.length === 0
      ? record
      : checkedParametric(
          withParametersMarked({
            ...record,
            parameters: parameters.map((parameter): Param => ({ name: parameter })),
          }),
        );
  // A parametric record keeps the parents as written, its parameters marked, which closing completes; a closed
  // declaration keeps only its applied parents, for the resolver's fold to turn into edges and drop (§5.8).
  const parents =
    parameters.length > 0
      ? draft.parents.map((parent) => asParameters(parent, parameters))
      : draft.parents.filter((parent) => parent.kind === 'inline');
  const chain = typeChain(draft.supertypes, parents);
  return {
    value: withChain(body, chain),
    ...(draft.head === undefined ? {} : { head: draft.head }),
  };
}

// ── Small pure helpers ───────────────────────────────────────────────────────────────────────

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Indexed access with a runtime backstop instead of a non-null assertion (`eslint.config.js`
 * forbids `!`) -- every call site below is safe by construction (a loop bound to the array's own
 * length, an index already checked in range), so the throw is a defensive invariant check, never
 * a real possibility.
 */
function at<T>(items: readonly T[], index: number, context: string): T {
  const value = items[index];
  if (value === undefined) {
    throw new TsonInternalError(
      `${context}: index ${String(index)} out of bounds for length ${String(items.length)}`,
    );
  }
  return value;
}

/** The {@link at} twin for a `Map` lookup already known to hit, by the same construction argument. */
function requiredGet<K, V>(map: ReadonlyMap<K, V>, key: K, context: string): V {
  const value = map.get(key);
  if (value === undefined) {
    throw new TsonInternalError(`${context}: missing expected key '${String(key)}'`);
  }
  return value;
}

function isRecordBody(body: Top | undefined): body is RecordBody {
  return body !== undefined && (body as { readonly kind?: unknown }).kind === 'record';
}

/**
 * A composition's record before it becomes its entry's value: the type parameters the declaration carries, the
 * closed chain its parents reach, the parents as written (kept only where the declaration is a parametric record,
 * §5.10), and the record itself.
 */
interface Draft {
  readonly parameters: readonly string[];
  readonly supertypes: readonly string[];
  readonly parents: readonly TypeExpr[];
  readonly body: RecordBody;
  readonly head?: string;
}

/**
 * A field's or group member's type (§4.2, §5.2): a name, an application, or a construction written in place --
 * `!meta.dependent { on: kind }` among them -- read through its constructor's reader as a declaration's `!C { ...
 * }` is and held at the field ({@link TypeInline}). Reading one waits on its constructor, and on each type the read
 * reaches, as reading any value does (§3.4.1).
 */
function resolveFieldType(deps: ResolverContext, field: string, ref: FieldTypeExpr): TypeExpr {
  switch (ref.kind) {
    case 'nameRef':
      return { name: ref.name, annotations: [] };
    case 'applicationRef':
      return applicationAt(deps, field, ref);
    case 'inlineConstruction':
      return inlineType(deps, field, ref);
    default:
      throw new TsonInternalError(
        `field '${field}': a sugar form reached resolution unrewritten -- the desugar phase writes every ` +
          'sugar form in place before the definition resolver runs (§5.3)',
      );
  }
}

/**
 * An application at field `field`'s type: over a constructor or an incomplete entry, its construction written in
 * place, read once through the constructor's reader; over anything else the application written in place, its
 * arguments names, which closing a parametric record's application turns into the record it denotes (§5.10). Only
 * a container, a tuple, a choice or a reference is constructed in place; any other construction is declared under
 * a name.
 */
function applicationAt(deps: ResolverContext, field: string, generic: ApplicationRef): TypeExpr {
  const constructed = deps.rewrite.atSlot(generic);
  const written = applicationText(generic);
  if (constructed === undefined) {
    return {
      kind: 'inline',
      head: APPLY,
      of: {
        kind: 'apply',
        head: { name: generic.name, annotations: [] },
        arguments: generic.args.map((argument) => {
          if (argument.kind !== 'nameRef') {
            throw new TsonInternalError(
              `'${written}': an argument that is no name reached resolution`,
            );
          }
          return { name: argument.name, annotations: [] };
        }),
      },
    };
  }
  const constructor = constructed.typeRef ?? '';
  const body = bindAtomInstance(deps, `field '${field}'`, constructed);
  if (!isType(body) || !isConstructibleInPlace(body)) {
    throw new TsonSchemaValidationError(
      `'${written}' constructs a ${isType(body) ? 'type' : 'value'} that is no container, tuple, choice or ` +
        "reference, and only those are written where they are used (§5.2): declare it under a name ('my_" +
        `${generic.name.slice(generic.name.lastIndexOf('.') + 1)} => ${written}') and write that name`,
    );
  }
  return { kind: 'inline', head: constructor, of: withoutChain(body) };
}

/** `generic` as the author wrote it, for a message. */
function applicationText(generic: ApplicationRef): string {
  const argument = (expr: AstTypeExpr): string =>
    expr.kind === 'nameRef'
      ? expr.name
      : expr.kind === 'applicationRef'
        ? applicationText(expr)
        : writtenFormOf(expr);
  return `${generic.name}<${generic.args.map(argument).join(' ')}>`;
}

function isConstructibleInPlace(type: Type): boolean {
  return (
    type.kind === 'array' ||
    type.kind === 'map' ||
    type.kind === 'tuple' ||
    type.kind === 'choice' ||
    type.kind === 'ref'
  );
}

/**
 * The type a construction written in place at field `field` denotes: a container, a tuple, a choice, a reference,
 * a dependent type or a record. The head is made ready first, as a declaration's `!C { ... }` makes its own
 * (§3.4.1); it is held past its alias hops (§8.3).
 */
function inlineType(deps: ResolverContext, field: string, inline: InlineConstruction): TypeInline {
  const where = `field '${field}'`;
  const constructor = resolveConstructorTarget(deps, where, inline.value.typeRef ?? '').name;
  const payload = deps.rewrite.inPlace(readAsConstructor(inline.value, constructor), true);
  const body = bindAtomInstance(deps, where, payload);
  if (!isType(body)) {
    throw new TsonInternalError(
      `${where}: the construction '!${constructor} { ... }' written in place built no type`,
    );
  }
  const type = asWritten(deps, withoutChain(body), payload);
  const held: TypeInline = { kind: 'inline', head: constructor, of: type };
  const refusal = inlineRefusal(held);
  if (refusal !== undefined) throw new TsonSchemaValidationError(`${where}: ${refusal}`);
  return held;
}

/**
 * `body`, read from `written`, with each field of a record written in place as its source wrote it: desugaring
 * writes a record in place as the value of its construction, which has no room for annotations that resolve in
 * this schema's namespace, so each is found against the field's `meta.record_field` value ({@link WRITTEN_FIELDS})
 * and restored here.
 */
function asWritten(deps: ResolverContext, body: Type, written: DataValue): Type {
  if (body.kind !== 'record' || written.coreValue.kind !== 'record') return body;
  const fieldsWritten = written.coreValue.fields.find((f) => f.name === FIELDS)?.value.coreValue;
  if (fieldsWritten?.kind !== 'map') return body;
  const restored = new Map<string, Annotations>();
  for (const entry of fieldsWritten.entries) {
    const kept = WRITTEN_FIELDS.get(entry.value);
    const key = entry.key.coreValue;
    if (kept === undefined || kept.annotations.length === 0 || key.kind !== 'token') continue;
    restored.set(key.text, annotationsOf(deps, key.text, kept.annotations));
  }
  if (restored.size === 0) return body;
  return {
    ...body,
    fields: fieldMapOf(
      namedFields(body).map((field) => ({
        ...field,
        annotations: restored.get(field.name) ?? field.annotations,
      })),
      body.fields.keyAnnotations,
    ),
  };
}

// ── Top-level dispatch (§5, §8) ──────────────────────────────────────────────────────────────

function resolveTypeDef(deps: ResolverContext, name: string, typeDef: TypeDef): Resolved {
  switch (typeDef.kind) {
    case 'structuralTypeDef': {
      // A fresh record or a composition is a constructor only by actually composing IS-A `top` below: the
      // chain is built from what the declaration's own body names, and `isConstructor` reads it off the result.
      const parameters = typeDef.typeParams;
      const body = typeDef.body;
      if (body.kind === 'recordDef') {
        const recordBody = applyRecordExtensionMark(
          name,
          resolveRecordBody(deps, body.entries, parameters),
          typeDef.mark,
          parameters,
        );
        return recordValue(
          { parameters, supertypes: [], parents: [], body: recordBody },
          recordBody,
        );
      }
      const draft = resolveComposition(deps, name, body, parameters);
      const recordBody = applyRecordExtensionMark(name, draft.body, typeDef.mark, parameters);
      return recordValue({ ...draft, body: recordBody }, recordBody);
    }
    case 'typeExprDef': {
      // A parameter list before a reference -- a parametric alias -- is refused by the desugar phase (§5.10).
      if (typeDef.typeParams.length > 0) {
        throw new TsonInternalError(
          `'${name}': a parameter list before a reference reached resolution -- the desugar phase refuses one`,
        );
      }
      if (typeDef.ref.kind === 'nameRef') {
        return { value: { kind: 'alias', target: { name: typeDef.ref.name, annotations: [] } } };
      }
      if (typeDef.ref.kind === 'applicationRef') {
        return resolveApplication(deps, name, typeDef.ref);
      }
      // Every declaration-level sugar form is rewritten into the construction it denotes before resolution
      // (§5.3), and a construction in place stands only at a field's type.
      throw new TsonInternalError(
        `'${name}': a sugar form reached resolution unrewritten -- the desugar phase writes every sugar form ` +
          'as its construction before the definition resolver runs (§5.3)',
      );
    }
    case 'instance':
      return typeDef.typeParams.length === 0
        ? resolveInstance(deps, name, typeDef, DESUGARED.has(typeDef.value))
        : parametricInstance(deps, name, typeDef);
    case 'atomRefinement':
      return resolveAtomRefinement(deps, name, typeDef);
    // A schema map nested as an entry: a value of `meta.schema` whose members are declarations of this
    // document under their paths, each resolved as any entry is. Its map is built from them wherever the
    // schema is (`schema/meta/schemaPaths.ts`), so it holds none here and waits on none.
    case 'schemaMapDef':
      return {
        value: {
          kind: 'value_entry',
          type: SCHEMA,
          value: { form: 'schema_map', members: namespaceOf(SCHEMA, []) },
        },
        head: SCHEMA,
      };
  }
}

/**
 * `<T> !C value` -- a parameter list before a construction. A parametric record's body is a record body (§5.10),
 * so it is admitted before `meta.record` alone, past its alias hops, as the explicit spelling of a parametric
 * record; before a constructor it is refused with what to write instead, and before an ordinary type, whose value
 * is no record body at all, with one declaration per instantiation.
 */
function parametricInstance(deps: ResolverContext, name: string, instance: Instance): Resolved {
  const target = requireTypeRef(instance.value, `'${name}'`);
  const head = resolveConstructorTarget(deps, name, target);
  if (head.name === metaName('record')) return parametricRecord(deps, name, instance);
  const prefix =
    `'${name}': a parametric record's body is a record body -- braces or a composition (§5.10) -- and ` +
    `'!${target} { ... }' `;
  if (isConstructor(head.definition, head.name)) {
    const open =
      head.name === metaName('array')
        ? `'nonempty => !${target} ^ { min_items: 1 }'`
        : `'my_${target.slice(target.lastIndexOf('.') + 1)} => !${target} ^ { ... }'`;
    throw new TsonSchemaValidationError(
      `${prefix}constructs '${target}'. Write the application where it is used ('${target}<...>'), or ` +
        `leave its construction open (${open}) and complete it where it is used`,
    );
  }
  throw new TsonSchemaValidationError(
    `${prefix}is a value of the type '${target}', no type, and a parametric record over a value is no ` +
      `record. Declare one value per instantiation ('order_api => !${target} { ... }'), or carry what varies ` +
      'as data of the type',
  );
}

/**
 * `<T> !meta.record { … }` -- a parametric record in its explicit spelling, read against `record`'s own vocabulary as
 * any record is, with the declaration's parameters added (§5.10). What the author wrote is answered first, in the
 * terms they wrote it in -- a construction of `meta.record` -- so a binding the record does not declare names the
 * record's vocabulary, and a parameter at a slot that names no type is refused for standing there
 * ({@link checkSlots}) rather than for not reading as a boolean.
 */
function parametricRecord(deps: ResolverContext, name: string, instance: Instance): Resolved {
  const record = metaName('record');
  const vocabulary = resolveConstructorTarget(deps, name, record).definition;
  if (!isRecordBody(vocabulary)) {
    throw new TsonInternalError(`'${name}': constructor '${record}' is no record`);
  }
  const payload = instance.value;
  refuseWrittenParameters(name, record, payload);
  refuseWrittenChain(name, payload);
  const bindings = payload.coreValue;
  if (bindings.kind !== 'record') {
    throw new TsonSchemaValidationError(
      `'${name}': a parametric record's explicit body is a braced record of '${record}' bindings (§5.10)`,
    );
  }
  checkParametricBindings(name, record, vocabulary, bindings);
  checkSlots(instance.typeParams, payload, deps.metaDefinitions);
  refuseLiteralOnParameter(payload, instance.typeParams);
  const rewritten = deps.rewrite.inPlace(payload, false).coreValue;
  const fields = rewritten.kind === 'record' ? [...rewritten.fields] : [];
  fields.push({
    name: PARAMETERS,
    value: {
      annotations: [],
      coreValue: {
        kind: 'array',
        elements: instance.typeParams.map((parameter) => ({
          annotations: [],
          coreValue: {
            kind: 'record',
            fields: [
              {
                name: 'name',
                value: {
                  annotations: [],
                  coreValue: { kind: 'token', text: parameter, form: 'unquoted' },
                },
              },
            ],
          },
        })),
      },
    },
  });
  const built = bindAtomInstance(deps, name, {
    annotations: payload.annotations,
    typeRef: record,
    coreValue: { kind: 'record', fields },
  });
  if (built.kind !== 'record' || !isParametric(built)) {
    throw new TsonInternalError(
      `'${name}': '!${record} { ... }' with parameters bound to something other than a parametric record`,
    );
  }
  return { value: checkedParametric(withParametersMarked(built)), head: record };
}

/**
 * §5.10's two declaration-time questions about a parametric record's explicit payload: a binding `record` does not
 * declare, and a required field nothing binds, so no application could build one.
 */
function checkParametricBindings(
  name: string,
  target: string,
  vocabulary: RecordBody,
  bindings: RecordValue,
): void {
  const bound = new Set<string>();
  for (const binding of bindings.fields) {
    if (!vocabulary.fields.entries.has(binding.name)) {
      throw new TsonSchemaValidationError(
        `'${name}': '${target}' has no field '${binding.name}' to bind (§7.2) -- its fields are ` +
          `[${[...vocabulary.fields.entries.keys()].join(', ')}]`,
      );
    }
    bound.add(binding.name);
  }
  for (const [field, declared] of vocabulary.fields.entries) {
    if (!declared.optional && declared.value === undefined && !bound.has(field)) {
      throw new TsonSchemaValidationError(
        `'${name}': '${target}' requires a '${field}', and nothing binds it (§7.2), so no application of this ` +
          'parametric record could build one',
      );
    }
  }
}

/**
 * The literal-on-a-parameter rule over the payload not yet bound, for a field whose whole type is a parameter: read
 * against `record_field` its literal `value` would be read against a type nothing declares, so it is refused for
 * where it stands before the reader is asked (§5.10).
 */
function refuseLiteralOnParameter(payload: DataValue, parameters: readonly string[]): void {
  if (payload.coreValue.kind !== 'record') return;
  for (const binding of payload.coreValue.fields) {
    const fields = binding.value.coreValue;
    if (binding.name !== FIELDS || fields.kind !== 'map') continue;
    for (const entry of fields.entries) {
      const field = entry.value.coreValue;
      const key = entry.key.coreValue;
      if (field.kind !== 'record' || key.kind !== 'token') continue;
      const parameter = tokenAt(field, 'type');
      const literal = tokenAt(field, 'value');
      if (parameter !== undefined && parameters.includes(parameter) && literal !== undefined) {
        throw literalOnParameterType(key.text, parameter, literal);
      }
    }
  }
}

/** The token `record` holds at `slot`, as written; `undefined` where it holds none. */
function tokenAt(record: RecordValue, slot: string): string | undefined {
  const value = record.fields.find((field) => field.name === slot)?.value.coreValue;
  return value?.kind === 'token' ? value.text : undefined;
}

function literalOnParameterType(
  field: string,
  parameter: string,
  literal: string,
): TsonSchemaValidationError {
  return new TsonSchemaValidationError(
    `field '${field}' is typed by the parameter '${parameter}' and carries the literal value '${literal}' -- a ` +
      "literal needs a closed type, and this field's type differs in every application. Write no value here, and " +
      `state it where the application is declared: 'name => head<argument> & { ${field}?: = value }' (§5.10)`,
  );
}

/**
 * A declaration whose body is an application, `name => H<args>` (§5.3, §5.10). Over a constructor it is the
 * construction it spells, resolved exactly as `!C { ... }` is, its tag the head as written; over an incomplete
 * entry the completion. Over a parametric record it is the entry it denotes, the substituted record under this
 * name (§8.2).
 */
function resolveApplication(
  deps: ResolverContext,
  name: string,
  generic: ApplicationRef,
): Resolved {
  const constructed = deps.rewrite.body(generic);
  if (constructed !== undefined) {
    return resolveInstance(
      deps,
      name,
      { kind: 'instance', typeParams: [], value: constructed },
      true,
    );
  }
  if (!namesOnly(generic)) {
    // Which parametric record is applied, and to how many arguments, is judged before what the arguments are.
    const definition = deps.namespaceDefinitions(
      Ancestry.parametricHead(generic.name, deps.namespaceDefinitions),
    );
    if (!isParametric(definition) || parametersOf(definition).length !== generic.args.length) {
      throw unclosed(deps, name, generic.name, generic.args.length);
    }
    throw argumentNotANameIn(generic);
  }
  // This declaration owns the entry. An undefined answer means it cannot -- an unresolved head or an arity mismatch
  // -- and the verdict is given here.
  if (deps.applicationCloser === undefined) {
    const definition = deps.namespaceDefinitions(
      Ancestry.parametricHead(generic.name, deps.namespaceDefinitions),
    );
    if (isParametric(definition) && parametersOf(definition).length === generic.args.length) {
      throw new TsonInternalError(
        `'${name}': closing the application '${applicationText(generic)}' needs an application closer, and ` +
          'this resolver was built without one (§5.10)',
      );
    }
    throw unclosed(deps, name, generic.name, generic.args.length);
  }
  const owned = deps.applicationCloser.closeApplicationInto(name, names(generic));
  if (owned !== undefined) return { value: owned, head: metaName('record') };
  throw unclosed(deps, name, generic.name, generic.args.length);
}

/**
 * Why a declaration naming `head` applied to `supplied` arguments could not be closed into it: its head names
 * nothing, takes no arguments, or takes another number of them (§5.10).
 */
function unclosed(
  deps: ResolverContext,
  name: string,
  head: string,
  supplied: number,
): TsonSchemaValidationError {
  const definition = deps.namespaceDefinitions(
    Ancestry.parametricHead(head, deps.namespaceDefinitions),
  );
  if (definition === undefined) {
    return new TsonSchemaValidationError(`'${name}' has an unresolved reference '${head}'`);
  }
  const extern = terminalExtern(head, deps.namespaceDefinitions);
  if (extern !== undefined) {
    return sealedExtern(
      `'${name}'`,
      `'${head}<...>' applies`,
      head,
      terminal(head, deps.namespaceDefinitions),
      extern,
    );
  }
  const parameters = parametersOf(definition).map((parameter) => parameter.name);
  if (parameters.length === 0) {
    return new TsonSchemaValidationError(
      `'${head}' declares no type parameters, so '${head}<...>' applies arguments to something that takes ` +
        'none (§5.10); drop the argument list',
    );
  }
  return new TsonSchemaValidationError(
    `'${head}' takes ${String(parameters.length)} type argument${parameters.length === 1 ? '' : 's'} ` +
      `[${parameters.join(', ')}], but ${String(supplied)} ${supplied === 1 ? 'was' : 'were'} applied (§5.10)`,
  );
}

/** Whether every argument of `generic` is a name. */
function namesOnly(generic: ApplicationRef): boolean {
  return generic.args.every((argument) => argument.kind === 'nameRef');
}

/** `generic`, every argument a name, as the application it is (§5.10). */
function names(generic: ApplicationRef): ApplyBody {
  return {
    kind: 'apply',
    head: { name: generic.name, annotations: [] },
    arguments: generic.args.map((argument) => ({
      name: argument.kind === 'nameRef' ? argument.name : '',
      annotations: [],
    })),
  };
}

/** The refusal of `generic`'s first argument that is no name (§5.3). */
function argumentNotANameIn(generic: ApplicationRef): TsonSchemaValidationError {
  const written = applicationValue(generic);
  const listed =
    written.coreValue.kind === 'record'
      ? written.coreValue.fields.find((field) => field.name === 'arguments')?.value.coreValue
      : undefined;
  const argument =
    listed?.kind === 'array'
      ? listed.elements.find(
          (each) => each.typeRef !== undefined || each.coreValue.kind !== 'token',
        )
      : undefined;
  if (argument === undefined) {
    throw new TsonInternalError(
      `'${applicationText(generic)}': no argument that is no name was found`,
    );
  }
  return argumentNotAName(writtenText(argument), suggestedNameOf(argument), writtenText(written));
}

// ── Constructor application (§5.5, §5.6) ────────────────────────────────────────────────────

function requireTypeRef(value: DataValue, context: string): string {
  if (value.typeRef === undefined) {
    throw new TsonInternalError(
      `${context}: normalized value has no type-ref naming its own constructor`,
    );
  }
  return value.typeRef;
}

/**
 * `!C value` (constructor application, no `^`) -- a fresh instance filled with `value`.
 *
 * `C` resolves in the schema's one namespace (§3.3.1), past its alias hops. Over an incomplete entry the payload
 * completes it ({@link complete}). Where `C` is no constructor -- not IS-A `top` (§4.1) -- the entry is a value of
 * the type `C` ({@link resolveValueEntry}). Construction transfers only `C`'s kind (§5.5): no supertypes, no
 * parameters -- except for an alias, where the result is the entry `name => X` denotes. `desugared` says the
 * desugar phase wrote the payload, so every application in it is the author's sugar.
 */
function resolveInstance(
  deps: ResolverContext,
  name: string,
  instance: Instance,
  desugared: boolean,
): Resolved {
  const target = requireTypeRef(instance.value, `'${name}'`);
  const head = resolveConstructorTarget(deps, name, target);
  if (head.definition.kind === 'incomplete') {
    return complete(deps, name, target, head.name, head.definition, instance.value, desugared);
  }
  refuseDeclaredApplication(name, head.name, instance.value);
  refuseDeclaredDependent(name, head.name, instance.value);
  refuseWrittenParameters(name, head.name, instance.value);
  if (isParametric(head.definition)) {
    const declared = (head.definition as RecordBody).parameters ?? [];
    throw new TsonSchemaValidationError(
      `'${name}': '${target}' is a parametric record taking ${String(declared.length)} type argument` +
        `${declared.length === 1 ? '' : 's'} [${declared.map((parameter) => parameter.name).join(', ')}], and a ` +
        `parametric record closes by application, not by construction -- write '${target}<...>' with its ` +
        `arguments (§5.10). '!${target} { ... }' fills a constructor's own vocabulary (§4.2), which is a ` +
        'different operation and needs a closed constructor',
    );
  }
  if (!isConstructor(head.definition, head.name)) {
    return resolveValueEntry(deps, name, target, head, instance.value);
  }
  if (!isRecordBody(head.definition)) {
    throw new TsonInternalError(
      `'${name}': constructor '${target}' has a non-record body; a constructor is record-shaped (§7.2) and ` +
        'cannot be declared otherwise',
    );
  }
  refuseAbstractConstructor(deps, name, target, head.definition);
  refuseWrittenChain(name, instance.value);
  const payload = deps.rewrite.inPlace(readAsConstructor(instance.value, head.name), desugared);
  const read = bindAtomInstance(deps, name, payload);
  // `!meta.alias { target: X }` is the explicit spelling of the alias `name => X` (§8.3): the same entry.
  if (read.kind === 'alias') return { value: read };
  // A record's form states `extension` itself, and `discriminators` beside anything but ABSTRACT is refused
  // rather than overridden (§5.2, item 133).
  if (read.kind === 'record') {
    const refusal = discriminatorsRefusal(read, `'${name}'`);
    if (refusal !== undefined)
      throw new TsonSchemaValidationError(`${refusal} ([TSON-SCHEMA] §5.2)`);
  }
  const value = isType(read) ? asWritten(deps, read, payload) : read;
  return { value, head: target };
}

/**
 * `!X { … }`, `!X [ … ]` or a declaration's `X<A …>`, `X` incomplete (§5.5): the plain construction of `X`'s
 * constructor over what `X` writes and what the completion adds, read whole by that constructor's reader. It
 * carries no chain: a completion is equal to the same construction written directly. What it closed, `baseName`
 * and `base`'s bases, is recorded for its key (§8.1).
 */
function complete(
  deps: ResolverContext,
  name: string,
  target: string,
  baseName: string,
  base: IncompleteEntry,
  payload: DataValue,
  desugared: boolean,
): Resolved {
  const constructor = incompleteConstructor(deps, name, base);
  refuseWrittenChain(name, payload);
  const body = IncompleteEntries.completed(
    name,
    target,
    base,
    constructor,
    deps.rewrite.inPlace(payload, desugared),
  );
  refuseDeclaredApplication(name, base.head, body);
  refuseWrittenParameters(name, base.head, body);
  const read = bindAtomInstance(deps, name, body);
  deps.completions.set(name, { of: IncompleteEntries.closedThrough(baseName, base) });
  return { value: isType(read) ? asWritten(deps, read, body) : read, head: base.head };
}

/** The constructor `incomplete` builds, ready since `incomplete` was. */
function incompleteConstructor(
  deps: ResolverContext,
  name: string,
  incomplete: IncompleteEntry,
): RecordBody {
  const constructor = deps.namespaceDefinitions(incomplete.head);
  if (!isRecordBody(constructor)) {
    throw new TsonInternalError(
      `'${name}': an incomplete entry builds '${incomplete.head}', which is no constructor`,
    );
  }
  return constructor;
}

/**
 * Refuses `meta.apply` constructed as a declaration's body (§5.10): an application is written in place, and a
 * declared one is written `name => H<args>`. Tested at the end of the head's alias chain (§8.3).
 */
function refuseDeclaredApplication(name: string, head: string, written: DataValue): void {
  if (head !== APPLY) return;
  const spelled = writtenText(readAsConstructor(written, APPLY));
  throw new TsonSchemaValidationError(
    `'${name}': '!${written.typeRef ?? APPLY} { ... }' is written as a declaration's body, and an application ` +
      `is written in place, never as a declaration's body (§5.10): declare it as '${name} => ` +
      `${spelled.includes('<') ? spelled : 'H<args>'}', whose value is the type it closes or constructs to (§8.2)`,
  );
}

/**
 * The rules a parametric record answers to, checked against its parameters (§5.10): a parameter is a type, so it is
 * never a field's name or the record's name type, and a selector and a literal value each need a closed type -- a
 * field typed by a parameter, whole, as an argument or at a slot in place, has a different type in every
 * application, so it is no selector and takes no value, in the record and in every record written in place inside it.
 */
function checkedParametric(record: RecordBody): RecordBody {
  const names = new Set((record.parameters ?? []).map((parameter) => parameter.name));
  for (const field of record.fields.entries.keys()) {
    if (names.has(field)) throw standsAt(field, 'a key of meta.record.fields');
  }
  if (record.nameType !== undefined && names.has(record.nameType)) {
    throw standsAt(record.nameType, 'meta.record.name_type');
  }
  for (const name of record.discriminators ?? []) {
    const field = record.fields.entries.get(name);
    const parameter = field === undefined ? undefined : parameterIn(field.type);
    if (field === undefined || parameter === undefined) continue;
    const typed =
      field.type.kind !== 'inline' && field.type.param === true
        ? 'typed by the type parameter'
        : 'typed by an application of the parameter';
    throw new TsonSchemaValidationError(
      `discriminator field '${name}' is ${typed} '${parameter}', and a position typed by this parametric record ` +
        'reads a discriminator before it knows which member it has -- so its type cannot vary per application ' +
        '(§5.10)',
    );
  }
  refuseLiteralsOnParameterTypes(record);
  return record;
}

/** A literal on a field typed by a parameter, in `record` and in each record written in place inside it (§5.10). */
function refuseLiteralsOnParameterTypes(record: RecordBody): void {
  for (const field of namedFields(record)) {
    const parameter = parameterIn(field.type);
    if (parameter !== undefined && field.value !== undefined) {
      throw literalOnParameterType(field.name, parameter, field.value.text);
    }
  }
  mapInPlace(record, (inline) => {
    if (inline.of.kind === 'record') refuseLiteralsOnParameterTypes(inline.of);
    return inline;
  });
}

/**
 * Refuses `meta.dependent` constructed as a declaration's body (§5.2): a dependent type is a variable bound by the
 * record it stands in, written in place directly at a record field's type, and never declared.
 */
function refuseDeclaredDependent(name: string, head: string, written: DataValue): void {
  if (head !== metaName('dependent')) return;
  throw new TsonSchemaValidationError(
    `'${name}': '!${written.typeRef ?? head} { ... }' declares a dependent type, which is written in place only, ` +
      "directly at a record field's type ('kind!'), the field naming its sibling in the same record (§5.2)",
  );
}

/**
 * Refuses `parameters` written in a construction of `meta.record`: a parametric record's parameters are declared by
 * the list before its body (§5.10), which is what puts them in scope. Tested at the end of the head's alias chain.
 */
function refuseWrittenParameters(name: string, head: string, written: DataValue): void {
  if (
    head === metaName('record') &&
    written.coreValue.kind === 'record' &&
    written.coreValue.fields.some((field) => field.name === PARAMETERS)
  ) {
    throw new TsonSchemaValidationError(
      `'${name}': '!${head}' states 'parameters', which a construction never writes -- a parametric record's ` +
        `parameters are the list written before its body, '${name} => <T> { ... }' (§5.10)`,
    );
  }
}

/**
 * `name => !T { ... }` where `T` is no constructor: a value entry, an instance of the ordinary type `T`
 * (§4.1), its payload read against `T` as a data value is and held as the value ({@link ValueEntry}). It
 * is no type, and its tag is `T`.
 *
 * Refused: a head that is itself a value, since a value has no instances; and a braced payload at an atom
 * type, which reads as no value of it and is almost always an atom refinement missing its `^`.
 */
function resolveValueEntry(
  deps: ResolverContext,
  name: string,
  target: string,
  head: ConstructorHead,
  payload: DataValue,
): Resolved {
  if (isValueEntry(head.definition)) {
    throw new TsonSchemaValidationError(
      `'${name}': '!${target}' names a value of the type '${head.definition.type}', and a value has no ` +
        "instances -- '!T { ... }' builds a value of the type T",
    );
  }
  if (isAtom(head.definition) && payload.coreValue.kind === 'record') {
    throw new TsonSchemaValidationError(
      `'${name}': '!${target}' is an atom, and a braced body is no value of it, so there is nothing for ` +
        `'!${target} { ... }' to build. Did you mean atom refinement ('!${target} ^ { ... }')?`,
    );
  }
  if (deps.definitionValueReader === undefined) {
    throw new TsonInternalError(
      `'${name}': '!${target}' builds a value entry, and this resolver was built without a value reader`,
    );
  }
  let value;
  try {
    value = deps.definitionValueReader(head.name, readAsConstructor(payload, head.name));
  } catch (e) {
    if (e instanceof TsonReadError) {
      throw new TsonSchemaValidationError(
        `'${name}': the body is no value of the type '${head.name}' -- ${e.message}`,
        { cause: e },
      );
    }
    if (e instanceof TsonNameHygieneRefusedError) {
      throw new TsonNameHygieneRefusedError(`'${name}': ${e.message}`, {
        mechanism: e.mechanism,
        names: e.names,
        uts39Version: e.uts39Version,
        pointer: `/${name}`,
        cause: e,
      });
    }
    throw e;
  }
  return { value: { kind: 'value_entry', type: target, value }, head: target };
}

/**
 * A type's `chain` is the resolver's (§4.1): computed from composition and refinement, inverted by
 * the linker, and written by no declaration -- as `choice.disjoint` is not. A construction or an
 * atom refinement binding it states a claim no declaration makes; `n => base & { ... }` and
 * `!int32 ^ { ... }` are the declarations that mean one.
 */
function refuseWrittenChain(name: string, value: DataValue): void {
  if (value.coreValue.kind !== 'record') return;
  if (!value.coreValue.fields.some((field) => field.name === CHAIN_FIELD)) return;
  throw new TsonSchemaValidationError(
    `'${name}' writes 'chain', which is the resolver's: a type's IS-A chain is computed from its ` +
      'composition and refinement and inverted by the linker, and no declaration writes it (§4.1, ' +
      "§5.7, §5.8). Compose or refine to state an IS-A edge ('n => base & { ... }', " +
      "'!int32 ^ { ... }')",
  );
}

/** The one field `type` declares, every type body's chain (§4.1). */
const CHAIN_FIELD = 'chain';

/**
 * §5.2: an ABSTRACT record has no instances of its own, and the kernel's `top`, `type`, `atom`,
 * `product`, `sum` and `namespace` are abstract (§4.1) -- so `!atom {}` is refused as any
 * abstract record's direct application is, naming the constructors below it that would answer:
 * only the instantiable ones, an abstract subtype being no answer.
 */
function refuseAbstractConstructor(
  deps: ResolverContext,
  name: string,
  target: string,
  constructor: RecordBody,
): void {
  if (constructor.extension !== 'ABSTRACT') return;
  const instantiable = subtypesOf(constructor).filter((subtype) => {
    const value = deps.metaDefinitions(subtype);
    return value !== undefined && !(isRecordBody(value) && value.extension === 'ABSTRACT');
  });
  throw new TsonSchemaValidationError(
    `'${name}': '!${target}' is abstract and has no instances of its own (§4.1, §5.2) -- ` +
      (instantiable.length === 0
        ? 'nothing below it is instantiable either'
        : `apply one of the constructors below it instead: ${instantiable.join(', ')}`),
  );
}

// ── Atom refinement (§5.5, §5.7) ─────────────────────────────────────────────────────────────

/**
 * `!I ^ { values }` (§5.5, §5.7). `I` resolves in the schema's one namespace, past its alias hops (an alias is a
 * hop, not a supertype, §8.3). Four sources take the spelling:
 *
 * - an incomplete entry, whose further fields it writes ({@link refineIncomplete});
 * - a constructor of types, whose construction it leaves open, an incomplete entry ({@link constructOpen});
 * - a type a collection constructor built, refined by its facets' kinds;
 * - an atom instance, whose constructor's constraint fields it tightens, merging with `I`'s own bound value so a
 *   chained refinement carries its ancestor's constraints forward ({@link mergeWithSource}). The refinement is
 *   written under the constructor its source was built with and IS-A its source and everything the source IS-A.
 */
function resolveAtomRefinement(
  deps: ResolverContext,
  name: string,
  refinement: AtomRefinement,
): Resolved {
  const written = refinement.target;
  if (deps.namespaceDefinitions(written) === undefined) {
    throw new TsonSchemaValidationError(
      `'${name}': '!${written}' names no entry of this schema's namespace (§3.3.1)`,
    );
  }
  const sourceName = terminal(written, deps.namespaceDefinitions);
  const source = deps.namespaceDefinitions(sourceName);
  if (source === undefined) {
    throw new TsonSchemaValidationError(
      `'${name}': '!${written}' is an alias whose chain ends at '${sourceName}', which names no entry (§8.3)`,
    );
  }
  if (source.kind === 'extern') {
    throw sealedExtern(`'${name}'`, "'^' refines", written, sourceName, source);
  }
  if (source.kind === 'incomplete') {
    return refineIncomplete(deps, name, written, sourceName, source, refinement.bindings);
  }
  if (constructs(sourceName, source)) {
    return constructOpen(
      deps,
      name,
      written,
      sourceName,
      source as RecordBody,
      refinement.bindings,
    );
  }
  if (isType(source) && collectionConstructor(deps, sourceName, source) !== undefined) {
    return refineCollection(deps, name, sourceName, source, refinement.bindings);
  }
  if (!isAtom(source)) {
    throw new TsonSchemaValidationError(
      `'${name}': '!${written} ^ { ... }' needs an atom instance, an array or a map type to narrow, or a ` +
        `constructor of types to build from (§5.5), and '${written}' is ` +
        (isConstructor(source, sourceName)
          ? `a constraint vocabulary -- '^' narrows one of its instances. Did you mean constructor ` +
            `application ('!${written} { ... }')?`
          : source.kind === 'record'
            ? `a record, which takes no '^' -- its fields are restated in a composition, '${written}` +
              `${isParametric(source) ? '<...>' : ''} & { ... }' (§5.8)`
            : `a '!${headOf(deps, sourceName, source)}' value, which is finished and takes no refinement`),
    );
  }
  refuseWrittenChain(name, refinement.bindings);
  const constructorName = headOf(deps, sourceName, source);
  // An enum's `name_type` is fixed where it is constructed, and restated by the entry it reaches (§5.7, §8.3).
  const bindings =
    source.kind === 'enum'
      ? restatedByEntry(
          deps,
          name,
          sourceName,
          new Map([[NAME_TYPE_FIELD, source.nameType]]),
          refinement.bindings,
          enumNameTypeReplaced,
        )
      : refinement.bindings;
  const merged = mergeWithSource(deps, name, withoutChain(source), bindings, constructorName);
  const body = bindAtomInstance(deps, name, merged);
  checkNarrows(name, written, source, body);
  return {
    value: withChain(body, typeChain(ofParent(deps, written))),
    head: constructorName,
  };
}

/** The constructors whose instances `^` refines by their facets' kinds (§5.7): an array's and a map's. */
const COLLECTION_CONSTRUCTORS: ReadonlySet<string> = new Set([metaName('array'), metaName('map')]);

/**
 * The constructor that built `source`, where it is `meta.array`, `meta.map` or a constructor IS-A either,
 * `meta.namespace` among them (§5.7).
 */
function collectionConstructor(
  deps: ResolverContext,
  sourceName: string,
  source: Type,
): string | undefined {
  const constructorName = terminal(headOf(deps, sourceName, source), deps.metaDefinitions);
  const constructor = deps.metaDefinitions(constructorName);
  if (!isRecordBody(constructor)) return undefined;
  const collection = [constructorName, ...supertypesOf(constructor)].some((ancestor) =>
    COLLECTION_CONSTRUCTORS.has(ancestor),
  );
  return collection ? constructorName : undefined;
}

/**
 * `!T ^ { … }`, `T` a type a collection constructor built ({@link collectionConstructor}): a refinement by the same
 * constructor, IS-A `T` and its chain, each written facet judged by its kind over effective values (§5.7,
 * `collectionFacets.ts`). A pinned field is a facet fixed at construction, which a refinement restates as a value
 * or leaves alone: the constructor's reader compares a written value against the pin.
 */
function refineCollection(
  deps: ResolverContext,
  name: string,
  sourceName: string,
  source: Type,
  bindings: DataValue,
): Resolved {
  const constructorName = collectionConstructor(deps, sourceName, source);
  const constructor =
    constructorName === undefined ? undefined : deps.metaDefinitions(constructorName);
  if (
    constructorName === undefined ||
    !isRecordBody(constructor) ||
    !CollectionFacets.isCollection(source)
  ) {
    // A schema's own composition of a collection constructor builds no type here, so nothing it built reaches this.
    throw new TsonNotImplementedError(
      `'${name}': refining '!${sourceName}', built by '${constructorName ?? headOf(deps, sourceName, source)}', ` +
        'is not implemented (§5.7)',
    );
  }
  refuseWrittenChain(name, bindings);
  let payload = deps.rewrite.inPlace(bindings, DESUGARED.has(bindings));
  IncompleteEntries.requireDeclared(
    name,
    constructorName,
    constructor,
    bracedPayload(name, sourceName, payload),
  );
  payload = restatedByEntry(
    deps,
    name,
    sourceName,
    namedSlots(source),
    payload,
    CollectionFacets.replaced,
  );
  const body = bindAtomInstance(
    deps,
    name,
    mergeWithSource(deps, name, withoutChain(source), payload, constructorName),
  );
  const violations = CollectionFacets.isCollection(body)
    ? CollectionFacets.narrowing(source, body)
    : [`a '${body.kind}' replaces the source's own ${source.kind} type`];
  if (violations.length > 0) {
    throw new TsonSchemaValidationError(
      `'${name}': not a valid refinement of '!${sourceName}' (§5.7): ${violations.join('; ')}`,
    );
  }
  return {
    value: withChain(body, typeChain(ofParent(deps, sourceName))),
    head: headOf(deps, sourceName, source),
  };
}

/**
 * The type slots of a type a collection constructor built that hold a name, by field name, to that name. A slot
 * holding a type written in place is no name's, so no name restates it.
 */
function namedSlots(source: CollectionFacets.CollectionBody): Map<string, string> {
  const slots: [string, TypeExpr][] =
    source.kind === 'array'
      ? [['element_type', source.elementType]]
      : [
          ['key_type', source.keyType],
          ['value_type', source.valueType],
        ];
  const named = new Map<string, string>();
  for (const [slot, held] of slots) {
    if (held.kind !== 'inline') named.set(slot, held.name);
  }
  return named;
}

/** The kernel's `meta.enum_type` field naming the identifier family an enum's members are names of. */
const NAME_TYPE_FIELD = 'name_type';

/** A family's violation for a fixed facet written as `written` where its source holds `source`. */
type Replaced = (facet: string, source: string, written: string) => string;

/** An enum's: its `name_type` is fixed where it is constructed (§5.7, §7.4). */
const enumNameTypeReplaced: Replaced = (_facet, source, written) =>
  `name_type '${written}' replaces the source's own '${source}'; an enum's name_type is fixed where it is ` +
  'constructed, and a refinement narrows its members';

/**
 * `payload` without each field of `held` it restates by another name, which is judged once every entry is ready
 * ({@link DefinitionResolver.judgeDeferred}) to reach the entry the source's name reaches, and refused with
 * `replaced`'s violation where it does not. A fixed slot is one by the entry its name resolves to and not by
 * spelling, and the resolved value states it as the source wrote it (§5.2, §5.7, §8.3): leaving the field out lets
 * the merge carry the source's spelling. A name at such a slot orders nothing, so waiting on it here would make the
 * refinement wait on what it only names.
 */
function restatedByEntry(
  deps: ResolverContext,
  name: string,
  sourceName: string,
  held: ReadonlyMap<string, string>,
  payload: DataValue,
  replaced: Replaced,
): DataValue {
  const record = payload.coreValue;
  if (record.kind !== 'record') return payload;
  const kept = record.fields.filter((field) => {
    const source = held.get(field.name);
    const token = field.value.coreValue;
    if (
      source === undefined ||
      field.value.typeRef !== undefined ||
      token.kind !== 'token' ||
      token.text === source
    ) {
      return true;
    }
    const written = token.text;
    deps.deferred.push({
      declaration: name,
      check: () => {
        const reached = entryReached(deps, written);
        if (reached === undefined || reached !== entryReached(deps, source)) {
          throw new TsonSchemaValidationError(
            `'${name}': not a valid refinement of '!${sourceName}' (§5.7): ${replaced(field.name, source, written)}`,
          );
        }
      },
    });
    return false;
  });
  if (kept.length === record.fields.length) return payload;
  return {
    ...payload,
    coreValue: kept.length === 0 ? { kind: 'empty-brace' } : { kind: 'record', fields: kept },
  };
}

/** The entry at the end of `written`'s alias chain, or `undefined` where no namespace holds the name. */
function entryReached(deps: ResolverContext, written: string): string | undefined {
  const lookup =
    deps.metaDefinitions(written) !== undefined ? deps.metaDefinitions : deps.namespaceDefinitions;
  return lookup(written) === undefined ? undefined : terminal(written, lookup);
}

/**
 * `!C ^ { … }`, `C` a constructor of types: its construction left open, an incomplete entry, where a required
 * field of `C` is absent (§5.5). Required fields, defaults and coherence across fields wait for the completion,
 * which reads the whole.
 */
function constructOpen(
  deps: ResolverContext,
  name: string,
  target: string,
  constructorName: string,
  constructor: RecordBody,
  bindings: DataValue,
): Resolved {
  refuseAbstractConstructor(deps, name, target, constructor);
  refuseWrittenChain(name, bindings);
  const payload = deps.rewrite.inPlace(bindings, DESUGARED.has(bindings));
  refuseWrittenParameters(name, constructorName, payload);
  const fields = bracedPayload(name, target, payload);
  IncompleteEntries.requireWritable(name, constructorName, constructor, fields);
  const absent = IncompleteEntries.required(constructor).filter((field) => !fields.has(field));
  if (absent.length === 0) {
    throw new TsonSchemaValidationError(
      `'${name}': '!${target} ^ { ... }' writes every required field of '${constructorName}', so nothing is ` +
        `left open -- write the construction '!${target} { ... }' (§5.5)`,
    );
  }
  return {
    value: {
      kind: 'incomplete',
      head: constructorName,
      absent,
      written: IncompleteEntries.record(payload, constructorName, fields),
      read: readEachField(deps, name, constructorName, constructor, fields),
      bases: [],
    },
    head: constructorName,
  };
}

/**
 * Each field of `written` read against the type `constructor` declares it with, where it is written, and what each
 * read (§5.5): a field of an incomplete entry is a value of its declared type completed or not, and the names it
 * holds are judged when the schema links. A field typed by a type written in place names no type to read against,
 * and is read where the entry is completed; a resolution reading no value entries (the kernel's) reads none.
 */
function readEachField(
  deps: ResolverContext,
  name: string,
  constructorName: string,
  constructor: RecordBody,
  written: ReadonlyMap<string, DataValue>,
): Map<string, MetaValue> {
  const read = new Map<string, MetaValue>();
  const reader = deps.definitionValueReader;
  if (reader === undefined) return read;
  for (const [field, value] of written) {
    const type = constructor.fields.entries.get(field)?.type;
    if (type === undefined || type.kind === 'inline') continue;
    try {
      read.set(field, reader(type.name, value));
    } catch (e) {
      if (e instanceof TsonReadError) {
        throw new TsonSchemaValidationError(
          `'${name}': '${field}' is no value of '${type.name}', its type in '${constructorName}' -- ${e.message}`,
          { cause: e },
        );
      }
      if (e instanceof TsonNotImplementedError) {
        throw new TsonNotImplementedError(
          `'${name}': '${field}' cannot yet be read against '${type.name}' -- ${e.message}`,
          { cause: e },
        );
      }
      throw e;
    }
  }
  return read;
}

/**
 * `!X ^ { … }`, `X` incomplete: the fields `X` has not written, a required one left absent (§5.5). The result is
 * another incomplete entry, with no IS-A to `X`.
 */
function refineIncomplete(
  deps: ResolverContext,
  name: string,
  target: string,
  baseName: string,
  base: IncompleteEntry,
  bindings: DataValue,
): Resolved {
  const constructor = incompleteConstructor(deps, name, base);
  refuseWrittenChain(name, bindings);
  const payload = deps.rewrite.inPlace(bindings, DESUGARED.has(bindings));
  refuseWrittenParameters(name, base.head, payload);
  const fields = bracedPayload(name, target, payload);
  IncompleteEntries.requireWritable(name, base.head, constructor, fields);
  IncompleteEntries.requireWrittenOnce(name, target, base, fields);
  const read = readEachField(deps, name, base.head, constructor, fields);
  return {
    value: IncompleteEntries.refined(name, target, base, payload, fields, read, baseName),
    head: base.head,
  };
}

/** A `^` payload's fields; the grammar writes a braced record there, and nothing else is one. */
function bracedPayload(name: string, target: string, payload: DataValue): Map<string, DataValue> {
  const fields = IncompleteEntries.braced(payload);
  if (fields === undefined) {
    throw new TsonSchemaValidationError(
      `'${name}': '!${target} ^' takes a braced record of the constructor's fields (§5.5)`,
    );
  }
  return fields;
}

/** What a closed parent contributes to an IS-A chain (§5.8, `ancestry.ts`). */
function ofParent(deps: ResolverContext, parent: string): string[] {
  return Ancestry.ofParent(parent, deps.namespaceDefinitions);
}

/**
 * §5.7's tightening rule, enforced: a refinement narrows its source's constraints, so a body that
 * *loosens* one is a resolver error rather than a silently accepted override. `refinedBody` is
 * the fully merged result (see {@link mergeWithSource}), not the refinement body alone, so a
 * facet the body never mentioned compares equal to the source's own and tightens vacuously.
 */
function checkNarrows(name: string, sourceName: string, sourceBody: Top, refinedBody: Top): void {
  if (!isAtom(sourceBody) || !isAtom(refinedBody)) return;
  const violations = checkAtomNarrows(sourceBody, refinedBody);
  if (violations.length > 0) {
    // A facet fixed at construction is not widened by a move; it is not movable at all, and the
    // message says which of the two the author did.
    const fixed = violations.every((violation) => violation.includes('is fixed where'));
    throw new TsonSchemaValidationError(
      `'${name}': refinement of '!${sourceName}' ` +
        (fixed
          ? `moves a facet that is fixed at construction (§5.5, §5.7): ${violations.join('; ')}`
          : `widens rather than tightens it (§5.7): ${violations.join('; ')}`),
    );
  }
}

/**
 * §5.7's "Body materialisation" rule, applied to atom refinement (§5.6's chained-refinement
 * merge): `newBindings` merged *over* `sourceBody`'s own already-bound fields, not replacing
 * them. `sourceBody` is converted back to wire form via {@link DefinitionResolverDeps.encodeSourceBody}
 * (this port's replacement for the Java original's `TsonObjectWriter` round trip — see this
 * module's own doc) and merged at the `RecordValue` field level: `newBindings`'s own fields win;
 * anything only `sourceBody` had survives untouched.
 *
 * **Merging before binding, not after, is required.** Binding `newBindings` on its own and
 * merging the two constraint objects afterwards would fail for any constructor with a REQUIRED
 * field carrying no schema default, since the refinement body has no reason to restate a facet
 * its source already fixed. Merging first means the record that reaches the reader is always
 * complete.
 */
function mergeWithSource(
  deps: ResolverContext,
  name: string,
  sourceBody: Top,
  newBindings: DataValue,
  constructorName: string,
): DataValue {
  if (deps.encodeSourceBody === undefined) {
    throw new TsonInternalError(
      `'${name}': merging an atom refinement's source needs a SourceBodyEncoder, and this resolver was built ` +
        'without one',
    );
  }
  const merged = new Map<
    string,
    { readonly name: string; readonly value: RecordValue['fields'][number]['value'] }
  >();
  const sourceEncoded = deps.encodeSourceBody(sourceBody);
  if (sourceEncoded.kind === 'record') {
    for (const field of sourceEncoded.fields) merged.set(field.name, field);
  }
  if (newBindings.coreValue.kind === 'record') {
    for (const field of newBindings.coreValue.fields) {
      merged.set(field.name, inheritOrder(field, merged.get(field.name)));
    }
  } else if (newBindings.coreValue.kind !== 'empty-brace') {
    // The author's error, not a gap: §12.1's `atom-refinement` takes a `record-def`, so this
    // verdict does not change as this library improves.
    throw new TsonSchemaValidationError(
      `'${name}': expected a braced record of constraint bindings (§5.5), found ${newBindings.coreValue.kind}`,
    );
  }
  const mergedRecord: RecordValue = { kind: 'record', fields: [...merged.values()] };
  return {
    annotations: newBindings.annotations,
    typeRef: constructorName,
    coreValue: mergedRecord,
  };
}

/** The member-set facets whose surviving members keep their inherited order (§7.5). */
const ORDERED_BY_INHERITANCE: ReadonlySet<string> = new Set(['members', 'schemes', 'within']);

/**
 * A refinement that shrinks a member set keeps the surviving members in their inherited order
 * (§7.5): `[https http ftp]` refined to `[FTP https]` is `[https ftp]`, whatever order the
 * refinement wrote them in. Members the source does not hold keep their written order after the
 * inherited ones; they are refused by the narrowing check, not reordered away. `schemes` compare
 * with ASCII case folded (§5.5), every other set by its text.
 */
function inheritOrder<F extends { readonly name: string; readonly value: DataValue }>(
  written: F,
  inherited: F | undefined,
): F {
  if (inherited === undefined || !ORDERED_BY_INHERITANCE.has(written.name)) return written;
  const was = inherited.value.coreValue;
  const now = written.value.coreValue;
  if (was.kind !== 'array' || now.kind !== 'array') return written;
  const key = (element: DataValue): string | undefined => {
    const core = element.coreValue;
    if (core.kind !== 'token') return undefined;
    return written.name === 'schemes' ? asciiLowercase(core.text) : core.text;
  };
  const rank = (element: DataValue): number => {
    const wanted = key(element);
    const at = was.elements.findIndex((candidate) => key(candidate) === wanted);
    return at < 0 ? was.elements.length : at;
  };
  const ordered = now.elements
    .map((element, index) => ({ element, index, rank: rank(element) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.element);
  return {
    ...written,
    value: { ...written.value, coreValue: { ...now, elements: ordered } },
  };
}

/** A constructor-application target (`!C value`), resolved through §8.3's chain: the name a compiled reader is keyed by, and the entry it names -- {@link resolveConstructorTarget}'s own result. */
interface ConstructorHead {
  readonly name: string;
  readonly definition: Top;
}

/**
 * A constructor-application target (`!C value`) resolves against the structure namespace only —
 * never the type-name namespace (§3.3.1) — **after following its alias chain** (§8.3): `C`
 * may itself be an alias (`alias_array => array`), and every question this resolver asks of the
 * head from here on — is it a constructor, is it incomplete, whose vocabulary reads the payload — is
 * a question about the entry at the end of the chain, not about the hop. A constructor is always
 * meta-schema vocabulary, declared in the *governing* meta-schema, one hop via `!!meta`.
 *
 * The author's own spelling survives where it is visible: {@link resolveInstance} records `target` (not
 * {@link ConstructorHead.name}) as the entry's head, so the chain stays walkable from resolved output.
 */
function resolveConstructorTarget(
  deps: ResolverContext,
  name: string,
  target: string,
): ConstructorHead {
  if (deps.metaDefinitions(target) === undefined) {
    throw new TsonSchemaValidationError(
      `'${name}': '!${target}' does not resolve against the structure namespace (§3.3.1)`,
    );
  }
  const terminalName = terminal(target, deps.metaDefinitions);
  const atEnd = deps.metaDefinitions(terminalName);
  if (atEnd === undefined) {
    // The walk stopped at a name the structure namespace does not declare -- a broken hop, which
    // is the alias's own problem and not this declaration's, but this is where it becomes visible.
    throw new TsonSchemaValidationError(
      `'${name}': '!${target}' is an alias whose chain ends at '${terminalName}', which the ` +
        'structure namespace does not declare (§8.3)',
    );
  }
  if (atEnd.kind === 'extern') {
    throw sealedExtern(`'${name}'`, `'!${target} { ... }' constructs`, target, terminalName, atEnd);
  }
  if (terminalName !== target && terminalName === EXTERN_HEAD) {
    throw new TsonSchemaValidationError(
      `'${name}': '!${target}' reaches '${terminalName}' through its alias hops, and an extern is written ` +
        `'!${EXTERN_HEAD}': its head is how a document's externs are found before any name resolves ` +
        '([TSON-SCHEMA] §5.13)',
    );
  }
  return { name: terminalName, definition: atEnd };
}

/**
 * `value` re-typed to the name its payload is read against — the terminal of the head's own
 * chain (§8.3), where the author may have written an alias. A no-op for the ordinary case, where
 * they are the same name; the meta-schema's reader table is keyed by the constructor's own name,
 * so an alias reaches one only by asking under it.
 */
function readAsConstructor(value: DataValue, constructorName: string): DataValue {
  return value.typeRef === constructorName ? value : { ...value, typeRef: constructorName };
}

/**
 * Shared by {@link resolveInstance}/{@link resolveAtomRefinement}/{@link openOperand} — reads a
 * type-ref-carrying value against its own constructor's compiled reader, then checks its own
 * internal coherence (§7.4: family coherence is a resolver question, not a data-validation one).
 */
function bindAtomInstance(deps: ResolverContext, name: string, value: DataValue): Top {
  const constructorName = requireTypeRef(value, `'${name}'`);
  let body: Top;
  try {
    body = deps.definitionMetaReader(constructorName, value);
  } catch (e) {
    if (e instanceof TsonReadError) {
      throw bodyIsNotValidData(name, constructorName, e);
    }
    if (e instanceof TsonMissingBindingError) {
      throw new TsonMissingBindingError(`'${name}': ${e.message}`, { cause: e });
    }
    if (e instanceof TsonBindMismatchError) {
      throw new TsonBindMismatchError(`'${name}': ${e.message}`, { cause: e });
    }
    // §8.2: a name a value body holds, refused under the processor's policy (a namespace value's
    // payload, which the linker cannot see into) -- §8.1's refused outcome, kept as one.
    if (e instanceof TsonNameHygieneRefusedError) {
      throw new TsonNameHygieneRefusedError(`'${name}': ${e.message}`, {
        mechanism: e.mechanism,
        names: e.names,
        uts39Version: e.uts39Version,
        pointer: `/${name}`,
        cause: e,
      });
    }
    // A gap the read reached stays one, named against this declaration; anything else is a fault, and propagates as
    // one.
    if (e instanceof TsonNotImplementedError) {
      throw new TsonNotImplementedError(
        `'${name}': failed to bind '${constructorName}' via the compiled meta-schema reader: ${errorMessage(e)}`,
        { cause: e },
      );
    }
    throw e;
  }
  checkCoherent(name, constructorName, body);
  return body;
}

/** §7.4's "Coherence of a body's facets": family coherence between a constructor's own bindings is a resolver question, checked here rather than left to the atom parsers (which would surface it as a library-gap "not implemented", exactly the wrong classification for the author's own mistake). */
function checkCoherent(name: string, constructorName: string, body: Top): void {
  const violations = checkBodyCoherence(body);
  if (violations.length > 0) {
    throw new TsonSchemaValidationError(
      `'${name}': the body's own '${constructorName}' constraints contradict each other: ${violations.join('; ')}`,
    );
  }
}

/** A body the constructor's own vocabulary rejects is the author's error (§7.2), not a coverage gap. */
function bodyIsNotValidData(
  name: string,
  constructorName: string,
  cause: TsonReadError,
): TsonSchemaValidationError {
  return new TsonSchemaValidationError(
    `'${name}': the body is not valid data for '${constructorName}', the constructor's own constraint ` +
      `vocabulary -- ${cause.message}`,
    { cause },
  );
}

// ── Composition (§5.8) and subtraction (§5.9) ───────────────────────────────────────────────

/**
 * `A & B & { ... }`: each supertype's fields and groups are copied into the result, left to
 * right; the trailing body's own entries then resolve against `inheritedFieldIndex` — a body
 * field naming an inherited field tightens it in place (§5.7), a field naming nothing inherited
 * is genuinely new and is appended. `supertypes` (this declaration's own transitive chain)
 * accumulates by induction: `direct + parent.supertypes()` for every direct supertype,
 * deduplicated, since each parent's own `supertypes()` is already its full transitive chain.
 */
function resolveComposition(
  deps: ResolverContext,
  name: string,
  construction: ConstructionDef,
  parameters: readonly string[],
): Draft {
  const directSupertypes: TypeExpr[] = [];
  const transitiveSupertypes: string[] = [];
  const seenTransitive = new Set<string>();
  const fields: NamedField[] = [];
  const groups: FieldGroup[] = [];
  const discriminators: string[] = [];
  const seenFieldNames = new Set<string>();
  const inheritedFieldIndex = new Map<string, number>();
  // §5.2, §5.8: a record's name type is set where it is declared, the kernel's default included,
  // and a composition takes its supertypes' one type: supertypes that disagree compose names of
  // two types, and choosing either would re-judge the other's names by a type they were never
  // declared under.
  let nameType: string | undefined;
  let nameTypeFrom: string | undefined;
  const takeNameType = (from: string, stated: string | undefined): void => {
    if (nameTypeFrom === undefined) {
      nameType = stated;
      nameTypeFrom = from;
    } else {
      requireOneNameType(deps, name, nameTypeFrom, nameType, from, stated);
    }
  };

  // Each inherited field whose source the closed chain will not reach, with that source: an applied operand's
  // fields, and under a removal every operand's (§5.8, §5.9 rule 4). A body entry naming one is judged at link
  // through the restatements, the chain holding no record that has it.
  const offTheChain = new Map<string, TypeExpr>();
  const subtracts = construction.removal !== undefined;

  for (const supertypeRef of construction.supertypes) {
    if (supertypeRef.kind === 'applicationRef') {
      // §5.8: an application at an operand denotes no entry of its own, whether its arguments are this
      // declaration's parameters or concrete. It contributes its fields and its head's own ancestors, and the type
      // the composition produces is this declaration. The application itself goes into the chain, arguments and all:
      // a parametric record keeps it in `parents`, substituted when each application closes, and a closed
      // declaration's is folded by the resolver into the edge to the entry the application denotes. A removal
      // revokes IS-A for every parent (§5.9), so nothing is kept.
      const operand = parametricOperand(deps, name, supertypeRef, parameters, 'supertype');
      for (const ancestor of operand.ancestors) {
        addIfAbsent(transitiveSupertypes, seenTransitive, ancestor);
      }
      const applied: TypeInline = {
        kind: 'inline',
        head: APPLY,
        of: {
          kind: 'apply',
          head: { name: supertypeRef.name, annotations: [] },
          arguments: operand.args,
        },
      };
      if (!subtracts) directSupertypes.push(applied);
      for (const field of operand.fields) offTheChain.set(field.name, applied);
      const bindings = new Map<string, TypeRef>();
      for (const [parameter, argument] of operand.bindings) {
        bindings.set(parameter, asParameterRef(argument, parameters));
      }
      deps.restatements?.absorbs(name, operand.head, bindings);
      absorb(
        name,
        {
          kind: 'record',
          fields: fieldMapOf(operand.fields),
          groups: operand.groups,
          extension: 'OPEN',
        },
        fields,
        groups,
        seenFieldNames,
        inheritedFieldIndex,
      );
      // An applied operand states its head's name type, which every application keeps (§5.2).
      takeNameType(supertypeRef.name, operand.nameType);
      continue;
    }
    const supertypeName = supertypeRef.name;
    refuseParameterOperand(name, supertypeName, parameters, 'supertype', '&');
    const supertypeDef = deps.namespaceDefinitions(supertypeName);
    if (supertypeDef === undefined) {
      throw new TsonSchemaValidationError(
        `'${name}': supertype '${supertypeName}' names no type this schema declares or imports`,
      );
    }
    // §4.3: "every operand of a composition or subtraction MUST, after following its reference
    // chain (§8.3), be a definition whose body is a `!record`". See `resolveRefinement` for why
    // the composed vocabulary is the terminal's while the recorded name is the author's.
    const supertypeVocabulary = vocabularyOf(deps, supertypeName) ?? supertypeDef;
    refuseUnappliedParametricRecord(name, supertypeName, supertypeVocabulary, 'supertype', '&');
    const sealedOperand = terminalExtern(supertypeName, deps.namespaceDefinitions);
    if (sealedOperand !== undefined) {
      throw sealedExtern(
        `'${name}'`,
        "'&' and '-' compose",
        supertypeName,
        terminal(supertypeName, deps.namespaceDefinitions),
        sealedOperand,
      );
    }
    if (!isRecordBody(supertypeVocabulary)) {
      throw new TsonSchemaValidationError(
        `'${name}': supertype '${supertypeName}' has no fields to contribute -- its body is a binding record, ` +
          "not a vocabulary, so there is nothing for '&' to compose with (§5.8, and §5.7's vocabulary-body " +
          'rule read across). Compose with the head it derives from',
      );
    }
    // §5.2, §5.9 rule 9: composition mints an IS-A edge, which FINAL refuses outright -- in the
    // declaring schema and in any schema that imports it, since this check runs identically
    // wherever `&` is resolved. Subtraction is exempt (`construction.removal !== undefined`):
    // §5.9 empties `supertypes` for the WHOLE result when a removal clause is present, so no
    // edge to ANY supertype survives, FINAL's one constraint, and there is nothing left to refuse.
    if (supertypeVocabulary.extension === 'FINAL' && construction.removal === undefined) {
      throw new TsonSchemaValidationError(
        `'${name}': supertype '${supertypeName}' is FINAL -- it admits no subtype, and composition ` +
          "('&') mints one, in the declaring schema and in any importing schema (§5.2). Subtraction " +
          `stays admissible ('${supertypeName} - { ... }'), since it mints no IS-A edge (§5.9)`,
      );
    }
    directSupertypes.push({ name: supertypeName, annotations: [] });
    for (const ancestor of ofParent(deps, supertypeName))
      addIfAbsent(transitiveSupertypes, seenTransitive, ancestor);
    if (subtracts) {
      for (const field of supertypeVocabulary.fields.entries.keys()) {
        offTheChain.set(field, { name: supertypeName, annotations: [] });
      }
    }
    absorb(name, supertypeVocabulary, fields, groups, seenFieldNames, inheritedFieldIndex);
    takeNameType(supertypeName, supertypeVocabulary.nameType);
  }

  if (construction.body !== undefined) {
    // Every type constructor composes the kernel's `type`, and so already has the field `chain`,
    // the IS-A chain the resolver computes (§4.1): one declaring a field of that name is refused
    // where it is declared, rather than when an instance first uses it.
    if (
      transitiveSupertypes.includes(metaName('type')) &&
      bodyNames(construction).has(CHAIN_FIELD)
    ) {
      throw new TsonSchemaValidationError(
        `'${name}' composes 'type', so it already has the field 'chain' -- the IS-A chain the ` +
          'resolver computes and no declaration writes (§4.1). Name the field something else',
      );
    }
    const inherited = new Map(fields.map((field) => [field.name, field]));
    for (const entry of construction.body.entries) {
      resolveEntry(
        deps,
        name,
        entry,
        fields,
        groups,
        discriminators,
        seenFieldNames,
        inheritedFieldIndex,
        parameters,
      );
    }
    recordRestatements(
      deps,
      name,
      bodyNames(construction),
      offTheChain,
      inherited,
      fields,
      parameters,
    );
  }
  if (construction.removal !== undefined) {
    applyRemovals(name, construction.removal, bodyNames(construction), fields, groups);
  }
  checkSupertypeChainLimit(name, transitiveSupertypes);

  // §4.1: at most one base kind may be reachable through the supertype chain -- kind is derived
  // rather than stored, so this call is validation-only (its own diagnostic is the point); see
  // `determineKind`'s own doc.
  determineKind(name, transitiveSupertypes);
  const body: RecordBody = {
    kind: 'record',
    fields: fieldMapOf(fields),
    groups,
    extension: 'OPEN',
    ...(discriminators.length > 0 ? { discriminators } : {}),
    ...(nameType !== undefined ? { nameType } : {}),
  };
  // §5.9 rule 8: subtraction breaks IS-A, and a subtracted record keeps no lineage -- its chain is
  // empty whatever its parents were, including one that contributed nothing to the removal (§5.9's
  // own "the clause is head-level").
  return {
    parameters,
    supertypes: subtracts ? [] : transitiveSupertypes,
    parents: subtracts ? [] : directSupertypes,
    body,
  };
}

/**
 * Each field the body names that restates one inherited from `offTheChain`'s sources, as inherited and as
 * restated, for the link to judge by §5.8's rule. Inside a parametric record the parameters stand as such,
 * substituted wherever it is applied.
 */
function recordRestatements(
  deps: ResolverContext,
  name: string,
  named: ReadonlySet<string>,
  offTheChain: ReadonlyMap<string, TypeExpr>,
  inherited: ReadonlyMap<string, NamedField>,
  fields: readonly NamedField[],
  parameters: readonly string[],
): void {
  if (deps.restatements === undefined) return;
  for (const field of named) {
    const source = offTheChain.get(field);
    const was = inherited.get(field);
    const now = fields.find((candidate) => candidate.name === field);
    if (source === undefined || was === undefined || now === undefined) continue;
    deps.restatements.restates(name, {
      source: asParameters(source, parameters),
      field,
      inherited: { ...unnamedField(was), type: asParameters(was.type, parameters) },
      restated: { ...unnamedField(now), type: asParameters(now.type, parameters) },
    });
  }
}

/** `field` without its name. */
function unnamedField(field: NamedField): RecordField {
  const { name: _name, ...facts } = field;
  void _name;
  return facts;
}

/**
 * `type` with each name `parameters` declares as the parameter it is, as the parametric record holds it, so
 * substituting it later finds the parameter.
 */
function asParameters(type: TypeExpr, parameters: readonly string[]): TypeExpr {
  if (parameters.length === 0) return type;
  return TypeSlots.map(
    type,
    TypeSlots.names((reference) => asParameterRef(reference, parameters)),
  );
}

function asParameterRef(reference: TypeRef, parameters: readonly string[]): TypeRef {
  return parameters.includes(reference.name) && reference.param !== true
    ? { ...reference, param: true }
    : reference;
}

/**
 * What an applied operand contributes to the declaration absorbing it: a field set, its groups and name type, and
 * the operand's head's own supertypes -- never an edge to the head, no application being IS-A its head (§5.10).
 * **Absorbing needs no closure**: the operand is a parametric record, so its field set is known while the
 * application is open; its parameters are substituted with the arguments as written, an argument that is one of the
 * absorbing declaration's own parameters landing as that declaration's name for it. Inner applications are left
 * unclosed, for the absorbing declaration's own materialisation.
 */
function parametricOperand(
  deps: ResolverContext,
  name: string,
  application: ApplicationRef,
  typeParams: readonly string[],
  position: string,
): ParametricOperand {
  const head = application.name;
  // An alias of a parametric record is the parametric record under another name (§8.3), and is applied as it is.
  const parametricHead = Ancestry.parametricHead(head, deps.namespaceDefinitions);
  const definition = deps.namespaceDefinitions(parametricHead);
  if (definition === undefined) {
    throw new TsonSchemaValidationError(
      `'${name}': ${position} '${head}' names no type this schema declares or imports`,
    );
  }
  const end = terminal(head, deps.namespaceDefinitions);
  const atEnd = deps.namespaceDefinitions(end);
  if (atEnd?.kind === 'extern') {
    throw sealedExtern(`'${name}'`, `'${head}<...>' applies`, head, end, atEnd);
  }
  if (constructs(end, atEnd) || atEnd?.kind === 'incomplete') {
    // A constructor applied is a construction (§5.3), a binding record with elements or slots, not fields.
    throw new TsonSchemaValidationError(
      `'${name}': ${position} '${head}<...>' has no fields to contribute -- it constructs a '!${head}', a ` +
        'binding record, not a vocabulary, so there is nothing to compose with (§5.8)',
    );
  }
  if (definition.kind !== 'record' || !isParametric(definition)) {
    throw new TsonSchemaValidationError(
      `'${name}': ${position} '${head}' declares no type parameters, so it cannot be applied to ` +
        `'${application.args.map((argument) => (argument.kind === 'nameRef' ? argument.name : '...')).join(', ')}' ` +
        '(§5.10)',
    );
  }
  const headParameters = parametersOf(definition).map((parameter) => parameter.name);
  if (headParameters.length !== application.args.length) {
    throw new TsonSchemaValidationError(
      `'${name}': ${position} '${head}' declares ${String(headParameters.length)} type parameter(s) and is ` +
        `applied to ${String(application.args.length)} (§5.10)`,
    );
  }
  const args = typeArguments(application);
  // §5.10's bound check, which an operand absorbed by value would otherwise never get.
  deps.applicationCloser?.checkArguments(parametricHead, definition, args);
  const bindings = new Map<string, TypeRef>();
  headParameters.forEach((parameter, index) => {
    const argument = args[index];
    if (argument !== undefined) bindings.set(parameter, argument);
  });
  const substituted = Substitution.fields(definition, bindings);
  return {
    ancestors: Ancestry.ofApplication(parametricHead, deps.namespaceDefinitions),
    fields: namedFields({ fields: substituted }),
    groups: definition.groups,
    ...(definition.nameType === undefined ? {} : { nameType: definition.nameType }),
    args,
    head: parametricHead,
    bindings,
  };
}

/**
 * What an operand hands its absorber: the ancestors it can still be indexed under, its fields, groups and name type,
 * its arguments, and the parametric record it applies with the binding of each of its parameters.
 */
interface ParametricOperand {
  readonly ancestors: readonly string[];
  readonly fields: readonly NamedField[];
  readonly groups: readonly FieldGroup[];
  readonly nameType?: string;
  readonly args: readonly TypeRef[];
  readonly head: string;
  readonly bindings: ReadonlyMap<string, TypeRef>;
}

/**
 * The arguments of an application of a parametric record, each a name or a parameter (§5.3): an application or a
 * sugar form there is refused, to be declared under a name first.
 */
function typeArguments(application: ApplicationRef): TypeRef[] {
  if (!namesOnly(application)) throw argumentNotANameIn(application);
  return [...names(application).arguments];
}

/** Every field name this declaration's own body mentions, whether it introduces or tightens it — both are what §5.9 rule 4 forbids a removal from naming. */
function bodyNames(construction: ConstructionDef): Set<string> {
  const names = new Set<string>();
  if (construction.body === undefined) return names;
  for (const entry of construction.body.entries) {
    if (entry.kind === 'fieldDef') {
      names.add(entry.name);
    } else {
      for (const member of groupMembers(entry)) names.add(member.name);
    }
  }
  return names;
}

/**
 * §5.9's removal clause, applied last. Two things are rejected: a name nowhere in the merged
 * field set (rule 2), and a name this declaration's own body mentions (rule 4) — checked first,
 * since a body-introduced field *is* in the merged set and the weaker "no such field" answer
 * would misdiagnose it. A removed member leaves its option and an emptied option leaves the
 * group; a group left with one option that no schema could write dissolves into the plain fields
 * it equals, and removing every member drops the group with them (§5.11).
 */
function applyRemovals(
  declarationName: string,
  removal: RemovalSet,
  bodyDeclared: ReadonlySet<string>,
  fields: NamedField[],
  groups: FieldGroup[],
): void {
  const removed = new Set<string>();
  for (const fieldName of removal.fieldNames) {
    if (bodyDeclared.has(fieldName)) {
      throw new TsonSchemaValidationError(
        `'${declarationName}': removal names '${fieldName}', which this declaration's own body also declares ` +
          '-- a declaration cannot both state a field and remove it (§5.9 rule 4)',
      );
    }
    if (!fields.some((f) => f.name === fieldName)) {
      throw new TsonSchemaValidationError(
        `'${declarationName}': removal names '${fieldName}', which is not a field of the composed type -- ` +
          'only an inherited field can be removed (§5.9 rule 2)',
      );
    }
    removed.add(fieldName);
  }

  const surviving: FieldGroup[] = [];
  for (const group of groups) {
    if (!group.members.flat().some((member) => removed.has(member))) {
      surviving.push(group);
      continue;
    }
    const options = group.members
      .map((option) => option.filter((member) => !removed.has(member)))
      .filter((option) => option.length > 0);
    // A member left alone in its option is present exactly when the option is chosen, so its mark goes.
    const optionalMembers = (group.optionalMembers ?? []).filter((member) =>
      options.some((option) => option.length > 1 && option.includes(member)),
    );
    const first = options[0];
    if (
      options.length > 1 ||
      (first !== undefined && keepsOneOption(first, optionalMembers, group.optional))
    ) {
      surviving.push({
        members: options,
        ...(optionalMembers.length > 0 ? { optionalMembers } : {}),
        optional: group.optional,
      });
    } else if (first !== undefined) {
      dissolveInto(fields, first, optionalMembers, group.optional);
    }
  }
  groups.length = 0;
  groups.push(...surviving);

  for (let i = fields.length - 1; i >= 0; i -= 1) {
    if (removed.has(at(fields, i, 'applyRemovals').name)) fields.splice(i, 1);
  }
}

/**
 * Whether a group reduced to one option is still one a schema could write (§5.11): not optional
 * with at least two members, every one marked — the `+` group — or optional with at least two
 * members, one unmarked. Any other one option is plain fields.
 */
function keepsOneOption(
  option: readonly string[],
  optionalMembers: readonly string[],
  optionalGroup: boolean,
): boolean {
  if (option.length < 2) return false;
  const anyUnmarked = option.some((member) => !optionalMembers.includes(member));
  return optionalGroup ? anyUnmarked : !anyUnmarked;
}

/**
 * §5.11: a group reduced to one option it may not keep becomes the plain fields it equals. In a
 * group that is not optional the option is always chosen, so its unmarked members are required and
 * its marked ones optional; in an optional group every member is optional. A sole member takes the
 * group's own `optional` as its own: an unmarked name where the group had to be chosen, `?` on the
 * name where it was optional. The field's own voidability is unchanged.
 */
function dissolveInto(
  fields: NamedField[],
  option: readonly string[],
  optionalMembers: readonly string[],
  optionalGroup: boolean,
): void {
  fields.forEach((field, index) => {
    if (!option.includes(field.name)) return;
    const omittable = optionalGroup || optionalMembers.includes(field.name);
    fields[index] = {
      ...field,
      optional: omittable,
      role: 'FREE',
    };
  });
}

function addIfAbsent(list: string[], seen: Set<string>, name: string): void {
  if (!seen.has(name)) {
    seen.add(name);
    list.push(name);
  }
}

/**
 * §4.1: a constructor's chain reaches at most one base kind -- `atom`, `product` or `sum`, judged by the
 * literal, kernel-fixed names; `top` and `type` never count. Validation only: no entry has a derived kind (item
 * 132), a consumer reading kind from the constructor.
 */
function determineKind(name: string, transitiveSupertypes: readonly string[]): void {
  const baseKinds = [metaName('atom'), metaName('product'), metaName('sum')];
  const baseKindsFound = transitiveSupertypes.filter((s) => baseKinds.includes(s));
  if (baseKindsFound.length > 1) {
    throw new TsonSchemaValidationError(
      `'${name}' reaches ${String(baseKindsFound.length)} base kinds through its supertypes ` +
        `(${baseKindsFound.join(', ')}) -- §4.1 gives a type exactly one, so nothing can be both. Compose ` +
        'from sources that agree on their base kind',
    );
  }
}

/**
 * [TSON-SCHEMA] §11.5's "supertype chain" limit: `name`'s own transitive `supertypes` (§8.1) MUST
 * NOT grow past {@link DEFAULT_MAX_SUPERTYPE_CHAIN} entries. `transitiveSupertypes` is already the
 * fully-accumulated chain by the time either caller reaches this -- each direct supertype's own
 * chain folded in by induction (`resolveComposition`'s own top note) -- so the count taken here is
 * exactly what §11.5 names, whether or not a later step (§5.9 subtraction) discards it from the
 * entry's own stored `supertypes`: the walk that built it is the resource spent, regardless of
 * what survives.
 *
 * A limit refusal, not a resolver error: the chain may be entirely well-formed, and the next
 * processor along may simply be configured to walk further.
 */
function checkSupertypeChainLimit(name: string, transitiveSupertypes: readonly string[]): void {
  if (transitiveSupertypes.length > DEFAULT_MAX_SUPERTYPE_CHAIN) {
    throw supertypeChainLimitRefusal(DEFAULT_MAX_SUPERTYPE_CHAIN, name);
  }
}

// ── Refinement (§5.7): T ^ { ... } ───────────────────────────────────────────────────────────

/**
 * The entry `name`'s alias chain ends at (§8.3), or `undefined` where the walk reaches no
 * entry at all -- an undeclared name, an argument-bearing target, or a cycle.
 *
 * §4.3 states the rule every caller here needs in one line: the source of a refinement and every
 * operand of a composition or subtraction MUST, **after following its alias chain**, be a
 * definition whose body is a `!record`. So an alias to a record is an admissible operand and an
 * alias to a binding record is not -- "an alias resolving to either is *finished*". §5.5 asks the
 * same question of an atom refinement's source.
 *
 * The walk decides only what the operand *is*. What the resolved entry records stays the name the
 * author wrote, because §8.3 states a chain as written and collapses it nowhere.
 */
function vocabularyOf(deps: ResolverContext, name: string): Top | undefined {
  return terminalDefinition(name, deps.namespaceDefinitions);
}

/** §5.8's one name type over a subtype's supertypes: `a` from `aFrom` and `b` from `bFrom`. */
function requireOneNameType(
  deps: ResolverContext,
  name: string,
  aFrom: string,
  a: string | undefined,
  bFrom: string,
  b: string | undefined,
): void {
  if (sameNameType(deps, a, b)) return;
  throw new TsonSchemaValidationError(
    `'${name}': supertypes '${aFrom}' and '${bFrom}' have different name types, ` +
      `'${a ?? DEFAULT_NAME_TYPE}' and '${b ?? DEFAULT_NAME_TYPE}' -- a record's name type is set where it is ` +
      'declared, the default included, and a subtype cannot change it; declare both over one name ' +
      'type (§5.8)',
  );
}

/**
 * Whether two records' name types are one type: the same entry at the end of each one's reference
 * chain (§8.3), not the same spelling, so `jn => json_name` is `json_name`, and a record stating
 * none has `meta.identifier`'s (§5.2). A stated one resolves in the schema's own namespace first, the
 * absent default in the structure; two that resolve to nothing are compared as written, the linker
 * refusing each on its own.
 */
function sameNameType(
  deps: ResolverContext,
  a: string | undefined,
  b: string | undefined,
): boolean {
  const ka = nameTypeIdentity(deps, a);
  const kb = nameTypeIdentity(deps, b);
  return ka !== undefined && kb !== undefined ? ka === kb : a === b;
}

/**
 * `nameType`'s terminal entry (§8.3), or `undefined` where it names none. The absent default is
 * `meta.identifier` (§5.2); it is stated here, not looked up, since every record that states no name type asks, and the kernel's own records ask while
 * its entries are still being made.
 */
function nameTypeIdentity(deps: ResolverContext, nameType: string | undefined): string | undefined {
  if (nameType === undefined) return DEFAULT_NAME_TYPE;
  if (deps.namespaceDefinitions(nameType) === undefined) return undefined;
  return terminal(nameType, deps.namespaceDefinitions);
}

// ── Shared composition/refinement machinery ─────────────────────────────────────────────────

/** One source's fields and groups copied into the record being built — shared by a closed supertype's own `RecordBody` and an open operand's substituted one. */
function absorb(
  name: string,
  source: RecordBody,
  fields: NamedField[],
  groups: FieldGroup[],
  seenFieldNames: Set<string>,
  inheritedFieldIndex: Map<string, number>,
): void {
  for (const field of namedFields(source)) {
    requireFieldNameNotSeen(name, field.name, seenFieldNames, 'SUPERTYPE');
    seenFieldNames.add(field.name);
    inheritedFieldIndex.set(field.name, fields.length);
    fields.push(field);
  }
  groups.push(...source.groups);
}

/**
 * A parametric record named without arguments is no operand (§5.8, §5.10): an operand is flattened, and a
 * parametric record has fields only once its parameters are bound.
 */
function refuseUnappliedParametricRecord(
  name: string,
  operand: string,
  definition: Top,
  position: string,
  operator: string,
): void {
  if (isParametric(definition)) {
    throw new TsonSchemaValidationError(
      `'${name}': ${position} '${operand}' is a parametric record and is applied to no arguments -- ` +
        `'${operator}' takes the fields of a record, and a parametric record has fields once its parameters ` +
        `are bound. Write '${operand}<...>' (§5.8, §5.10)`,
    );
  }
  if (definition.kind === 'incomplete') {
    throw new TsonSchemaValidationError(
      `'${name}': ${position} '${operand}' is ${IncompleteEntries.noType(operand, definition)} (§5.5)`,
    );
  }
}

/**
 * A parameter is never an operand of `&` or `^` (§5.8, §5.10): both read the operand's field set
 * to flatten, and a parameter has none until the parametric record is applied, so `<T> T & { ... }` and
 * `<T> T ^ { ... }` have no body to hold. An operand applied *to* a parameter, `result<T>`, is a
 * different thing and is admitted. Checked before the name is looked up, as §5.10's shadowing rule
 * reads it: a parameter hides a schema entry of the same name.
 */
function refuseParameterOperand(
  name: string,
  operand: string,
  parameters: readonly string[],
  position: string,
  operator: string,
): void {
  if (parameters.includes(operand)) {
    throw new TsonSchemaValidationError(
      `'${name}': ${position} '${operand}' is a parameter of this declaration, and a parameter is ` +
        `never an operand of '${operator}' -- its fields are unknown until the parametric record is applied, ` +
        'so there is nothing to flatten (§5.10)',
    );
  }
}

// ── Record bodies, fields, and field groups (§5.2, §5.11) ──────────────────────────────────

function resolveRecordBody(
  deps: ResolverContext,
  entries: readonly RecordEntry[],
  parameters: readonly string[],
): RecordBody {
  const fields: NamedField[] = [];
  const groups: FieldGroup[] = [];
  const discriminators: string[] = [];
  const seenFieldNames = new Set<string>();
  const inheritedFieldIndex = new Map<string, number>();
  for (const entry of entries) {
    resolveEntry(
      deps,
      undefined,
      entry,
      fields,
      groups,
      discriminators,
      seenFieldNames,
      inheritedFieldIndex,
      parameters,
    );
  }
  return {
    kind: 'record',
    fields: fieldMapOf(fields),
    groups,
    extension: 'OPEN',
    ...(discriminators.length > 0 ? { discriminators } : {}),
  };
}

/**
 * `declarationName` is only used to word error messages -- `undefined` for a fresh record, where
 * `inheritedFieldIndex` is always empty. A `FieldDef` whose name is a key of `inheritedFieldIndex`
 * is a *tightening* entry (§5.7): resolved against, and replacing in place, the already-inherited
 * field at that index, rather than being appended as new.
 */
function resolveEntry(
  deps: ResolverContext,
  declarationName: string | undefined,
  entry: RecordEntry,
  fields: NamedField[],
  groups: FieldGroup[],
  discriminators: string[],
  seenFieldNames: Set<string>,
  inheritedFieldIndex: Map<string, number>,
  parameters: readonly string[],
): void {
  if (entry.kind === 'fieldDef') {
    const index = inheritedFieldIndex.get(entry.name);
    if (index !== undefined) {
      fields[index] = resolveTighteningField(
        deps,
        declarationName,
        entry,
        at(fields, index, 'resolveEntry'),
        parameters,
        groups,
      );
    } else {
      requireFieldNameNotSeen(declarationName, entry.name, seenFieldNames, 'BODY_FIELD');
      const { field, selector } = resolveField(deps, entry, parameters, undefined);
      seenFieldNames.add(field.name);
      fields.push(field);
      // §5.2: `=?` lowers into `record.discriminators`, the base's own statement of which fields
      // its members are selected by, in declaration order -- the marked field itself stays FREE,
      // unmarked and unpinned (above). Only a *fresh* field can introduce a selector; a tightening
      // entry narrows an inherited field and never mints a new discriminator --
      // {@link resolveTighteningField} refuses `=?` outright, rather than silently discarding it.
      if (selector) discriminators.push(field.name);
    }
    return;
  }
  if (restatesInheritedGroup(deps, declarationName, entry, fields, groups, inheritedFieldIndex))
    return;
  for (const member of groupMembers(entry)) {
    requireFieldNameNotSeen(declarationName, member.name, seenFieldNames, 'GROUP_MEMBER');
    const field = resolveGroupMember(deps, member);
    seenFieldNames.add(field.name);
    fields.push(field);
  }
  groups.push(lowerGroup(entry));
}

/**
 * §5.7's refinement/tightening rules, applied to one composition- or refinement-body field that
 * names an already-inherited field. `isGroupMember` says whether that inherited field is a
 * field-group member (`groups` already lists it) -- §5.11's own two rules over a restated member,
 * both refused here rather than left to {@link checkFieldRefinementOrder}'s general three orders:
 * **its name mark may be dropped and never added**, since the `?` speaks for the member's option
 * ({@link restateMemberMark}); and **`~ v` stays refused**, a default being a value only omission
 * reaches and omission being the group's. A member's `=` pin is admitted (checked when written,
 * never injected, §5.11) and its type slot may still narrow or tighten voidable true → false, "as
 * at any field" -- both flow through {@link resolveField} exactly as a non-member's do. `=?` is
 * refused for every tightening entry alike, member or not: a discriminator is declared once, at
 * the base (§5.2), and a restatement narrows an inherited field rather than minting a new one.
 */
function resolveTighteningField(
  deps: ResolverContext,
  declarationName: string | undefined,
  fieldDef: FieldDef,
  inherited: NamedField,
  parameters: readonly string[],
  groups: FieldGroup[],
): NamedField {
  const prefix = declarationName === undefined ? '' : `'${declarationName}': `;
  const isMember = isGroupMember(groups, fieldDef.name);
  if (fieldDef.modifier?.kind === 'selector') {
    throw new TsonSchemaValidationError(
      `${prefix}'${fieldDef.name}' acquires the selector '=?' by refinement -- a discriminator is ` +
        'declared once, at the base, and every subtype instead restates it pinned FIXED (§5.2, ' +
        `§5.7)${isMember ? '; a member reachable by refinement may not acquire a selector (§5.11)' : ''}`,
    );
  }
  if (isMember) {
    // The default is refused first: it is the more basic fault, and the name mark a member written
    // beside it is then not also reported as loosening its option.
    if (fieldDef.modifier?.kind === 'default') {
      throw new TsonSchemaValidationError(
        `${prefix}the restated group member '${fieldDef.name}' takes a default ('~') -- a default ` +
          "is a value only omission reaches, and omission is the group's, not one member's (§5.11)",
      );
    }
    restateMemberMark(declarationName, fieldDef, groups);
  }
  const { field } = resolveField(deps, fieldDef, parameters, inherited);
  // §5.11: a member is never anything but optional as a field -- its own omission question is its
  // option's and the group's, whatever this restatement's modifier resolved `optional` to.
  const tightened: NamedField = isMember ? { ...field, optional: true } : field;
  checkFieldRefinementOrder(declarationName, fieldDef.name, inherited, tightened, isMember);
  return tightened;
}

/**
 * A restated member's name `?` (§5.11) speaks for its option, not the record: it keeps the member
 * optional once its option is chosen, and leaving it off makes the member required there — the
 * name's `?` is never inherited, at a member as at any field. It may be dropped and never added,
 * since adding one loosens the option. The `+` group, the one group of a single option that may
 * not be left out, is the exception: its members were written without a `?`, so they are restated
 * that way and keep their mark.
 */
function restateMemberMark(
  declarationName: string | undefined,
  fieldDef: FieldDef,
  groups: FieldGroup[],
): void {
  const prefix = declarationName === undefined ? '' : `'${declarationName}': `;
  const index = groups.findIndex((group) =>
    group.members.some((option) => option.includes(fieldDef.name)),
  );
  const group = groups[index];
  if (group === undefined) return;
  const atLeastOne = group.members.length === 1 && !group.optional;
  const marked = (group.optionalMembers ?? []).includes(fieldDef.name);
  if (fieldDef.optional && (atLeastOne || !marked)) {
    throw new TsonSchemaValidationError(
      `${prefix}'${fieldDef.name}' is a member of a field group ${
        atLeastOne
          ? "written with '+', whose members take no '?' -- restate it as written there"
          : "without a '?' on its name, and adding one loosens its option"
      } (§5.11)`,
    );
  }
  if (!fieldDef.optional && marked && !atLeastOne) {
    const optionalMembers = (group.optionalMembers ?? []).filter(
      (member) => member !== fieldDef.name,
    );
    groups[index] = {
      members: group.members,
      ...(optionalMembers.length > 0 ? { optionalMembers } : {}),
      optional: group.optional,
    };
  }
}

/**
 * §5.7's refinement as three independent orders, none of which may move backwards: **omission**
 * (absent → required → injected), **voidable** (true → false), **role** (`FREE` → `DEFAULT` →
 * `FIXED`). Checking the three separately is what lets `a?: T?` tighten to `a: T = v` in one
 * restatement (voidable true→false and role FREE→FIXED both moving forward at once) while still
 * refusing either one alone moving back. `isGroupMember` routes the omission rank through
 * {@link fieldOmission}'s own group carve-out (§5.11): a member's omission is always `'ABSENT'`
 * on both sides, so the axis never fires for one, whatever its role restates to.
 *
 * **Identity.** A restatement may change a **default** value freely but MUST NOT change a
 * **pin** -- the one thing "restated as itself" polices beyond the three orders. Two pins compare
 * as the *values* they denote (§5.5, §5.7: `= 255` and `= 0xFF` collide), not as spelled text.
 */
function checkFieldRefinementOrder(
  declarationName: string | undefined,
  fieldName: string,
  inherited: NamedField,
  tightened: NamedField,
  isGroupMember: boolean,
): void {
  const prefix = declarationName === undefined ? '' : `'${declarationName}': `;
  const OMISSION_RANK: Record<FieldOmission, number> = { ABSENT: 0, MISSING: 1, INJECTED: 2 };
  const omissionRank = (f: NamedField): number => OMISSION_RANK[fieldOmission(f, isGroupMember)];
  if (omissionRank(tightened) < omissionRank(inherited)) {
    throw new TsonSchemaValidationError(
      `${prefix}tightening '${fieldName}' moves its omission question backwards -- a refinement ` +
        'may only move forward through absent, required, injected, never back (§5.7)',
    );
  }
  const voidableRank = (f: NamedField): number => (f.voidable ? 0 : 1);
  if (voidableRank(tightened) < voidableRank(inherited)) {
    throw new TsonSchemaValidationError(
      `${prefix}tightening '${fieldName}' makes a non-voidable field voidable -- voidable may only ` +
        'move true → false under refinement, never back (§5.7)',
    );
  }
  const roleRank = (f: NamedField): number =>
    f.role === 'FREE' ? 0 : f.role === 'DEFAULT' ? 1 : 2;
  if (roleRank(tightened) < roleRank(inherited)) {
    throw new TsonSchemaValidationError(
      `${prefix}tightening '${fieldName}' moves its role backwards -- a refinement may only move ` +
        'forward through FREE, DEFAULT, FIXED, never back (§5.7)',
    );
  }
  if (inherited.role === 'FIXED' && tightened.role === 'FIXED') {
    const before = inherited.value;
    const after = tightened.value;
    if (before !== undefined && after !== undefined && !pinTokensEqual(before, after)) {
      throw new TsonSchemaValidationError(
        `${prefix}restates the pinned field '${fieldName}' with a different value -- a restatement ` +
          'may change a default but MUST NOT change a pin (§5.7)',
      );
    }
  }
}

/**
 * Two `TsonDecimal`s (`unscaled * 10^exponent`) denoting the same magnitude regardless of scale
 * (§5.7: `= 1` and `= 1.0` collide) -- normalises the one with the coarser exponent up to the
 * other's before comparing the unscaled magnitudes.
 */
function decimalEquals(a: TsonDecimal, b: TsonDecimal): boolean {
  if (a.exponent === b.exponent) return a.unscaled === b.unscaled;
  const [lo, hi] = a.exponent < b.exponent ? [a, b] : [b, a];
  return hi.unscaled * 10n ** BigInt(hi.exponent - lo.exponent) === lo.unscaled;
}

/** `text` as the exact numeric value it denotes, when it matches the `number` production at all (§4.3) -- `undefined` for every other token, numeric or not (a special value like `nan`, or an ordinary identifier/boolean spelling). */
function numericTokenValue(text: string): TsonDecimal | undefined {
  const form = tryParseNumber(text);
  if (form === undefined) return undefined;
  if (form.kind === 'integer' || form.kind === 'based-integer') {
    return { unscaled: toExactInteger(form), exponent: 0 };
  }
  if (form.kind === 'float') {
    return toExactDecimal(form);
  }
  return undefined;
}

/**
 * Whether two FIXED-field tokens denote the same value (§5.7: "`= 255` and `= 0xFF` collide, `= 1`
 * and `= 1.0` collide, text pins compare NFC-normalised") -- the two cases this resolver can
 * decide without a type-directed read of the field's own declared type: two unquoted numeric
 * literals compare by exact magnitude regardless of base, digit grouping or scale, and two quoted
 * text tokens (already escape-decoded, §7.2.2–§7.2.3) compare NFC-normalised ([TSON-DATA] §7.1).
 * Everything else -- an identifier spelling, a boolean, an enum member, or either token failing to
 * parse as a number -- falls back to exact text, which is the right answer for every atom family
 * whose value identity is its own spelling.
 */
export function pinTokensEqual(before: Token, after: Token): boolean {
  if (before.form === after.form && before.text === after.text) return true;
  if (before.form === 'UNQUOTED' && after.form === 'UNQUOTED') {
    const a = numericTokenValue(before.text);
    const b = numericTokenValue(after.text);
    return a !== undefined && b !== undefined && decimalEquals(a, b);
  }
  if (before.form !== 'UNQUOTED' && after.form !== 'UNQUOTED') {
    return toNfc(before.text) === toNfc(after.text);
  }
  return false;
}

type FieldOrigin = 'SUPERTYPE' | 'BODY_FIELD' | 'GROUP_MEMBER';

const FIELD_ORIGIN_EXPLANATION: Record<FieldOrigin, string> = {
  SUPERTYPE:
    'two supertypes both contribute it -- supertypes MUST contribute disjoint field sets, including a diamond ' +
    'where both paths reach the same originating type (§5.8)',
  BODY_FIELD:
    "this body declares it twice (§5.11: a field name is unique across a record's plain fields and all its groups' members)",
  GROUP_MEMBER:
    "a group member repeats it -- member labels share the enclosing record's field namespace (§5.11)",
};

function requireFieldNameNotSeen(
  declarationName: string | undefined,
  fieldName: string,
  seenFieldNames: ReadonlySet<string>,
  origin: FieldOrigin,
): void {
  if (seenFieldNames.has(fieldName)) {
    throw new TsonSchemaValidationError(
      `${declarationName === undefined ? '' : `'${declarationName}': `}field '${fieldName}' is declared more ` +
        `than once -- ${FIELD_ORIGIN_EXPLANATION[origin]}`,
    );
  }
}

/**
 * A resolved field, plus whether its own modifier was the selector `=?` (§5.2) -- only a fresh
 * field's own answer is ever consulted (`resolveEntry`, collecting it into `discriminators`); a
 * tightening entry's is never even reached, {@link resolveTighteningField} refusing `=?` outright
 * before it calls this function.
 */
interface ResolvedField {
  readonly field: NamedField;
  readonly selector: boolean;
}

/**
 * §5.8's restated-field annotation merge, which a plain new field also passes through vacuously
 * (`inherited` `undefined` -- own annotations only): the restatement's own annotations, in source
 * order, followed by the inherited field's own (already-merged, so a chain accumulates leader
 * first at every link), in source order. Nothing is dropped and no name is a key -- an inherited
 * field restated twice down a chain carries both restatements' annotations plus the original's,
 * each restatement ahead of what it restates.
 */
function resolveField(
  deps: ResolverContext,
  field: FieldDef,
  parameters: readonly string[],
  inherited: NamedField | undefined,
): ResolvedField {
  const base = resolveFieldEntry(deps, field, parameters, inherited);
  const own = annotationsOf(deps, field.name, field.annotations);
  const annotations = inherited === undefined ? own : [...own, ...inherited.annotations];
  return { field: { ...base.field, annotations }, selector: base.selector };
}

function resolveFieldEntry(
  deps: ResolverContext,
  field: FieldDef,
  parameters: readonly string[],
  inherited: NamedField | undefined,
): ResolvedField {
  let type: TypeExpr;
  if (field.type !== undefined) {
    type = resolveFieldType(deps, field.name, field.type.typeRef);
  } else if (inherited !== undefined) {
    type = inherited.type;
  } else {
    throw new TsonSchemaValidationError(
      `field '${field.name}' states only a modifier and no type-ref, but names no inherited field to take a ` +
        'type from -- a modifier-only entry is always a tightening, so it is only meaningful in a refinement ' +
        'or composition body, against a field the source declares (§5.7)',
    );
  }
  const voidable = field.type !== undefined ? field.type.voidable : (inherited?.voidable ?? false);

  const resolved = resolveFieldMarks(field.name, field.optional, voidable, field.modifier);
  return {
    field: {
      name: field.name,
      type,
      optional: resolved.optional,
      voidable: resolved.voidable,
      role: resolved.role,
      ...(resolved.value === undefined
        ? {}
        : { value: { text: resolved.value.text, form: metaFormOfLexer(resolved.value.form) } }),
      annotations: [],
    },
    selector: resolved.selector,
  };
}

/**
 * §5.11's group restatement, shared by a refinement body and a composition body: a restated group
 * MUST have the same options, their members in the same order (member type-refs restated
 * verbatim), may drop a member's `?` or the group's, and never add one; changing membership is a
 * resolver error. Returns `false` (having applied nothing) when this group names nothing inherited
 * and so is genuinely new -- which a composition body appends and a refinement body rejects, each
 * at its own call site.
 */
function restatesInheritedGroup(
  deps: ResolverContext,
  declarationName: string | undefined,
  groupDef: GroupDef,
  fields: NamedField[],
  groups: FieldGroup[],
  inheritedFieldIndex: ReadonlyMap<string, number>,
): boolean {
  const restatement = lowerGroup(groupDef);
  const restated = restatement.members.flat();
  const inheritedMembers = restated.filter((m) => inheritedFieldIndex.has(m));
  if (inheritedMembers.length === 0) return false;
  const prefix = `${declarationName === undefined ? '' : `'${declarationName}': `}the restated group ${spellGroup(restatement)} `;
  if (inheritedMembers.length !== restated.length) {
    throw new TsonSchemaValidationError(
      `${prefix}adds a member the source does not declare -- changing membership is a resolver error (§5.11)`,
    );
  }

  const index = groups.findIndex((g) =>
    g.members.some((option) => option.includes(at(restated, 0, 'restatesInheritedGroup'))),
  );
  if (index < 0) {
    throw new TsonSchemaValidationError(
      `${prefix}names inherited fields that are not a group -- a group can only restate one the source declares as a group (§5.11)`,
    );
  }
  const inherited = at(groups, index, 'restatesInheritedGroup');
  const sameOptions =
    inherited.members.length === restatement.members.length &&
    inherited.members.every(
      (option, i) =>
        option.length === restatement.members[i]?.length &&
        option.every((member, j) => member === restatement.members[i]?.[j]),
    );
  if (!sameOptions) {
    throw new TsonSchemaValidationError(
      `${prefix}does not match the inherited group ${spellGroup(inherited)} -- a restatement MUST ` +
        'have the same options, their members in the same order, and changing membership is a ' +
        'resolver error (§5.11)',
    );
  }
  const inheritedOptional = inherited.optionalMembers ?? [];
  const added = (restatement.optionalMembers ?? []).filter(
    (member) => !inheritedOptional.includes(member),
  );
  if (added.length > 0) {
    throw new TsonSchemaValidationError(
      `${prefix}marks ${added.join(', ')} '?' where the source does not -- a restatement may drop ` +
        "a member's '?' and never add one, which loosens its option (§5.11)",
    );
  }
  for (const member of groupMembers(groupDef)) {
    const restatedType = resolveFieldType(deps, member.name, member.typeRef);
    const inheritedIndex = requiredGet(inheritedFieldIndex, member.name, 'restatesInheritedGroup');
    const inheritedField = at(fields, inheritedIndex, 'restatesInheritedGroup');
    if (!sameTypeExpr(restatedType, inheritedField.type)) {
      throw new TsonSchemaValidationError(
        `${prefix}gives member '${member.name}' the type '${typeExprText(restatedType)}' where the source declares ` +
          `'${typeExprText(inheritedField.type)}' -- member type-refs are restated verbatim (§5.11); narrowing a ` +
          "member's type is done by naming it as an ordinary field",
      );
    }
    // §5.8's merge, applied to a group member the same way `resolveField` applies it to an
    // ordinary restated field: the restatement's own annotations in source order, then the
    // inherited field's own, in source order. Nothing is dropped and the restatement leads.
    const own = annotationsOf(deps, member.name, member.annotations);
    fields[inheritedIndex] = {
      ...inheritedField,
      annotations: [...own, ...inheritedField.annotations],
    };
  }

  if (!inherited.optional && restatement.optional) {
    throw new TsonSchemaValidationError(
      `${prefix}makes the group optional where the source's is not -- a restatement may drop a ` +
        "group's '?' and never add one (§5.11)",
    );
  }
  groups[index] = restatement;
  return true;
}

/** A fresh group's own member (§5.11, §12.1) -- `*annotation field-name ws ":" ws type-ref`. Bound through the same {@link annotationsOf} every field's own annotations bind through (§6); there is no inherited field to merge onto here, this being a brand-new group rather than a restatement (that merge is {@link restatesInheritedGroup}'s own). */
function resolveGroupMember(deps: ResolverContext, member: GroupMember): NamedField {
  return {
    name: member.name,
    type: resolveFieldType(deps, member.name, member.typeRef),
    optional: true,
    voidable: member.voidable,
    role: 'FREE',
    annotations: annotationsOf(deps, member.name, member.annotations),
  };
}

// ── Annotations (§6) ─────────────────────────────────────────────────────────────────────────

/**
 * A declaration's own annotations -- the ones written *after* `=>`. A value is bound through the
 * governing meta the same way §6 describes reading one: the annotation's name resolves one hop
 * against the structure namespace, and its value is read by that type's own compiled reader. A
 * name that does not resolve there is the author's error ({@link unresolvedAnnotation}) -- unless
 * this resolver was built with no {@link AnnotationValueReader} at all (the meta-kernel
 * bootstrap), in which case the check is skipped entirely and every name is kept with its value
 * dropped.
 */
function annotationsOf(
  deps: ResolverContext,
  name: string,
  written: readonly WrittenAnnotation[],
): Annotations {
  if (written.length === 0) return [];
  const annotations: Annotation[] = [];
  for (const annotation of written) {
    if (
      deps.annotationValueReader !== undefined &&
      deps.metaDefinitions(annotation.name) === undefined
    ) {
      throw unresolvedAnnotation(deps, name, annotation.name);
    }
    // A bare `@T` is shorthand for `@T:_` (§6): it is read against `T` like a written value, so a
    // type that does not admit the void sentinel refuses the mark as it would refuse `_`. The bare
    // form keeps no value, whatever the read returned.
    const boundValue =
      annotation.value === undefined
        ? (bindAnnotationValue(deps, name, annotation.name, VOID_SENTINEL), undefined)
        : bindAnnotationValue(deps, name, annotation.name, annotation.value);
    annotations.push({
      name: annotation.name,
      ...(boundValue === undefined ? {} : { value: boundValue }),
    });
  }
  return annotations;
}

/** The `_` a bare annotation stands for (§6), read against the annotation's type like a written one. */
const VOID_SENTINEL: DataValue = { annotations: [], coreValue: { kind: 'void' } };

/** §3.3.3's one hop missed: `annotationName` is not an entry of the governing meta-schema's own namespace. */
function unresolvedAnnotation(
  deps: ResolverContext,
  declaration: string,
  annotationName: string,
): TsonSchemaValidationError {
  const local = deps.namespaceDefinitions(annotationName) !== undefined;
  return new TsonSchemaValidationError(
    `'${declaration}': '@${annotationName}' does not name a type in the governing meta-schema's namespace, ` +
      'which is the whole annotation namespace of a schema document (one hop through !!meta, §3.3.3)' +
      (local
        ? ' -- the name is declared by this schema or brought in by !!import, which makes it usable by this ' +
          "schema's data documents but not within the schema document itself; declare the annotation type in " +
          'a meta-schema and point !!meta at that'
        : ''),
  );
}

/** An annotation's value through the type its name refers to, or `undefined` when that type is out of reach. */
function bindAnnotationValue(
  deps: ResolverContext,
  declaration: string,
  annotationName: string,
  value: DataValue,
): unknown {
  if (deps.metaDefinitions(annotationName) === undefined) return undefined;
  try {
    return deps.annotationValueReader?.(annotationName, value);
  } catch (e) {
    // A refusal under §8.2's name-hygiene policy says this processor declined the value, not that
    // the schema is wrong: it reaches the caller as the fifth outcome, unwrapped.
    if (e instanceof TsonNameHygieneRefusedError && e.pointer === undefined) {
      throw new TsonNameHygieneRefusedError(e.message, {
        mechanism: e.mechanism,
        names: e.names,
        uts39Version: e.uts39Version,
        pointer: `/${declaration}`,
        cause: e,
      });
    }
    if (e instanceof TsonRefusedError) throw e;
    if (e instanceof TsonReadError) {
      throw new TsonSchemaValidationError(
        `'${declaration}': the value of annotation '@${annotationName}' is not valid data for the type ` +
          `'${annotationName}' names -- ${e.message}`,
        { cause: e },
      );
    }
    if (e instanceof TsonMissingBindingError) {
      throw new TsonMissingBindingError(`'${declaration}': ${e.message}`, { cause: e });
    }
    if (e instanceof TsonBindMismatchError) {
      throw new TsonBindMismatchError(`'${declaration}': ${e.message}`, { cause: e });
    }
    if (e instanceof TsonNotImplementedError) {
      throw new TsonNotImplementedError(
        `'${declaration}': failed to bind the value of annotation '@${annotationName}' via the compiled ` +
          `meta-schema reader: ${errorMessage(e)}`,
        { cause: e },
      );
    }
    throw e;
  }
}
