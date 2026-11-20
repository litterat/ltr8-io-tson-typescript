/**
 * Expands the schema sugar forms into the constructions they denote, between parsing and resolution:
 * `parse -> desugar -> resolve -> link`.
 *
 * **Purely syntactic, and per declaration.** The sugar set is closed and grammar-supplied, so the head each
 * form desugars to and the vocabulary field each argument fills are a fixed table (§5.3, §5.4, §5.2):
 *
 * ```text
 * [T]              !meta.array { element_type: T }
 * [T; N..M]        !meta.array { element_type: T  min_items: N  max_items: M }
 * [T?; ...]        the corresponding form with voidable: true bound directly
 * [T, U]           !meta.tuple { elements: [{ element_type: T } { element_type: U }] }
 * (A | B)          !meta.choice { variants: [A B] }
 * {K => V}         !meta.map   { key_type: K  value_type: V }
 * {K => V; N..M}   the same, with min_items/max_items
 * { a: T  b?: U }  !meta.record { fields: { a => { type: T }  b => { type: U  optional: true } } }
 * kind!            !meta.dependent { on: kind }, at a field's type alone
 * ```
 *
 * This phase therefore consults no other schema: the kernel's container constructors are parameterless (§4.2),
 * the table is the whole rule, and the kernel's own bootstrap needs no special case.
 *
 * **No declaration is added.** A sugar form is the construction it denotes, written where it stands: at a
 * declaration's own body it *is* the construction (an {@link Instance}); at a field's or group member's type it
 * is an {@link InlineConstruction} holding that binding record; nested inside a binding record it is the `{ of:
 * !C { ... } }` wrapper (`meta.type_inline`), written untagged, a type slot's choice being disjoint by class.
 * Nothing is lifted to an entry or named by its content (§4.2, §5.3).
 *
 * **An application passes through.** `name<args>` resolves its head in the schema's namespace and is an
 * application of a parametric record or, over a constructor or an incomplete entry, construction sugar (§5.3,
 * §5.5); resolution decides which (`constructionRewrite.ts`). At a slot inside a binding record it is written
 * as the `meta.apply` construction in place, a reference being a name. What is checked here is what an AST
 * alone decides: an argument is a name or a parameter (§5.10), so a sugar form as one is refused, and a head
 * this document declares with no parameters and a body no constructor has takes no arguments.
 *
 * **Structural sharing.** Every function returns its input unchanged when nothing beneath it changed. Source
 * positions live in an identity-keyed side table, so a declaration that is rebuilt has its position carried
 * across ({@link DesugarOptions.positions}).
 *
 * **A parametric record's body is a record body** (§5.10): braces or a composition. A parameter list before a
 * sugar form or a bare reference is refused here, naming what to write instead.
 *
 * **An invalid sugar form is reported per declaration, not thrown**, when a {@link DesugarFailureReporter} is
 * supplied, so an author sees every independent problem in one pass.
 */
import { at, atValue } from './parameterTypes.js';
import { TsonNotImplementedError, TsonSchemaValidationError } from '../core/errors.js';
import type { Position } from '../core/position.js';
import type { Declaration, SchemaDocument, SchemaMap } from '../ast/schema/document.js';
import type {
  FieldDef,
  FieldModifier,
  GroupDef,
  GroupMember,
  Instance,
  RecordEntry,
  SizeSpec,
} from '../ast/schema/fields.js';
import type {
  ConstructionDef,
  RecordDef,
  StructuralDef,
  StructuralTypeDef,
  TypeDef,
  TypeExprDef,
} from '../ast/schema/typedef.js';
import type {
  ApplicationRef,
  ElementType,
  FieldTypeExpr,
  InlineConstruction,
  TypeExpr,
  TypeRef,
} from '../ast/schema/typeref.js';
import type { Annotation, CoreValue, DataValue, MapEntry, RecordField } from '../ast/value.js';
import { metaName } from '../schema/meta/kernel.js';
import { lowerGroup, groupMembers } from './groupLowering.js';
import { resolveFieldMarks, type ResolvedFieldMarks } from './fieldModifiers.js';
import {
  APPLY,
  ARGUMENTS,
  DISCRIMINATORS,
  EXTENSION,
  FIELDS,
  GROUPS,
  HEAD,
  OF,
  OPTIONAL,
  RECORD,
  ROLE,
  TYPE,
  VALUE,
  VOIDABLE,
  groupValue,
  nameField,
  scoped,
  tokenValue,
} from './wireForm.js';

// ── Public surface ───────────────────────────────────────────────────────────────────────────

/**
 * Where {@link desugar} sends a declaration whose sugar form is invalid, so the rest of the document still
 * expands and goes on to resolve ([TSON-DATA] §8.1). `declaration` is the failing declaration exactly as
 * parsed; `error` is a {@link TsonSchemaValidationError} (the author's mistake) or a
 * {@link TsonNotImplementedError} (a library gap).
 */
export interface DesugarFailureReporter {
  reportFailedDeclaration(
    declaration: Declaration,
    error: TsonSchemaValidationError | TsonNotImplementedError,
  ): void;
}

/** Options for {@link desugar}. */
export interface DesugarOptions {
  /** Where an invalid sugar form is reported. Omitted means fail-fast: the first invalid form throws. */
  readonly reporter?: DesugarFailureReporter;
  /**
   * The identity-keyed carryover for a rewritten declaration's source position. When a declaration is
   * rebuilt, its entry (if any) is re-registered under the node that replaces it, in place.
   */
  readonly positions?: WeakMap<Declaration, Position>;
}

/**
 * What a field of a record written in place keeps that its `meta.record_field` value cannot carry: the
 * annotations written on it, which resolve in the schema's namespace where a construction's payload resolves
 * its own against its constructor's (§6).
 */
export interface WrittenField {
  readonly annotations: readonly Annotation[];
}

/**
 * The declaration bodies this phase wrote as a construction, by identity: an application in one is read as the
 * author's sugar (`constructionRewrite.ts`).
 */
export const DESUGARED = new WeakSet<DataValue>();

/** Each field value of a record written in place, to what it keeps beside it ({@link WrittenField}). */
export const WRITTEN_FIELDS = new WeakMap<DataValue, WrittenField>();

/**
 * The document with every sugar form rewritten in place into the construction it denotes, or the same instance
 * when there was nothing to rewrite. The declarations out are the declarations in.
 */
export function desugar(document: SchemaDocument, options: DesugarOptions = {}): SchemaDocument {
  const pass: DesugarPass = {
    local: document.body.declarations,
    reporter: options.reporter,
    positions: options.positions,
    currentParameters: [],
    currentName: '',
  };
  const body = schemaMap(document.body, pass);
  return body === document.body ? document : { ...document, body };
}

/** A declaration's declared type parameters, or none -- also how a placeholder learns its own arity. */
export function typeParamsOf(typeDef: TypeDef): readonly string[] {
  switch (typeDef.kind) {
    case 'instance':
    case 'structuralTypeDef':
    case 'typeExprDef':
      return typeDef.typeParams;
    default:
      return [];
  }
}

// ── The walk ─────────────────────────────────────────────────────────────────────────────────

interface DesugarPass {
  readonly local: ReadonlyMap<string, Declaration>;
  readonly reporter: DesugarFailureReporter | undefined;
  readonly positions: WeakMap<Declaration, Position> | undefined;
  currentParameters: readonly string[];
  currentName: string;
}

function schemaMap(map: SchemaMap, pass: DesugarPass): SchemaMap {
  let rewritten: Map<string, Declaration> | undefined;
  for (const [name, original] of map.declarations) {
    const declaration = desugarOrReport(original, pass);
    if (declaration !== original) {
      const position = pass.positions?.get(original);
      if (position !== undefined) pass.positions?.set(declaration, position);
      rewritten ??= new Map(map.declarations);
    }
    rewritten?.set(name, declaration);
  }
  return rewritten === undefined ? map : { annotations: map.annotations, declarations: rewritten };
}

/**
 * What a declaration whose sugar form was reported is replaced with: a fresh, zero-field record keeping the
 * declaration's own type parameters, so a downstream application is not told to drop its arguments.
 */
function absorbed(declaration: Declaration): TypeDef {
  return {
    kind: 'structuralTypeDef',
    typeParams: typeParamsOf(declaration.typeDef),
    body: { kind: 'recordDef', entries: [] },
  };
}

function desugarOrReport(declaration: Declaration, pass: DesugarPass): Declaration {
  try {
    return desugarDeclaration(declaration, pass);
  } catch (e) {
    if (
      pass.reporter === undefined ||
      !(e instanceof TsonSchemaValidationError || e instanceof TsonNotImplementedError)
    ) {
      throw e;
    }
    pass.reporter.reportFailedDeclaration(declaration, e);
    return { ...declaration, typeDef: absorbed(declaration) };
  }
}

function desugarDeclaration(declaration: Declaration, pass: DesugarPass): Declaration {
  pass.currentParameters = typeParamsOf(declaration.typeDef);
  pass.currentName = declaration.name;
  try {
    const typeDef = typeDefPass(declaration.typeDef, pass);
    return typeDef === declaration.typeDef ? declaration : { ...declaration, typeDef };
  } finally {
    pass.currentParameters = [];
    pass.currentName = '';
  }
}

function typeDefPass(typeDef: TypeDef, pass: DesugarPass): TypeDef {
  switch (typeDef.kind) {
    case 'structuralTypeDef': {
      const body = structuralDef(typeDef.body, pass);
      return body === typeDef.body ? typeDef : ({ ...typeDef, body } satisfies StructuralTypeDef);
    }
    case 'typeExprDef': {
      if (typeDef.typeParams.length > 0) throw refuseParametricBody(typeDef.ref, pass);
      // A declaration's own body is the construction (§5.3): the form becomes the instance directly.
      const binding = declarationBinding(typeDef.ref, pass);
      if (binding !== undefined) {
        const value = construction(binding);
        DESUGARED.add(value);
        return { kind: 'instance', typeParams: [], value } satisfies Instance;
      }
      const ref = argumentsOnly(typeDef.ref, pass);
      return ref === typeDef.ref ? typeDef : ({ ...typeDef, ref } satisfies TypeExprDef);
    }
    default:
      return typeDef;
  }
}

/**
 * A parameter list before a body that is no record (§5.10: a parametric record's body is a record body --
 * braces or a composition), refused with what to write instead.
 */
function refuseParametricBody(body: TypeExpr, pass: DesugarPass): TsonSchemaValidationError {
  const prefix =
    `'${pass.currentName}': a parametric record's body is a record body -- braces or a composition ` +
    `(§5.10) -- and '${spell(body)}' is `;
  let rest: string;
  switch (body.kind) {
    case 'arrayExpr':
      rest =
        "an array. Write the application where it is used ('meta.array<T>', '[T]'), or leave its " +
        "construction open ('nonempty => !meta.array ^ { min_items: 1 }') and complete it";
      break;
    case 'mapExpr':
      rest =
        "a map. Write the application where it is used ('meta.map<K V>', '{K => V}'), or leave its " +
        "construction open ('bounded_map => !meta.map ^ { max_items: 10 }') and complete it";
      break;
    case 'choiceExpr':
      rest =
        'a choice. Declare a discriminated record family instead (an abstract base with a selector, a ' +
        'parametric record composing it, and members pinning it), or write the alternative as a field ' +
        "group inside a record, '( body: T | problem: problem )'";
      break;
    case 'tupleExpr':
      rest =
        "a tuple. Name the positions as the fields of a parametric record, '<A, B> { first: A  second: B }', " +
        'or declare the tuple for each type it holds';
      break;
    default:
      rest =
        "a reference, so the declaration would be a parametric alias, which a parametric record's body " +
        "never is. Restate the body as a record ('<B> { first: uuid  second: B }'), or write the " +
        "application at each use ('pair<uuid, int32>')";
  }
  return new TsonSchemaValidationError(prefix + rest);
}

function structuralDef(def: StructuralDef, pass: DesugarPass): StructuralDef {
  if (def.kind === 'recordDef') return recordDef(def, pass);
  // §5.8 composes with named supertypes; only their arguments are expandable.
  const supertypes = mapShared(
    def.supertypes,
    (operand) => argumentsOnly(operand, pass) as TypeRef,
  ) as ConstructionDef['supertypes'];
  const body = def.body === undefined ? undefined : recordDef(def.body, pass);
  if (supertypes === def.supertypes && body === def.body) return def;
  return { ...def, supertypes, ...(body !== undefined ? { body } : {}) };
}

function recordDef(record: RecordDef, pass: DesugarPass): RecordDef {
  const entries = mapShared(record.entries, (entry) => recordEntry(entry, pass));
  return entries === record.entries ? record : { kind: 'recordDef', entries };
}

function recordEntry(entry: RecordEntry, pass: DesugarPass): RecordEntry {
  if (entry.kind === 'fieldDef') {
    if (entry.type === undefined) return entry; // a modifier-only entry (a restatement, §5.8)
    const ref = fieldType(entry.type.typeRef, pass);
    if (ref === entry.type.typeRef) return entry;
    return { ...entry, type: { typeRef: ref, voidable: entry.type.voidable } } satisfies FieldDef;
  }
  const options = mapShared(
    entry.options,
    (option) =>
      mapShared(option, (member) => groupMember(member, pass)) as GroupDef['options'][number],
  );
  return options === entry.options ? entry : ({ ...entry, options } satisfies GroupDef);
}

function groupMember(member: GroupMember, pass: DesugarPass): GroupMember {
  const ref = fieldType(member.typeRef, pass);
  return ref === member.typeRef ? member : { ...member, typeRef: ref };
}

/** A field's or group member's type: `kind!` is its construction in place, any other as {@link typeRef}. */
function fieldType(type: FieldTypeExpr, pass: DesugarPass): TypeExpr {
  if (type.kind === 'dependentType') {
    return inline({ head: DEPENDENT, fields: [nameField('on', type.on)] });
  }
  return typeRef(type, pass);
}

/**
 * A type at a field's or group member's slot, where a sugar form is written in place: children first, so a
 * nested form is already its construction by the time the enclosing one is built, and lands in the enclosing
 * binding as a `{ of: ... }` wrapper (`meta.type_inline`).
 */
function typeRef(ref: TypeExpr, pass: DesugarPass): TypeExpr {
  switch (ref.kind) {
    case 'nameRef':
    case 'inlineConstruction':
      return ref;
    case 'arrayExpr':
    case 'mapExpr':
    case 'tupleExpr':
    case 'choiceExpr': {
      const binding = sugarBinding(ref, pass);
      refuseParameterBound(binding, pass);
      return inline(binding);
    }
    case 'recordExpr':
      return inline(recordBinding(recordDef(ref.body, pass), pass));
    case 'applicationRef':
      return applicationArguments(ref, pass);
  }
}

function inline(binding: Binding): InlineConstruction {
  return { kind: 'inlineConstruction', value: construction(binding) };
}

/** Expands only within a reference's arguments, leaving its own head in place. */
function argumentsOnly(ref: TypeExpr, pass: DesugarPass): TypeExpr {
  return ref.kind === 'applicationRef' ? applicationArguments(ref, pass) : ref;
}

/**
 * `generic` with its arguments expanded, the same node where none changes. An argument is a name or a parameter
 * (§5.10), so a sugar form as one is refused, naming what to declare.
 */
function applicationArguments(generic: ApplicationRef, pass: DesugarPass): ApplicationRef {
  checkApplication(generic.name, pass);
  for (const argument of generic.args) {
    if (argument.kind === 'recordExpr') throw constructionAsArgument(generic, argument, pass);
  }
  const args = mapShared(generic.args, (argument) => typeRef(argument, pass));
  args.forEach((argument, index) => {
    if (argument.kind === 'inlineConstruction') {
      throw constructionAsArgument(generic, generic.args[index] ?? argument, pass);
    }
  });
  return args === generic.args
    ? generic
    : { kind: 'applicationRef', name: generic.name, args: args as ApplicationRef['args'] };
}

/** `written`, a sugar form, standing as an argument of `generic`: refused, to be declared first. */
function constructionAsArgument(
  generic: ApplicationRef,
  written: TypeExpr,
  pass: DesugarPass,
): TsonSchemaValidationError {
  return new TsonSchemaValidationError(
    `'${pass.currentName}': '${spell(written)}' is a construction passed as an argument of ` +
      `'${generic.name}<...>', and an argument is a name or a parameter (§5.10): declare it under a name ` +
      `('my_type => ${spell(written)}') and pass that name`,
  );
}

/**
 * The one thing an AST alone decides about an application's head: a head this document declares with no
 * parameters, and with a body no constructor or incomplete entry has, takes no arguments. A fresh record IS-A
 * nothing; a composition or an alias may be a constructor and an atom refinement an incomplete entry, which only
 * resolution can tell, so each passes through. A head this document does not declare is the linker's.
 */
function checkApplication(head: string, pass: DesugarPass): void {
  const declaration = pass.local.get(head);
  if (declaration === undefined) return;
  const typeDef = declaration.typeDef;
  const mayConstruct =
    (typeDef.kind === 'structuralTypeDef' && typeDef.body.kind !== 'recordDef') ||
    typeDef.kind === 'typeExprDef' ||
    typeDef.kind === 'atomRefinement';
  if (typeParamsOf(typeDef).length === 0 && !mayConstruct) {
    throw new TsonSchemaValidationError(
      `'${head}' declares no type parameters, so '${head}<...>' applies arguments to something that ` +
        'takes none (§5.10); drop the argument list',
    );
  }
}

// ── The desugar table (§5.3): one sugar form, one binding record ─────────────────────────────

const ARRAY = metaName('array');
const MAP = metaName('map');
const TUPLE = metaName('tuple');
const CHOICE = metaName('choice');
const DEPENDENT = metaName('dependent');

const ELEMENT_TYPE = 'element_type';
const KEY_TYPE = 'key_type';
const VALUE_TYPE = 'value_type';
const MIN_ITEMS = 'min_items';
const MAX_ITEMS = 'max_items';
const ELEMENTS = 'elements';
const VARIANTS = 'variants';

/** A sugar form reduced to what it denotes: a fixed constructor head and the vocabulary fields the form binds. */
interface Binding {
  readonly head: string;
  readonly fields: readonly RecordField[];
}

/** `!head { field: value ... }` -- the construction a binding record denotes. */
function construction(binding: Binding): DataValue {
  return {
    annotations: [],
    typeRef: binding.head,
    coreValue: { kind: 'record', fields: binding.fields },
  };
}

/** One type slot as the wire field a construction writes -- see {@link slotValue}. */
function slot(name: string, ref: TypeExpr): RecordField {
  return { name, value: scoped(slotValue(ref)) };
}

/**
 * What a type slot holds in a binding record: a bare token for a plain name, and a nested construction or an
 * application in the wrapper a type written in place takes, `{ of: !meta.array { ... } }` (`meta.type_inline`),
 * written untagged, the slot's choice being disjoint by class (§5.4). One spelling per shape.
 */
function slotValue(ref: TypeExpr): CoreValue {
  switch (ref.kind) {
    case 'inlineConstruction':
      return { kind: 'record', fields: [{ name: OF, value: ref.value }] };
    case 'applicationRef':
      return { kind: 'record', fields: [{ name: OF, value: applicationValue(ref) }] };
    case 'nameRef':
      return tokenValue(ref.name);
    default:
      throw new TsonSchemaValidationError(`'${spell(ref)}' reached a type slot unexpanded`);
  }
}

/**
 * `generic` as the construction it is, `!meta.apply { head: H  arguments: [...] }`: a reference holds a name, so
 * an application at a slot is written in place (§5.10), each argument a slot value in turn.
 */
export function applicationValue(generic: ApplicationRef): DataValue {
  return construction({
    head: APPLY,
    fields: [
      nameField(HEAD, generic.name),
      {
        name: ARGUMENTS,
        value: scoped({
          kind: 'array',
          elements: generic.args.map((argument) => scoped(slotValue(argument))),
        }),
      },
    ],
  });
}

/** A declaration-level sugar form as the binding record it denotes, or `undefined` for a body that is no sugar form. */
function declarationBinding(ref: TypeExpr, pass: DesugarPass): Binding | undefined {
  switch (ref.kind) {
    case 'arrayExpr':
    case 'mapExpr':
    case 'tupleExpr':
    case 'choiceExpr':
      return sugarBinding(ref, pass);
    default:
      return undefined;
  }
}

type SugarForm = Extract<TypeExpr, { kind: 'arrayExpr' | 'mapExpr' | 'tupleExpr' | 'choiceExpr' }>;

/** The binding record of the sugar form `ref`, its positions rewritten first. */
function sugarBinding(ref: SugarForm, pass: DesugarPass): Binding {
  switch (ref.kind) {
    case 'arrayExpr':
      return arrayBinding(
        elementRef(ref.elementType, pass),
        ref.elementType.voidable,
        ref.size,
        shownElement(ref.elementType),
      );
    case 'mapExpr':
      return mapBinding(
        typeRef(ref.keyType, pass),
        elementRef(ref.valueType, pass),
        ref.valueType.voidable,
        ref.size,
      );
    case 'tupleExpr':
      return tupleBinding(
        ref.elementTypes.map((element) => ({
          typeRef: elementRef(element, pass),
          voidable: element.voidable,
        })),
      );
    case 'choiceExpr':
      return choiceBinding(ref.variants.map((variant) => typeRef(variant, pass)));
  }
}

/**
 * `!meta.array { element_type: T [voidable: true] [min_items: N] [max_items: M] }` -- the element `?` binds
 * `voidable` directly; an unmarked element states nothing and lets §5.2's default injection supply it.
 */
function arrayBinding(
  element: TypeExpr,
  voidable: boolean,
  size: SizeSpec | undefined,
  shown: string,
): Binding {
  const fields: RecordField[] = [slot(ELEMENT_TYPE, element)];
  if (voidable) fields.push(nameField(VOIDABLE, 'true'));
  if (size !== undefined) fields.push(...sizeFields(size, `[${shown}; 0..]`));
  return { head: ARRAY, fields };
}

/**
 * `!meta.map { key_type: K  value_type: V [voidable: true] [min_items: N] [max_items: M] }`. A key is a name
 * (§5.3): `key_type` is a `meta.type_ref`, so an application there is refused, closing nowhere.
 */
function mapBinding(
  key: TypeExpr,
  value: TypeExpr,
  voidable: boolean,
  size: SizeSpec | undefined,
): Binding {
  if (key.kind === 'applicationRef') {
    throw new TsonSchemaValidationError(
      `'${spell(key)}' is an application, and a map's key holds only a name, where an application closes ` +
        `nowhere (§4.2): declare it ('my_${key.name} => ${spell(key)}') and write that name`,
    );
  }
  const fields: RecordField[] = [slot(KEY_TYPE, key), slot(VALUE_TYPE, value)];
  if (voidable) fields.push(nameField(VOIDABLE, 'true'));
  if (size !== undefined) {
    fields.push(...sizeFields(size, `{${shownRef(key)} => ${shownRef(value)}; 0..}`));
  }
  return { head: MAP, fields };
}

function shownRef(ref: TypeExpr): string {
  if (ref.kind === 'nameRef') return ref.name;
  if (ref.kind === 'applicationRef') return `${ref.name}<...>`;
  return 'T';
}

/**
 * `!meta.tuple { elements: [{ element_type: T } { element_type: U }] }` -- each position a
 * `meta.tuple_element` record carrying a type and, where marked, its own `voidable`.
 */
function tupleBinding(
  positions: readonly { readonly typeRef: TypeExpr; readonly voidable: boolean }[],
): Binding {
  const elements = positions.map((position) => {
    const members: RecordField[] = [slot(ELEMENT_TYPE, position.typeRef)];
    if (position.voidable) members.push(nameField(VOIDABLE, 'true'));
    return scoped({ kind: 'record', fields: members });
  });
  return {
    head: TUPLE,
    fields: [{ name: ELEMENTS, value: scoped({ kind: 'array', elements }) }],
  };
}

/** `!meta.choice { variants: [A B ...] }` -- a variant is a type slot like any other (`variants: [meta.type_expr]`). */
function choiceBinding(variants: readonly TypeExpr[]): Binding {
  return {
    head: CHOICE,
    fields: [
      {
        name: VARIANTS,
        value: scoped({
          kind: 'array',
          elements: variants.map((variant) => scoped(slotValue(variant))),
        }),
      },
    ],
  };
}

/**
 * `!meta.record { fields: { ... }  groups: [ ... ]  discriminators: [ ... ] }` -- a record body at a type slot,
 * its forms already written in place. Each field is the `meta.record_field` its marks make, a fact written only
 * where it is no default; a group member is a field, optional, its presence the group's. What the value cannot
 * carry, its annotations, is kept against it ({@link WRITTEN_FIELDS}).
 */
function recordBinding(record: RecordDef, pass: DesugarPass): Binding {
  const fields: MapEntry[] = [];
  const groups: DataValue[] = [];
  const discriminators: DataValue[] = [];
  const seen = new Set<string>();
  for (const entry of record.entries) {
    if (entry.kind === 'fieldDef') {
      if (entry.type === undefined) {
        throw new TsonSchemaValidationError(
          `field '${entry.name}' states only a modifier and no type, and a record written in place declares ` +
            'every field with its type -- a modifier-only entry is a restatement, written in a composition ' +
            'body (§5.8)',
        );
      }
      const facts = resolveFieldMarks(
        entry.name,
        entry.optional,
        entry.type.voidable,
        entry.modifier,
      );
      const token = facts.value;
      if (token?.form === 'unquoted' && pass.currentParameters.includes(token.text)) {
        throw atValue(token.text, entry.name);
      }
      if (facts.selector) {
        discriminators.push(scoped(tokenValue(entry.name, 'single-line')));
      }
      const value = fieldValue(entry.type.typeRef as TypeExpr, facts);
      WRITTEN_FIELDS.set(value, { annotations: entry.annotations });
      fields.push(fieldEntry(entry.name, value, seen));
    } else {
      for (const member of groupMembers(entry)) {
        const value = fieldValue(member.typeRef as TypeExpr, {
          optional: true,
          voidable: member.voidable,
          role: 'FREE',
          selector: false,
        });
        WRITTEN_FIELDS.set(value, { annotations: member.annotations });
        fields.push(fieldEntry(member.name, value, seen));
      }
      groups.push(groupValue(lowerGroup(entry)));
    }
  }
  const binding: RecordField[] = [
    {
      name: FIELDS,
      value: scoped(
        fields.length === 0 ? { kind: 'empty-brace' } : { kind: 'map', entries: fields },
      ),
    },
  ];
  if (groups.length > 0) {
    binding.push({ name: GROUPS, value: scoped({ kind: 'array', elements: groups }) });
  }
  if (discriminators.length > 0) {
    // `=?` implies ABSTRACT (§5.2).
    binding.push(nameField(EXTENSION, 'ABSTRACT'));
    binding.push({
      name: DISCRIMINATORS,
      value: scoped({ kind: 'array', elements: discriminators }),
    });
  }
  return { head: RECORD, fields: binding };
}

/** One entry of a record in place's `fields`, its name refused where the record already declares it. */
function fieldEntry(name: string, value: DataValue, seen: Set<string>): MapEntry {
  if (seen.has(name)) {
    throw new TsonSchemaValidationError(
      `field '${name}' is declared more than once in a record written in place -- a field name is unique ` +
        "across a record's plain fields and all its groups' members (§5.11)",
    );
  }
  seen.add(name);
  return { key: scoped(tokenValue(name, 'single-line')), value };
}

/** A field's `meta.record_field` value: its type, and each fact its marks state. */
function fieldValue(type: TypeExpr, facts: ResolvedFieldMarks): DataValue {
  const members: RecordField[] = [slot(TYPE, type)];
  if (facts.optional) members.push(nameField(OPTIONAL, 'true'));
  if (facts.voidable) members.push(nameField(VOIDABLE, 'true'));
  if (facts.role !== 'FREE') members.push(nameField(ROLE, facts.role));
  if (facts.value !== undefined) members.push({ name: VALUE, value: scoped(facts.value) });
  return scoped({ kind: 'record', fields: members });
}

/**
 * §5.3's size specifier as the `min_items`/`max_items` pair it binds -- one rule for arrays and maps alike. An
 * exact `N` pins both, so `[T; 3]` and `[T; 3..3]` build one construction. A zero floor with no upper bound is
 * refused, meaning exactly what the unbounded form means.
 */
function sizeFields(size: SizeSpec, shown: string): RecordField[] {
  switch (size.kind) {
    case 'min':
      if (size.lower === '0') {
        throw new TsonSchemaValidationError(
          `'${shown}' pins a floor of zero, which every container already satisfies -- drop the size ` +
            'specifier for the unconstrained form (§5.3)',
        );
      }
      return [nameField(MIN_ITEMS, size.lower)];
    case 'max':
      return [nameField(MAX_ITEMS, size.upper)];
    case 'ranged':
      return [nameField(MIN_ITEMS, size.lower), nameField(MAX_ITEMS, size.upper)];
    case 'exact':
      return [nameField(MIN_ITEMS, size.bound), nameField(MAX_ITEMS, size.bound)];
  }
}

/** A size bound naming one of the enclosing declaration's parameters, `[T; N]`, refused naming the slot (§5.10). */
function refuseParameterBound(binding: Binding, pass: DesugarPass): void {
  for (const f of binding.fields) {
    if (f.name !== MIN_ITEMS && f.name !== MAX_ITEMS) continue;
    const value = f.value.coreValue;
    if (value.kind === 'token' && pass.currentParameters.includes(value.text)) {
      throw at(value.text, `a size bound (${binding.head}.${f.name})`);
    }
  }
}

/** The type an element or map-value position holds, rewritten ({@link typeRef}). */
function elementRef(element: ElementType, pass: DesugarPass): TypeExpr {
  return typeRef(element.typeRef, pass);
}

/** How an element position was spelled, for the one diagnostic that quotes the sugar form back. */
function shownElement(element: ElementType): string {
  return element.typeRef.kind === 'nameRef' ? element.typeRef.name : 'T';
}

// ── Spelling a form back, for a message ──────────────────────────────────────────────────────

/** A form as the author spells it, for a message. */
export function spell(ref: FieldTypeExpr): string {
  switch (ref.kind) {
    case 'nameRef':
      return ref.name;
    case 'applicationRef':
      return `${ref.name}<${ref.args.map(spell).join(', ')}>`;
    case 'arrayExpr':
      return `[${spellElement(ref.elementType)}${ref.size === undefined ? '' : spellSize(ref.size)}]`;
    case 'mapExpr':
      return `{${spell(ref.keyType)} => ${spellElement(ref.valueType)}${ref.size === undefined ? '' : spellSize(ref.size)}}`;
    case 'tupleExpr':
      return `[${ref.elementTypes.map(spellElement).join(', ')}]`;
    case 'choiceExpr':
      return `( ${ref.variants.map(spell).join(' | ')} )`;
    case 'recordExpr':
      return spellRecord(ref.body);
    case 'inlineConstruction':
      return `!${ref.value.typeRef ?? ''} { ... }`;
    case 'dependentType':
      return `${ref.on}!`;
  }
}

function spellRecord(record: RecordDef): string {
  const entries = record.entries.map((entry) => {
    if (entry.kind === 'fieldDef') {
      const type =
        entry.type === undefined
          ? ''
          : ` ${spell(entry.type.typeRef)}${entry.type.voidable ? '?' : ''}`;
      return `${entry.name}${entry.optional ? '?' : ''}:${type}${spellModifier(entry.modifier)}`;
    }
    const options = entry.options
      .map((option) =>
        option
          .map(
            (member) =>
              `${member.name}${member.omittable ? '?' : ''}: ${spell(member.typeRef)}${member.voidable ? '?' : ''}`,
          )
          .join('  '),
      )
      .join(' | ');
    const mark =
      entry.quantifier === 'AT_MOST_ONE' ? '?' : entry.quantifier === 'AT_LEAST_ONE' ? '+' : '';
    return `( ${options} )${mark}`;
  });
  return entries.length === 0 ? '{}' : `{ ${entries.join('  ')} }`;
}

function spellModifier(modifier: FieldModifier | undefined): string {
  if (modifier === undefined) return '';
  if (modifier.kind === 'selector') return ' =?';
  return `${modifier.kind === 'default' ? ' ~ ' : ' = '}${modifier.token.text}`;
}

function spellElement(element: ElementType): string {
  return `${spell(element.typeRef)}${element.voidable ? '?' : ''}`;
}

function spellSize(size: SizeSpec): string {
  switch (size.kind) {
    case 'exact':
      return `; ${size.bound}`;
    case 'ranged':
      return `; ${size.lower}..${size.upper}`;
    case 'min':
      return `; ${size.lower}..`;
    case 'max':
      return `; ..${size.upper}`;
  }
}

/** Maps `items`, returning the original list when every element came back identical. */
function mapShared<T>(items: readonly T[], rewrite: (item: T) => T): readonly T[] {
  let rewritten: T[] | undefined;
  items.forEach((item, index) => {
    const mapped = rewrite(item);
    if (mapped !== item && rewritten === undefined) rewritten = [...items];
    if (rewritten !== undefined) rewritten[index] = mapped;
  });
  return rewritten ?? items;
}
