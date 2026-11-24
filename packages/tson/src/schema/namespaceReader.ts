/**
 * Reads a value of a meta layer's own namespace type into the generic value model (Part 2 §4.1,
 * §5.12): `myapi => !api { get_orders => { response: order_list } }`, where the governing meta
 * declares `api => namespace & { key_type: = identifier  value_type: = method }`. The payload is
 * the map the constructor's facets describe -- each key a value of `key_type`, each value read
 * under `value_type` -- and the result is a {@link Namespace} of {@link MetaValue}s: a value, never
 * a type.
 *
 * **Directed by the meta's declarations, binding nothing.** A record value is read against its
 * declared record (its tag's, where a tag names a member of a family or a strict subtype): every
 * field declared, every required field present, every group's rule kept, every atom token a value
 * of its atom. What the value holds is kept as written, tokens with their quoting, so resolved
 * output writes back the spelling the author wrote. There is no host class to supply, which is how
 * `RUNNER.md`'s "A meta layer's own records" is met by construction.
 *
 * **A value body lifts and mints nothing** (§5.6). A slot typed by a kind holds one bare name,
 * and a slot typed by a reference a qualified name; a braced value at either is refused, the alias
 * spelling named, since no closer will mint an entry for an application written there. A name
 * carries no annotation and no type-ref -- its type is its referent's. Each name is kept with the
 * slot it was read at ({@link NameSlot}), so the linker judges it by the slot's declared type
 * however the value was reached (`link/valuesByName.ts`). A slot typed by a record holds the
 * record's value inline and takes no name: §5.6's positional form does not stand in a schema
 * document for a product-typed slot.
 *
 * Every refusal is a {@link TsonReadError}, which the definition resolver reports as the body not
 * being valid data for its constructor -- a resolver error (§8.1).
 *
 * {@link writeNamespaceValue} is the other direction, the value as resolved output writes it: as
 * written, a value by name as the name (§8.3). A meta layer's record has no fixed shape a binding
 * could describe, so it is written from the generic model directly rather than through
 * `schema/bindings.ts`'s descriptors.
 */
import type {
  CoreValue,
  DataValue,
  TokenValue,
  Annotation as WrittenAnnotation,
} from '../ast/value.js';
import type { DiagnosticCode } from '../core/diagnostic.js';
import type { DefinitionValueReader, MemberJoiners } from '../compiler/resolverTypes.js';
import {
  TsonAtomParseError,
  TsonAtomValidationError,
  TsonInternalError,
  TsonNotImplementedError,
  TsonReadError,
} from '../core/errors.js';
import { atomParserFor, isScalarBody } from '../atom/forType.js';
import { createQualifiedNameParser } from '../atom/reference.js';
import { parseReference } from '../atom/referenceGrammar.js';
import { terminal, type EntryLookup } from '../link/aliasChain.js';
import { referenceIn, writtenWithoutItsSibling } from '../link/dependentFields.js';
import { lexerFormOfMeta, metaFormOfLexer } from '../compiler/tokenForms.js';
import { isIdentifierText } from '../unicode/identifier-profile.js';
import {
  fieldOmission,
  groupRefusals,
  isGroupMember,
  type ArrayBody,
  type RecordField,
  type ChoiceBody,
  type MapBody,
  type RecordBody,
  type TupleBody,
  typeExprText,
} from './meta/bodies.js';
import type {
  Annotation,
  Annotations,
  MetaHeldValue,
  MetaValue,
  Namespace,
  NameSlot,
  Token,
  Top,
  TypeExpr,
} from './meta/typedef.js';
import {
  dependentOn,
  isConstructor,
  isParametric,
  namespaceOf,
  subtypesOf,
  supertypesOf,
} from './meta/typedef.js';
import { isNamespaceType, namespaceMapOf } from './meta/namespaces.js';
import type { IdentifierType } from './meta/atoms-text.js';
import { TsonNameHygieneRefusedError } from '../core/errors.js';
import { identifierProfileOf } from '../unicode/identifier-profile.js';
import { applyNormalization } from '../unicode/normalization.js';
import {
  DEFAULT_IDENTIFIER_POLICY,
  judgeName,
  nameHygieneRefusal,
  type IdentifierPolicy,
  type NameHygieneRefusal,
} from '../unicode/policy.js';
import { UTS39_VERSION } from '../unicode/uts39.js';

/**
 * Reads `value`, the payload of `!type { ... }` where `type` is an ordinary type -- a value entry (§4.1) --
 * as a value of it, in the schema's one namespace `meta`, where every name the read follows is declared.
 * A namespace type's value is the map its facets describe, a record type's the record, and so on down.
 *
 * @throws TsonReadError where the payload is no value of the type.
 */
export function readValueEntry(
  type: string,
  value: DataValue,
  meta: EntryLookup,
  identifierPolicy: IdentifierPolicy = DEFAULT_IDENTIFIER_POLICY,
  joiners?: MemberJoiners,
): MetaValue {
  const read = new ValueBodyReader(meta, identifierPolicy, joiners);
  // The payload's own tag names its type, which the position states already.
  const untagged: DataValue = value.typeRef === type ? withoutTag(value) : value;
  return read.value(untagged, type, []);
}

function withoutTag(value: DataValue): DataValue {
  const { typeRef: _tag, ...rest } = value;
  void _tag;
  return rest;
}

/** {@link readValueEntry} as the `DefinitionValueReader` the definition resolver reads a value entry's payload through. */
export function createDefinitionValueReader(
  meta: EntryLookup,
  identifierPolicy?: IdentifierPolicy,
  joiners?: MemberJoiners,
): DefinitionValueReader {
  return (type, value) => readValueEntry(type, value, meta, identifierPolicy, joiners);
}

/**
 * `value` written back as the data value it was read from (§8.1, §8.3): tagged with its
 * constructor, each key bare where it is an identifier and quoted otherwise, with the annotations
 * written at it, each value as written -- a name as the bare token it was, never the value it
 * reaches, and a record tagged only where its tag names a type other than its position's. A
 * namespace value held under a key or in a field is written as its map, untagged: the slot's type
 * already names its constructor.
 */
export function writeNamespaceValue(value: Namespace<MetaValue>): DataValue {
  return { annotations: [], typeRef: value.type, coreValue: namespaceMapValue(value) };
}

function namespaceMapValue(value: Namespace<MetaValue>): CoreValue {
  return {
    kind: 'map',
    entries: [...value.entries].map(([key, entry]) => ({
      key: {
        annotations: (value.keyAnnotations?.get(key) ?? []).map(writtenAnnotationOf),
        coreValue: {
          kind: 'token',
          text: key,
          form: isIdentifierText(key) ? 'unquoted' : 'single-line',
        },
      },
      value: metaDataValue(entry),
    })),
  };
}

/** `value` as the data value it was read from (§8.1): a name as the token it was, a record tagged where its tag names a member. */
export function metaDataValue(value: MetaValue): DataValue {
  const written = unannotatedDataValue(value);
  const annotations = 'annotations' in value ? (value.annotations ?? []) : [];
  return annotations.length === 0
    ? written
    : { ...written, annotations: annotations.map(writtenAnnotationOf) };
}

function unannotatedDataValue(value: MetaValue): DataValue {
  switch (value.form) {
    case 'token':
      return {
        annotations: [],
        coreValue: {
          kind: 'token',
          text: value.token.text,
          form: lexerFormOfMeta(value.token.form),
        },
      };
    case 'schema_map':
      throw new TsonInternalError(
        'a nested schema map is written by the resolved-output writer, with its members, never as a value body',
      );
    case 'void':
      return { annotations: [], coreValue: { kind: 'void' } };
    case 'list':
      return {
        annotations: [],
        coreValue: {
          kind: 'array',
          elements: value.elements.map((element) => metaDataValue(element)),
        },
      };
    case 'map':
      return {
        annotations: [],
        coreValue: {
          kind: 'map',
          entries: value.entries.map(([key, entry]) => ({
            key: metaDataValue(key),
            value: metaDataValue(entry),
          })),
        },
      };
    case 'record':
      return {
        annotations: [],
        ...(value.type === undefined ? {} : { typeRef: value.type }),
        coreValue:
          value.fields.size === 0
            ? { kind: 'empty-brace' }
            : {
                kind: 'record',
                fields: [...value.fields].map(([name, field]) => ({
                  name,
                  value: metaDataValue(field),
                })),
              },
      };
    case 'held':
      return value.written as DataValue;
    case 'namespace':
      return { annotations: [], coreValue: namespaceMapValue(value.value) };
  }
}

/** A key annotation as it was written: its value is the data value read at it. */
function writtenAnnotationOf(annotation: Annotation): WrittenAnnotation {
  return annotation.value === undefined
    ? { name: annotation.name }
    : { name: annotation.name, value: annotation.value as DataValue };
}

class ValueBodyReader {
  constructor(
    private readonly meta: EntryLookup,
    private readonly policy: IdentifierPolicy,
    private readonly joiners?: MemberJoiners,
  ) {}

  /** The name a type slot holds, or the source spelling of a type written in place there (§4.2). */
  private named(ref: TypeExpr): string {
    return ref.kind === 'inline' ? typeExprText(ref) : ref.name;
  }

  private identifierFamily(type: TypeExpr | string): IdentifierType | undefined {
    if (typeof type !== 'string' && type.kind === 'inline') return undefined;
    const body = this.meta(terminal(typeof type === 'string' ? type : type.name, this.meta));
    return body?.kind === 'identifier_type' ? body : undefined;
  }

  /**
   * §8.2's name hygiene over `names`, one scope of values of the identifier family `family`: the
   * keys of one namespace value or one identifier-keyed map, the elements of one unique array, or a
   * single identifier-typed value. A namespace value is a payload the linker cannot see into -- a
   * map keyed by names whose values are a meta layer's own records -- so its names are judged here,
   * at the read, under the processor's identifier policy as the same values are in a data document
   * ([TSON-SCHEMA] §11.4). Skeleton distinctness relates the scope's names first, then each name
   * meets the per-name rules under the family's profile, in the family's form.
   *
   * @throws TsonNameHygieneRefusedError the first refusal: §8.1's refused outcome, never a finding
   *   about validity.
   */
  private judgeNames(
    names: readonly string[],
    family: IdentifierType,
    path: readonly string[],
  ): void {
    const values = names.map((name) => applyNormalization(family.normalization, name));
    const where = path.length === 0 ? 'a namespace value' : `'${path.join('.')}'`;
    const refuse = (refusal: NameHygieneRefusal): never => {
      throw new TsonNameHygieneRefusedError(
        `${where} holds a name refused under [TSON-DATA] §8.2's name-hygiene policy: ` +
          `${refusal.detail} (computed against UTS #39 version ${UTS39_VERSION})`,
        { mechanism: refusal.mechanism, names: refusal.names, uts39Version: UTS39_VERSION },
      );
    };
    if (values.length > 1) {
      const relation = nameHygieneRefusal(values, {
        ...this.policy,
        restrictionLevel: 'UNRESTRICTED',
      });
      if (relation !== undefined) refuse(relation);
    }
    const profile = identifierProfileOf(family);
    for (const value of values) {
      const [violation] = judgeName(value, profile, this.policy);
      if (violation !== undefined) {
        refuse({ mechanism: violation.mechanism, names: [value], detail: violation.detail });
      }
    }
  }

  /**
   * `type`'s entry at the end of its chain (§8.3), under the name it is declared by; a type written in place is
   * its own body, named by its spelling (§4.2).
   */
  private resolved(type: string | TypeExpr): { readonly name: string; readonly body: Top } {
    if (typeof type !== 'string') {
      if (type.kind === 'inline') return { name: typeExprText(type), body: type.of };
      return this.resolved(type.name);
    }
    const name = terminal(type, this.meta);
    const body = this.meta(name);
    if (body === undefined) {
      throw new TsonReadError({
        code: 'UNKNOWN_TYPE_REF',
        message: `'${type}' names no type of the governing meta-schema`,
      });
    }
    return { name, body };
  }

  namespace(value: DataValue, type: string, path: readonly string[]): Namespace<MetaValue> {
    const { name, body } = this.resolved(type);
    if (!isNamespaceType(body)) {
      throw new TsonReadError({
        code: 'TYPE_MISMATCH',
        message: `${at(path)}'${type}' is no namespace type`,
      });
    }
    const map = namespaceMapOf(body);
    const core = value.coreValue;
    if (core.kind !== 'map' && core.kind !== 'empty-brace') {
      throw mismatch(path, `a value of the namespace type '${name}', a map of names`, core);
    }
    const entries: (readonly [string, MetaValue])[] = [];
    const keyAnnotations = new Map<string, Annotations>();
    const seen = new Set<string>();
    for (const entry of core.kind === 'map' ? core.entries : []) {
      const key = this.key(entry.key, map.keyType, path, name);
      if (seen.has(key)) {
        throw new TsonReadError({
          code: 'DUPLICATE_MAP_KEY',
          message: `${at(path)}'${name}' holds the key '${key}' twice`,
        });
      }
      seen.add(key);
      if (entry.key.annotations.length > 0) {
        keyAnnotations.set(key, entry.key.annotations.map(annotationOf));
      }
      entries.push([key, this.value(entry.value, map.valueType, [...path, key])]);
    }
    // A namespace type refines `meta.map`, so its size bounds bound a value as a map's do (§4.1, §5.3).
    if (body.minItems !== undefined && BigInt(entries.length) < body.minItems) {
      throw new TsonReadError({
        code: 'TYPE_MISMATCH',
        message: `${at(path)}'${name}' has ${String(entries.length)} entries, fewer than the minimum ${body.minItems.toString()}`,
      });
    }
    if (body.maxItems !== undefined && BigInt(entries.length) > body.maxItems) {
      throw new TsonReadError({
        code: 'TYPE_MISMATCH',
        message: `${at(path)}'${name}' has ${String(entries.length)} entries, more than the maximum ${body.maxItems.toString()}`,
      });
    }
    const keyFamily = this.identifierFamily(map.keyType);
    if (keyFamily !== undefined) this.judgeNames([...seen], keyFamily, path);
    return namespaceOf(name, entries, keyAnnotations);
  }

  /** A namespace's key: a token, a value of the type's `key_type` -- a name (§4.1). */
  private key(key: DataValue, keyType: string, path: readonly string[], owner: string): string {
    const core = key.coreValue;
    if (core.kind !== 'token' || key.typeRef !== undefined) {
      throw mismatch(path, `a key of '${owner}', a name of '${keyType}'`, core);
    }
    const { name, body } = this.resolved(keyType);
    this.atom(name, body, { text: core.text, form: metaFormOfLexer(core.form) }, path);
    return core.text;
  }

  value(written: DataValue, slot: string | TypeExpr, path: readonly string[]): MetaValue {
    const position = this.resolved(slot);
    // A name carries no annotation (its type is its referent's), and `_` holds nothing to annotate: both refuse
    // one where they read. Every other value keeps its own, read in this schema's namespace (§6).
    if (
      position.body.kind === 'ref' ||
      written.coreValue.kind === 'void' ||
      written.annotations.length === 0
    ) {
      return this.unannotated(written, position, path);
    }
    const annotations = this.annotations(written.annotations, path);
    const read = this.unannotated({ ...written, annotations: [] }, position, path);
    return read.form === 'void' || read.form === 'held' || read.form === 'schema_map'
      ? read
      : { ...read, annotations };
  }

  /**
   * The annotations written in front of a value (§6), each name resolved and each value judged against the type it
   * names, in the namespace of the schema writing the value -- whichever schema declared the value's type. The
   * values are kept as written, as a key's are.
   */
  private annotations(written: readonly WrittenAnnotation[], path: readonly string[]): Annotations {
    return written.map((annotation) => {
      const end = terminal(annotation.name, this.meta);
      if (this.meta(end) === undefined) {
        throw new TsonReadError({
          code: 'UNKNOWN_TYPE_REF',
          message: `${at(path)}the annotation '@${annotation.name}' names no type of this schema's namespace (§6)`,
        });
      }
      if (annotation.value !== undefined) {
        this.value(annotation.value, annotation.name, [...path, `@${annotation.name}`]);
      }
      return annotationOf(annotation);
    });
  }

  private unannotated(
    written: DataValue,
    position: { readonly name: string; readonly body: Top },
    path: readonly string[],
  ): MetaValue {
    const { name, body, value } = this.subsumed(written, position);
    const type = name;
    if (body.kind === 'incomplete' || isParametric(body)) {
      throw new TsonReadError({
        code: 'TYPE_MISMATCH',
        message:
          body.kind === 'incomplete'
            ? `${at(path)}'${type}' is an incomplete entry, which is no type (§5.5)`
            : `${at(path)}'${type}' is a parametric record, which describes no value until applied (§5.10)`,
      });
    }
    switch (body.kind) {
      case 'ref':
        return this.name(value, path, {
          role: this.namesTypes(body.of.name) ? 'TYPE_NAME' : 'VALUE_NAME',
          type: name,
          of: body.of.name,
        });
      case 'namespace':
        refuseFraming(value, path, name);
        return { form: 'namespace', value: this.namespace(value, name, path) };
      case 'record':
        return this.record(value, name, body, path);
      case 'array':
        refuseFraming(value, path, name);
        return this.list(value, name, body, path);
      case 'map':
        refuseFraming(value, path, name);
        return this.map(value, name, body, path);
      case 'tuple':
        refuseFraming(value, path, name);
        return this.tuple(value, name, body, path);
      case 'choice':
        return this.choice(value, name, body, path);
      case 'alias':
      case 'value_entry':
        throw new TsonReadError({
          code: 'TYPE_MISMATCH',
          message: `${at(path)}'${type}' is a value and not a type, so nothing is read under it (§4.1)`,
        });
      case 'extern':
        throw new TsonNotImplementedError(
          `${at(path)}'${type}' is an extern (§5.13) inside a value entry's own value, which this library ` +
            'does not read yet',
        );
      case 'apply':
        throw new TsonNotImplementedError(
          `${at(path)}'${type}' is an application of a parametric record no resolution closed here (§5.10)`,
        );
      case 'dependent':
        throw new TsonReadError({
          code: 'TYPE_MISMATCH',
          message: `${at(path)}'${type}' is a dependent type, read only at a record field's type (§5.2)`,
        });
      case 'declared_type':
        throw new TsonNotImplementedError(
          `${at(path)}'${type}' is a declared position (§7.8) inside a value entry's own value, which ` +
            'this library does not read yet',
        );
      case 'void_type':
        refuseFraming(value, path, name);
        if (value.coreValue.kind !== 'void')
          throw mismatch(path, 'the void sentinel', value.coreValue);
        return { form: 'void' };
      default: {
        refuseFraming(value, path, name);
        const core = value.coreValue;
        if (core.kind !== 'token') throw mismatch(path, `a value of '${name}'`, core);
        const token = { text: core.text, form: metaFormOfLexer(core.form) };
        this.atom(name, body, token, path);
        if (body.kind === 'identifier_type') this.judgeNames([core.text], body, path);
        return { form: 'token', token };
      }
    }
  }

  /**
   * The type `value` is read under: the position's, or the one its tag names where that type IS-A the position's
   * and is built as it is (§7.2) -- a refinement of a namespace, array or map type, or of an atom, stands where its
   * source is wanted and is read as itself. A record and a choice judge their own tags; any other tag is left on
   * the value, for the read to refuse.
   */
  private subsumed(
    value: DataValue,
    position: { readonly name: string; readonly body: Top },
  ): { readonly name: string; readonly body: Top; readonly value: DataValue } {
    const tag = value.typeRef;
    const kind = position.body.kind;
    if (tag === undefined || kind === 'record' || kind === 'choice' || kind === 'ref') {
      return { ...position, value };
    }
    const name = terminal(tag, this.meta);
    const body = this.meta(name);
    const isA =
      body !== undefined &&
      (name === position.name ||
        (body.kind === kind && supertypesOf(body).includes(position.name)));
    return isA ? { name, body, value: withoutTag(value) } : { ...position, value };
  }

  /** Whether `of` names a constructor, so a reference over it holds a type's name rather than a value's (§4.2). */
  private namesTypes(of: string): boolean {
    const name = terminal(of, this.meta);
    const body = this.meta(name);
    return body !== undefined && isConstructor(body, name);
  }

  /** `token` judged a value of the atom `name`'s body (§5). */
  private atom(name: string, body: Top, token: Token, path: readonly string[]): void {
    if (!isScalarBody(body)) {
      throw new TsonReadError({
        code: 'TYPE_MISMATCH',
        message: `${at(path)}'${name}' is no atom, so no token is a value of it`,
      });
    }
    // A reference naming types holds a type's name, every segment an identifier; one naming values holds a
    // qualified name whose segments past the first are names of the families they enter, judged by the walk
    // that resolves it when the schema links (§5.12).
    const parser =
      body.kind !== 'ref'
        ? atomParserFor(name, body)
        : this.namesTypes(body.of.name)
          ? createQualifiedNameParser(name)
          : VALUE_NAME;
    if (parser === undefined) return;
    try {
      parser.read({ text: token.text, form: lexerFormOfMeta(token.form) });
    } catch (error) {
      if (error instanceof TsonAtomParseError || error instanceof TsonAtomValidationError) {
        throw new TsonReadError({
          code:
            error instanceof TsonAtomParseError ? 'ATOM_FORM_INVALID' : 'ATOM_CONSTRAINT_VIOLATION',
          message: `${at(path)}${error.message}`,
        });
      }
      throw error;
    }
  }

  /**
   * A name at a slot typed by a kind, a reference or `type_ref` (§4.2, §5.12): one unquoted
   * token, carrying neither an annotation nor a type-ref, its spelling judged by the slot's
   * grammar. What it names is the linker's to judge.
   */
  private name(value: DataValue, path: readonly string[], slot: NameSlot): MetaValue {
    const wanted =
      slot.role === 'TYPE_NAME'
        ? `the name of a type built with '${slot.of}' (a member of '${slot.type}')`
        : `the name of a '${slot.of}' value`;
    const [first] = value.annotations;
    if (first !== undefined) {
      throw new TsonReadError({
        code: 'TYPE_MISMATCH',
        message:
          `${at(path)}expected ${wanted}, found the annotation '@${first.name}' -- a name carries ` +
          'none: its type is its referent’s, and an annotation would have nowhere to go',
      });
    }
    if (value.typeRef !== undefined) {
      throw new TsonReadError({
        code: 'TYPE_MISMATCH',
        message:
          `${at(path)}expected ${wanted}, found the type-ref '!${value.typeRef}' -- a name ` +
          'carries none: its type is its referent’s',
      });
    }
    const core = value.coreValue;
    // A quoted token at a reference is the reference its text spells, as an unquoted one is (§5.12).
    if (core.kind === 'token') {
      const token: Token = { text: core.text, form: metaFormOfLexer(core.form) };
      this.atom(slot.type, { kind: 'ref', of: { name: slot.of, annotations: [] } }, token, path);
      return { form: 'token', token, slot };
    }
    if (core.kind === 'record' || core.kind === 'map' || core.kind === 'empty-brace') {
      throw new TsonReadError({
        code: 'TYPE_MISMATCH',
        message:
          `${at(path)}expected ${wanted}, found ${describe(core)} -- a position typed by a reference ` +
          'holds a name, one bare token, and nothing in a value body lifts or mints an entry for an ' +
          'application written there; declare an alias for it (order_box => box<order>) and write its ' +
          'name (§5.6)',
      });
    }
    throw mismatch(path, wanted, core);
  }

  private record(
    value: DataValue,
    declared: string,
    declaredBody: RecordBody,
    path: readonly string[],
  ): MetaValue {
    refuseAnnotations(value, path, declared);
    let name = declared;
    let body = declaredBody;
    if (value.typeRef !== undefined) {
      const tagged = this.resolved(value.typeRef);
      if (
        tagged.body.kind !== 'record' ||
        (tagged.name !== declared && !supertypesOf(tagged.body).includes(declared))
      ) {
        throw new TsonReadError({
          code: 'TYPE_MISMATCH',
          message: `${at(path)}the tag '!${value.typeRef}' names no record that IS-A '${declared}' (§7.2)`,
        });
      }
      name = tagged.name;
      body = tagged.body;
    } else if (body.extension === 'ABSTRACT' && body.discriminators !== undefined) {
      const member = this.placedByPins(value, name, body, path);
      name = member.name;
      body = member.body;
    }
    if (body.extension === 'ABSTRACT') {
      const members = subtypesOf(body).filter((subtype) => {
        const member = this.meta(subtype);
        return member?.kind === 'record' && member.extension !== 'ABSTRACT';
      });
      throw new TsonReadError({
        code: 'TYPE_MISMATCH',
        message:
          `${at(path)}'${name}' is abstract, so a value here names the member it is with a tag` +
          (members.length === 0 ? '' : ` -- one of ${members.map((m) => `'!${m}'`).join(', ')}`),
      });
    }
    const core = value.coreValue;
    if (core.kind !== 'record' && core.kind !== 'empty-brace') {
      throw mismatch(
        path,
        `a '${name}' record, written inline -- a slot typed by a record holds the record's value and takes no name`,
        core,
      );
    }
    const fields = new Map<string, MetaValue>();
    for (const field of core.kind === 'record' ? core.fields : []) {
      const declaration = body.fields.entries.get(field.name);
      if (declaration === undefined) {
        throw new TsonReadError({
          code: 'UNRECOGNIZED_FIELD',
          message:
            `${at(path)}'${name}' declares no field '${field.name}' -- it declares ` +
            ([...body.fields.entries.keys()].map((n) => `'${n}'`).join(', ') || 'none'),
        });
      }
      if (fields.has(field.name)) {
        throw new TsonReadError({
          code: 'DUPLICATE_FIELD',
          message: `${at(path)}'${name}' writes the field '${field.name}' twice`,
        });
      }
      const written = field.value;
      const at_ = [...path, field.name];
      if (written.coreValue.kind === 'void' && written.typeRef === undefined) {
        if (!declaration.voidable) {
          throw new TsonReadError({
            code: 'TYPE_MISMATCH',
            message: `${at(at_)}'${name}.${field.name}' is not voidable, so '_' is no value of it`,
          });
        }
        fields.set(field.name, { form: 'void' });
        continue;
      }
      // A dependent field's value is read against the type its sibling names in each instance, which the
      // reading schema's closure alone holds: a schema document holds it as written (§5.2), and the link
      // judges it.
      let read: MetaValue;
      const sibling = dependentOn(declaration.type);
      if (sibling !== undefined) {
        const siblingDeclared = body.fields.entries.get(sibling);
        if (siblingDeclared === undefined) {
          throw new TsonReadError({
            code: 'UNRECOGNIZED_FIELD',
            message: `${at(at_)}'${name}.${field.name}' is typed by the sibling '${sibling}', and '${name}' declares no field '${sibling}'`,
          });
        }
        read = heldAsWritten(written, field.name, sibling, siblingDeclared);
      } else {
        read = this.value(written, declaration.type, at_);
      }
      if (
        declaration.role === 'FIXED' &&
        declaration.value !== undefined &&
        read.form === 'token' &&
        read.token.text !== declaration.value.text
      ) {
        throw new TsonReadError({
          code: 'FIELD_FIXED',
          message: `${at(at_)}'${name}.${field.name}' is fixed at '${declaration.value.text}', and the value writes '${read.token.text}'`,
        });
      }
      fields.set(field.name, read);
    }
    // What each held value's sibling holds in this instance, now every field is read (§5.2): the sibling
    // may be written after the dependent field here, a schema document's order insignificant.
    for (const [fieldName, held] of [...fields]) {
      if (held.form !== 'held') continue;
      fields.set(fieldName, this.typed(name, body, fields, held));
    }
    for (const [fieldName, declaration] of body.fields.entries) {
      if (fields.has(fieldName)) continue;
      if (fieldOmission(declaration, isGroupMember(body.groups, fieldName)) === 'MISSING') {
        throw new TsonReadError({
          code: 'FIELD_REQUIRED',
          message: `${at(path)}'${name}' requires the field '${fieldName}'`,
        });
      }
    }
    for (const group of body.groups) {
      const [refusal] = groupRefusals(group, (member) => fields.has(member), name);
      if (refusal !== undefined) {
        throw new TsonReadError({ code: 'FIELD_GROUP', message: `${at(path)}${refusal.message}` });
      }
    }
    return { form: 'record', ...(name === declared ? {} : { type: name }), fields };
  }

  /**
   * The member of the family `base` an untagged value is placed at by its pins (§5.2): the one record IS-A `base`,
   * with instances of its own, whose pin on every selector is the value's written one. Its candidates are the
   * members the closure records and the declarations of the schema being resolved that may join the family, each
   * made ready as the read reaches it -- a value placed by its pins waits on each declaration that may be its member
   * (§3.4.1).
   */
  private placedByPins(
    value: DataValue,
    base: string,
    body: RecordBody,
    path: readonly string[],
  ): { readonly name: string; readonly body: RecordBody } {
    const core = value.coreValue;
    const selectors = body.discriminators ?? [];
    const pins = new Map<string, string>();
    for (const field of core.kind === 'record' ? core.fields : []) {
      const token = field.value.coreValue;
      if (selectors.includes(field.name) && token.kind === 'token')
        pins.set(field.name, token.text);
    }
    const missing = selectors.find((selector) => !pins.has(selector));
    if (missing !== undefined) {
      throw new TsonReadError({
        code: 'FIELD_REQUIRED',
        message:
          `${at(path)}'${base}' places a value at its member by the pin on '${missing}', and the value writes ` +
          'no token there (§5.2)',
      });
    }
    const candidates = new Set([...subtypesOf(body), ...(this.joiners?.(base, pins) ?? [])]);
    const members: string[] = [];
    const placed: { name: string; body: RecordBody }[] = [];
    for (const candidate of candidates) {
      const name = terminal(candidate, this.meta);
      const member = this.meta(name);
      if (member?.kind !== 'record' || member.extension === 'ABSTRACT') continue;
      if (name !== base && !supertypesOf(member).includes(base)) continue;
      members.push(name);
      const pinned = selectors.every((selector) => {
        const field = member.fields.entries.get(selector);
        return field?.role === 'FIXED' && field.value?.text === pins.get(selector);
      });
      if (pinned && !placed.some((found) => found.name === name))
        placed.push({ name, body: member });
    }
    const [only] = placed;
    if (placed.length === 1 && only !== undefined) return only;
    const stated = selectors
      .map((selector) => `${selector}: ${pins.get(selector) ?? ''}`)
      .join(', ');
    throw new TsonReadError({
      code: 'TYPE_MISMATCH',
      message:
        placed.length === 0
          ? `${at(path)}no member of '${base}' pins ${stated}, the value this record states -- ` +
            `expected one of (${[...new Set(members)].join(', ')}) (§5.2)`
          : `${at(path)}${placed.map((found) => `'${found.name}'`).join(' and ')} each pin ${stated}, so ` +
            `the value places at no one member of '${base}' (§5.2)`,
    });
  }

  /**
   * The held dependent value `held` with what its sibling holds in this instance: the sibling's pin wherever
   * it is written, the value this record writes, or its default. A sibling a field group's member leaves
   * absent types nothing, and the value written without it is refused (§5.2, §5.11).
   *
   * @throws TsonReadError where the sibling is a group member the record does not write.
   */
  private typed(
    name: string,
    body: RecordBody,
    fields: ReadonlyMap<string, MetaValue>,
    held: MetaHeldValue,
  ): MetaValue {
    const { sibling, declared } = held;
    const written = fields.get(sibling);
    const omission = fieldOmission(declared, isGroupMember(body.groups, sibling));
    if (written === undefined && omission === 'ABSENT') {
      const refusal = writtenWithoutItsSibling(name, held.field, sibling);
      throw new TsonReadError({ code: refusal.code, message: refusal.message });
    }
    let text: string | undefined;
    if (declared.role === 'FIXED') text = declared.value?.text;
    else if (written !== undefined) text = metaText(written);
    else if (omission === 'INJECTED') text = declared.value?.text;
    const named = referenceIn(text);
    return named === undefined ? { ...held } : { ...held, named };
  }

  private list(
    value: DataValue,
    name: string,
    body: ArrayBody,
    path: readonly string[],
  ): MetaValue {
    const core = value.coreValue;
    if (core.kind !== 'array') {
      throw mismatch(path, `a list of '${this.named(body.elementType)}'`, core);
    }
    const count = BigInt(core.elements.length);
    if (
      (body.minItems !== undefined && count < body.minItems) ||
      (body.maxItems !== undefined && count > body.maxItems)
    ) {
      throw new TsonReadError({
        code: 'ATOM_CONSTRAINT_VIOLATION',
        message: `${at(path)}'${name}' holds ${String(count)} elements, outside its bounds`,
      });
    }
    const elements = core.elements.map((element, index) =>
      element.coreValue.kind === 'void' && body.voidable
        ? ({ form: 'void' } as const)
        : this.value(element, body.elementType, [...path, String(index)]),
    );
    // A unique array of names is a scope of them (§8.2), as an identifier-keyed map's keys are.
    const family = body.uniqueItems ? this.identifierFamily(body.elementType) : undefined;
    if (family !== undefined) {
      this.judgeNames(
        elements.flatMap((element) => (element.form === 'token' ? [element.token.text] : [])),
        family,
        path,
      );
    }
    return { form: 'list', elements };
  }

  private map(value: DataValue, name: string, body: MapBody, path: readonly string[]): MetaValue {
    const core = value.coreValue;
    if (core.kind !== 'map' && core.kind !== 'empty-brace') {
      throw mismatch(
        path,
        `a map of '${body.keyType.name}' to '${this.named(body.valueType)}'`,
        core,
      );
    }
    const entries: (readonly [MetaValue, MetaValue])[] = [];
    const seen = new Set<string>();
    for (const entry of core.kind === 'map' ? core.entries : []) {
      const key = this.value(entry.key, body.keyType, path);
      const text = key.form === 'token' ? key.token.text : undefined;
      if (text !== undefined) {
        if (seen.has(text)) {
          throw new TsonReadError({
            code: 'DUPLICATE_MAP_KEY',
            message: `${at(path)}'${name}' holds the key '${text}' twice`,
          });
        }
        seen.add(text);
      }
      const written = entry.value;
      const read =
        written.coreValue.kind === 'void' && body.voidable
          ? ({ form: 'void' } as const)
          : this.value(written, body.valueType, [...path, text ?? String(entries.length)]);
      entries.push([key, read]);
    }
    const keyFamily = this.identifierFamily(body.keyType);
    if (keyFamily !== undefined) this.judgeNames([...seen], keyFamily, path);
    return { form: 'map', entries };
  }

  private tuple(
    value: DataValue,
    name: string,
    body: TupleBody,
    path: readonly string[],
  ): MetaValue {
    const core = value.coreValue;
    if (core.kind !== 'array' || core.elements.length !== body.elements.length) {
      throw mismatch(path, `a '${name}' tuple of ${String(body.elements.length)} elements`, core);
    }
    const elements = core.elements.map((element, index) => {
      const declared = body.elements[index];
      if (declared === undefined) throw mismatch(path, `a '${name}' tuple`, core);
      return element.coreValue.kind === 'void' && declared.voidable
        ? ({ form: 'void' } as const)
        : this.value(element, declared.elementType, [...path, String(index)]);
    });
    return { form: 'list', elements };
  }

  /** A choice: the variant a tag names, or the first variant the value reads as (§5.4). */
  private choice(
    value: DataValue,
    name: string,
    body: ChoiceBody,
    path: readonly string[],
  ): MetaValue {
    if (value.typeRef !== undefined) {
      const tag = this.resolved(value.typeRef);
      for (const variant of body.variants) {
        if (variant.kind === 'inline') continue; // a type written in place is named by no tag (§4.2)
        const resolved = this.resolved(variant);
        if (tag.name === resolved.name || supertypesOf(tag.body).includes(resolved.name)) {
          return this.value(value, variant, path);
        }
      }
      throw new TsonReadError({
        code: 'TYPE_MISMATCH',
        message: `${at(path)}the tag '!${value.typeRef}' names no variant of '${name}'`,
      });
    }
    for (const variant of body.variants) {
      try {
        return this.value(value, variant, path);
      } catch (error) {
        if (!(error instanceof TsonReadError)) throw error;
      }
    }
    throw mismatch(path, `a value of one of '${name}'’s variants`, value.coreValue);
  }
}

/**
 * A dependent field's value held as written (§5.2), whatever its form: a token, a reference, a record, a
 * list, a map, an annotated or tagged value. `sibling` types it, `declared` being the sibling's declaration;
 * what the sibling holds is settled once the record's fields are read ({@link ValueBodyReader.typed}).
 */
function heldAsWritten(
  value: DataValue,
  field: string,
  sibling: string,
  declared: RecordField,
): MetaValue {
  return { form: 'held', value: heldView(value), written: value, field, sibling, declared };
}

/** The generic tree a held value is, which a qualified name selects in. */
function heldView(value: DataValue): MetaValue {
  const core = value.coreValue;
  switch (core.kind) {
    case 'token':
      return tokenOf(core);
    case 'void':
      return { form: 'void' };
    case 'array':
      return { form: 'list', elements: core.elements.map(heldView) };
    case 'map':
      return {
        form: 'map',
        entries: core.entries.map((entry) => [heldView(entry.key), heldView(entry.value)] as const),
      };
    case 'record':
      return {
        form: 'record',
        ...(value.typeRef === undefined ? {} : { type: value.typeRef }),
        fields: new Map(core.fields.map((field) => [field.name, heldView(field.value)] as const)),
      };
    case 'empty-brace':
      return {
        form: 'record',
        ...(value.typeRef === undefined ? {} : { type: value.typeRef }),
        fields: new Map(),
      };
  }
}

/** The text a name value spells, `undefined` for any other form. */
function metaText(value: MetaValue): string | undefined {
  return value.form === 'token' ? value.token.text : undefined;
}

/** A token at a slot whose atom takes any token, kept as written. */
function tokenOf(core: TokenValue): MetaValue {
  return { form: 'token', token: { text: core.text, form: metaFormOfLexer(core.form) } };
}

/**
 * A value of a meta layer's vocabulary carries no framing of its own beyond a record's tag: there
 * is nowhere in the value to keep an annotation, and a tag names a record's member.
 */
function refuseFraming(value: DataValue, path: readonly string[], type: string): void {
  refuseAnnotations(value, path, type);
  if (value.typeRef !== undefined && value.typeRef !== type) {
    throw new TsonReadError({
      code: 'TYPE_MISMATCH',
      message: `${at(path)}the tag '!${value.typeRef}' is no tag a value of '${type}' takes here`,
    });
  }
}

function refuseAnnotations(value: DataValue, path: readonly string[], type: string): void {
  const [first] = value.annotations;
  if (first === undefined) return;
  throw new TsonReadError({
    code: 'TYPE_MISMATCH',
    message:
      `${at(path)}a value of '${type}' carries the annotation '@${first.name}', which a meta ` +
      "layer's value has nowhere to keep -- annotate the key it is held under",
  });
}

function annotationOf(annotation: WrittenAnnotation): Annotation {
  return annotation.value === undefined
    ? { name: annotation.name }
    : { name: annotation.name, value: annotation.value };
}

function mismatch(path: readonly string[], wanted: string, core: CoreValue): TsonReadError {
  return new TsonReadError({
    code: 'TYPE_MISMATCH' satisfies DiagnosticCode,
    message: `${at(path)}expected ${wanted}, found ${describe(core)}`,
  });
}

function describe(core: CoreValue): string {
  switch (core.kind) {
    case 'record':
      return 'a record';
    case 'map':
      return 'a map';
    case 'array':
      return 'a list';
    case 'empty-brace':
      return '{}';
    case 'void':
      return "the void sentinel '_'";
    case 'token':
      return `the token '${core.text}'`;
  }
}

/** Where in the payload a refusal sits, as an RFC 6901 pointer opening its message. */
function at(path: readonly string[]): string {
  if (path.length === 0) return '';
  return `at /${path.map((step) => step.replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}: `;
}

/** A value's qualified name, read by its grammar alone: its text in NFC, split at `.`, the first segment a name (§5.12). */
const VALUE_NAME = {
  read: (token: { readonly text: string }): string => parseReference(token.text),
};
