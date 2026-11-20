/**
 * The names a value entry holds -- a {@link Namespace} of a meta layer's own vocabulary -- resolved
 * and judged by the slots they were read at (Part 2 §4.2, §5.12): a type's name at a slot typed by
 * a kind, judged a member of the kind; a value's qualified name at a slot typed `ref<T>`, judged a
 * value IS-A `T`; and a `type_ref` slot's application, judged by resolution and arity.
 *
 * **Fed by the read, not by a walk through the meta's declarations.** Each name was kept with its
 * slot (`schema/meta`'s `NameSlot`) by the read that produced it (`schema/namespaceReader.ts`), so
 * the slot's declared type arrives with the name however deep the value sits -- under a key, behind
 * a record field, through the member a tag selected.
 *
 * **Two layers meet here.** The slot's type is the meta layer's to declare, in the governing meta's
 * namespace (the structure namespace). The name is the governed schema's to resolve: its first
 * segment through this schema's own entries and imports, alias hops followed (§8.3), never through
 * the meta's namespace (§3.3.2); each further segment selects in the value reached -- a key of a
 * namespace value, a field of a record value, never a position in a list nor a key of a map that
 * is no namespace -- and a type entry admits none. A parametric record is no referent: it denotes no type until
 * it is applied (§5.10). Found first, judged after, never a choice among candidates.
 *
 * **An entry's declared type is the constructor that built its body**: its tag, as its facts
 * record it, where that names a constructor of the governing meta, and otherwise the kernel
 * constructor its body is the shape of (`record` for a record declaration or a composition). A
 * key's declared type is its namespace's `value_type`, a field's its declared type. The referent's
 * declared type is judged against the slot's by §7.2's IS-A. A field the record declares and the
 * value does not hold is refused as not present, after the type is judged, so a name wrong by type
 * is told so whatever the value holds.
 *
 * **Local entries only**: an imported entry's names were judged when its own schema linked, in its
 * own namespace. Every refusal is a {@link TsonSchemaValidationError} naming the step that failed;
 * a spelling this library does not yet follow (a type reached through a namespace of types) is a
 * {@link TsonNotImplementedError}.
 */
import type { DiagnosticsReceiver } from '../core/diagnostic.js';
import {
  TsonAtomParseError,
  TsonAtomValidationError,
  TsonInternalError,
  TsonNotImplementedError,
  TsonSchemaValidationError,
} from '../core/errors.js';
import { createIdentifierParser } from '../atom/text/identifier.js';
import { TYPE_NAME_GRAMMAR } from '../atom/reference.js';
import { parseReference } from '../atom/referenceGrammar.js';
import type { AtomType } from '../atom/contract.js';
import type { Normalization } from '../schema/meta/atoms-text.js';
import { applyNormalization } from '../unicode/normalization.js';
import { DEFAULT_NAME_TYPE } from '../schema/meta/kernel.js';
import type { EntryFacts, MetaValue, NameSlot, Top, TypeRef } from '../schema/meta/typedef.js';
import {
  typeExprText,
  typeNameOf,
  type RecordBody,
  type RecordField,
} from '../schema/meta/bodies.js';
import {
  constructorOf,
  isConstructor,
  dependentOn,
  isParametric,
  nameOf,
  supertypesOf,
  typeParameters,
} from '../schema/meta/typedef.js';
import { isNamespaceType, namespaceMapOf } from '../schema/meta/namespaces.js';
import { isNestedMap } from '../schema/meta/schemaPaths.js';
import { isValueEntry } from '../schema/meta/typedef.js';
import { schemaPositionOf, spellingOf } from './facts.js';
import { isKindMember, namesTypes } from './kindMembers.js';
import { terminal, terminalDefinition, type EntryLookup } from './aliasChain.js';
import { referenceIn, siblingType, typeNamed, type TypeNamed } from './dependentFields.js';

/** Dependencies {@link checkValuesByName} needs beyond the merged namespace. */
export interface ValuesByNameOptions {
  readonly schemaId: string;
  readonly facts: ReadonlyMap<string, EntryFacts>;
  /** The schema's one namespace, where every slot's declared type is named. */
  readonly structureNamespace: ReadonlyMap<string, Top>;
  /** The entry facts of that namespace, where a slot type's applied constructor is recorded (§8.1). */
  readonly structureFacts?: ReadonlyMap<string, EntryFacts>;
  readonly receiver?: DiagnosticsReceiver;
}

/** One name a value holds, where it sits, and the slot it fills. */
interface HeldName {
  readonly name: string;
  readonly path: readonly string[];
  readonly slot: NameSlot;
  /** Whether the name heads an application, `box<text>`, judged as one (§5.10). */
  readonly application?: true;
}

/** Whether `value` is a value entry, which no type is and nothing is typed by (§4.1). */
function isNamespaceValue(value: Top): boolean {
  return isValueEntry(value);
}

/**
 * Judges every name each local namespace entry of `merged` holds, reporting each refusal against
 * the entry holding it -- or throwing the first, where no receiver is given.
 */
export function checkValuesByName(
  merged: ReadonlyMap<string, Top>,
  localNames: ReadonlySet<string>,
  options: ValuesByNameOptions,
): void {
  const judge = new ValuesByName(merged, options);
  for (const entry of localNames) {
    const value = merged.get(entry);
    if (value === undefined || !isNamespaceValue(value)) continue;
    for (const held of namesIn(value)) {
      const where = `'${entry}' at ${pointer(held.path)}`;
      try {
        judge.judge(where, held);
      } catch (error) {
        if (
          options.receiver === undefined ||
          !(error instanceof TsonSchemaValidationError || error instanceof TsonNotImplementedError)
        ) {
          throw error;
        }
        options.receiver.report({
          code: error instanceof TsonNotImplementedError ? 'NOT_IMPLEMENTED' : 'SCHEMA_ERROR',
          message: error.message,
          schemaId: options.schemaId,
          schemaPointer: `/${entry}`,
          ...schemaPositionOf(options.facts, entry),
        });
      }
    }
  }
}

/** Every name `value` holds at a kind-, reference- or `type_ref`-typed slot, with its path. */
function namesIn(entry: Top): readonly HeldName[] {
  if (!isValueEntry(entry) || entry.value.form === 'schema_map') return [];
  const found: HeldName[] = [];
  const walk = (meta: MetaValue, path: readonly string[]): void => {
    switch (meta.form) {
      case 'token':
        if (meta.slot !== undefined) found.push({ name: meta.token.text, path, slot: meta.slot });
        return;
      case 'schema_map':
      case 'void':
        return;
      case 'held':
        // A dependent field's value is judged against the type its sibling names (`HeldValues`), whose
        // reader judges every name it holds.
        return;
      case 'list':
        meta.elements.forEach((element, index) => {
          walk(element, [...path, String(index)]);
        });
        return;
      case 'map':
        meta.entries.forEach(([key, entry], index) => {
          walk(entry, [...path, key.form === 'token' ? key.token.text : String(index)]);
        });
        return;
      case 'record':
        for (const [name, field] of meta.fields) walk(field, [...path, name]);
        return;
      case 'namespace':
        for (const [key, entry] of meta.value.entries) walk(entry, [...path, key]);
        return;
    }
  };
  walk(entry.value, []);
  return found;
}

/**
 * The walk that judges a name, over one namespace. {@link checkValuesByName} runs it over the names a value
 * entry holds; {@link ValuesByName.reach} runs it for a field's default or pin at a reference and for a name
 * a data document writes at one (the lookup a linked reference over a type that is no constructor holds),
 * so a name is judged by one rule wherever it is written.
 */
export class ValuesByName {
  private readonly local: EntryLookup;
  private readonly structure: EntryLookup;

  constructor(
    private readonly merged: ReadonlyMap<string, Top>,
    private readonly options: ValuesByNameOptions,
  ) {
    this.local = (name) => merged.get(name);
    this.structure = this.local;
  }

  /** A slot's declared type as the meta's author wrote it (`kind<record>`, `link/facts.ts`). */
  private slotSpelling(type: string): string {
    return spellingOf(type, this.structure(type), this.options.structureFacts);
  }

  judge(where: string, held: HeldName): unknown {
    if (held.application === true) {
      this.judgeApplication(where, held.name);
      return undefined;
    }
    return this.judgeName(where, held.name, held.slot);
  }

  /**
   * The value `name` reaches at a slot typed by a reference over `of`, a type that is no constructor: a
   * field's `~`/`=` value, or a name a data document writes, judged as a value body's names are (§5.12).
   *
   * @throws TsonSchemaValidationError opening with `where`, naming the step that failed.
   */
  reach(where: string, name: string, of: string): unknown {
    return this.judgeName(where, name, { type: of, of, role: 'VALUE_NAME' });
  }

  /**
   * The segments of the qualified name `name`: its text, in NFC, split at each `.` before any family is consulted
   * (§5.12). Refused where it splits into none -- empty, an empty segment, or a first segment that is no
   * [TSON-DATA] §7.7 identifier; each further segment is judged as a name of the family it enters, by the walk.
   */
  private segments(where: string, name: string): readonly string[] {
    try {
      return parseReference(name).split('.');
    } catch (error) {
      if (!(error instanceof TsonAtomParseError)) throw error;
      throw new TsonSchemaValidationError(
        `${where} holds '${name}', which is no qualified name: ${error.message}`,
      );
    }
  }

  /** The family `typeName` states, or `fallback` where it reaches no identifier family (§5.12). */
  private family(typeName: string | undefined, fallback: Family): Family {
    if (typeName === undefined) return fallback;
    const end = terminal(typeName, this.local);
    const identifiers = this.local(end);
    if (identifiers?.kind !== 'identifier_type') return fallback;
    return family(typeName, createIdentifierParser(end, identifiers), identifiers.normalization);
  }

  /**
   * Judges one name by its slot, and returns the value it reaches, or `undefined` for a name at a slot
   * that names types. What the slot's `of` names decides which names it holds, judged here over the
   * final namespace whatever the read guessed: a constructor's values are types, and any other type's
   * values are values.
   */
  private judgeName(where: string, name: string, slot: NameSlot): unknown {
    const written = this.segments(where, name);
    const types = namesTypes(slot.of, this.local);
    let head = written[0] ?? name;
    if (!this.merged.has(head)) {
      throw new TsonSchemaValidationError(
        `${where} names '${name}', and '${head}' is no ` +
          (types && written.length === 1
            ? 'type declared in this schema or its imports'
            : 'entry of this schema or its imports -- the first segment names the entry a value is reached through, and a member is reached through its entry (§5.12)'),
      );
    }
    // A schema map nested as an entry is entered by its members' names: each is an entry under its path, so the
    // walk goes on from the member a segment names, and a further segment selects in that member's value.
    let entered = 1;
    while (entered < written.length && isNestedMap(this.merged.get(head))) {
      const member = `${head}.${TYPE_NAME_FAMILY.read(
        `${where} names '${name}'`,
        `which names the members of the schema map '${head}'`,
        written[entered] ?? '',
      )}`;
      if (!this.merged.has(member)) {
        throw new TsonSchemaValidationError(
          `${where} names '${name}', and the schema map '${head}' declares no '${written[entered] ?? ''}'`,
        );
      }
      head = member;
      entered += 1;
    }
    const segments = [head, ...written.slice(entered)];
    const end = terminal(head, this.local);
    const referent = this.merged.get(end);
    if (referent === undefined) {
      throw new TsonSchemaValidationError(
        `${where} names '${name}', and the alias '${head}' reaches no entry (§8.3)`,
      );
    }
    const entry = end === head ? `'${head}'` : `'${head}' (an alias of '${end}')`;
    if (isParametric(referent) || referent.kind === 'incomplete') {
      throw new TsonSchemaValidationError(
        referent.kind === 'incomplete'
          ? `${where} names '${name}', and ${entry} is an incomplete entry, which is no type and no value (§5.5), so nothing is there to name`
          : `${where} names '${name}', and ${entry} is a parametric record, which denotes no type until it is applied (§5.10), so nothing is there to name`,
      );
    }
    if (types) {
      this.judgeMember(where, name, segments, slot, end, referent, entry);
      return undefined;
    }
    return this.judgeReference(where, name, segments, slot, end, referent, entry);
  }

  /**
   * A slot over a constructor holds a type's name, its path from the root -- one segment once a schema map
   * nested as an entry has been entered by its members' names -- a member of the kind (§4.2): an entry whose
   * value is of the kind's `of`. A value entry is refused as a value, however many segments name it, and a type
   * admits no further segment.
   */
  private judgeMember(
    where: string,
    name: string,
    segments: readonly string[],
    slot: NameSlot,
    end: string,
    referent: Top,
    entry: string,
  ): void {
    const kind = this.slotSpelling(slot.type);
    const wants = `${where} wants the name of a type whose value is of '${slot.of}' (a member of '${kind}'), and `;
    if (segments.length > 1 && isNamespaceValue(referent)) {
      throw new TsonSchemaValidationError(
        `${wants}'${name}' reaches into ${entry}, which is ${aValueNoType(referent)} -- and what a further segment selects in a value is a value too`,
      );
    }
    if (segments.length > 1) {
      throw new TsonSchemaValidationError(
        `${wants}'${name}' goes on past ${entry}, a type, which admits no further segment`,
      );
    }
    if (isKindMember(name, slot.of, this.local, (n) => this.headOf(n))) return;
    if (isNamespaceValue(referent)) {
      throw new TsonSchemaValidationError(`${wants}${entry} is ${aValueNoType(referent)}`);
    }
    throw new TsonSchemaValidationError(
      `${wants}${entry} is an entry whose body is built by '${this.constructorOfEntry(end, referent)}', which is no '${slot.of}' (§4.2)`,
    );
  }

  /** A reference-typed slot holds a value's qualified name, and the value reached IS-A the slot's `of` (§5.12). */
  private judgeReference(
    where: string,
    name: string,
    segments: readonly string[],
    slot: NameSlot,
    end: string,
    referent: Top,
    entry: string,
  ): unknown {
    const wanted = slot.of;
    let at = this.constructorOfEntry(end, referent);
    if (segments.length === 1) {
      if (!this.isA(at, wanted)) {
        throw new TsonSchemaValidationError(
          `${where} wants ${a(wanted)} value, and ${entry} is an entry whose body is built by '${at}', which is no '${wanted}' (§5.12)`,
        );
      }
      return isValueEntry(referent) ? referent.value : referent;
    }
    if (!isNamespaceValue(referent)) {
      throw new TsonSchemaValidationError(
        `${where} names '${name}', and ${entry} is a type: a type entry admits no further segment, so '${segments[1] ?? ''}' selects in no value (§5.12)`,
      );
    }
    let value: MetaValue | undefined = isValueEntry(referent) ? referent.value : undefined;
    let absent: string | undefined;
    let reached = segments[0] ?? name;
    // The type the walk stands in where it is written in place, which has no entry to look up by name (§4.2).
    let inPlace: Top | undefined;
    for (const segment of segments.slice(1)) {
      // A dependent field's value is held as written; a segment selects in the tree it is.
      value = value?.form === 'held' ? value.value : value;
      const body = inPlace ?? this.structure(terminal(at, this.structure));
      inPlace = undefined;
      const namespaceType = body !== undefined && isNamespaceType(body) ? body : undefined;
      if (namespaceType !== undefined) {
        const map = namespaceMapOf(namespaceType);
        const keys = this.family(
          namespaceType.keyType.name,
          family(namespaceType.keyType.name, IDENTIFIER_READER, 'NFC'),
        );
        const key = keys.read(
          `${where} names '${name}'`,
          `which names the keys of '${reached}'`,
          segment,
        );
        if (value !== undefined) {
          const entries = entriesOf(value);
          const found = entries === undefined ? undefined : keyed(entries, keys, key);
          if (found === undefined) {
            const keys = entries === undefined ? [] : [...entries.keys()];
            throw new TsonSchemaValidationError(
              `${where} names '${name}', and '${reached}' has no key '${segment}' -- it holds ${keys.length === 0 ? 'none' : keys.join(', ')}`,
            );
          }
          value = found;
        }
        at = nameOf(map.valueType) ?? typeExprText(map.valueType);
        if (map.valueType.kind === 'inline') inPlace = map.valueType.of;
      } else if (body?.kind === 'record') {
        const names = this.family(body.nameType, DEFAULT_NAME_FAMILY);
        const declared = declaredField(
          body,
          names,
          names.read(`${where} names '${name}'`, `which names the fields of '${reached}'`, segment),
        );
        const field = declared === undefined ? undefined : body.fields.entries.get(declared);
        if (field === undefined || declared === undefined) {
          throw new TsonSchemaValidationError(
            `${where} names '${name}', and '${reached}' is ${a(at)}, which has no field '${segment}' -- it declares ${[...body.fields.entries.keys()].join(', ') || 'none'}`,
          );
        }
        const holder = value;
        if (value !== undefined) {
          const held: MetaValue | undefined =
            value.form === 'record' ? value.fields.get(declared) : undefined;
          if (held === undefined && absent === undefined) {
            absent = `'${reached}' is ${a(at)} whose field '${declared}' is not present in the value`;
          }
          value = held;
        }
        const sibling = dependentOn(field.type);
        if (sibling !== undefined) {
          const naming =
            `${where} names '${name}', and '${reached}.${segment}' is a dependent field, typed by ` +
            `its sibling '${sibling}'`;
          const unreached =
            absent === undefined
              ? undefined
              : `${where} names '${name}', and ${absent}, so the name reaches no value`;
          at = this.dependentType(naming, body, sibling, holder, unreached);
        } else {
          at = typeNameOf(field);
          if (field.type.kind === 'inline') inPlace = field.type.of;
        }
      } else if (body?.kind === 'map') {
        throw new TsonSchemaValidationError(
          `${where} names '${name}', and '${reached}' is ${a(at)}, a map that is no namespace, so it is not entered by name -- a segment selects a key of a namespace value or a field of a record value (§5.12)`,
        );
      } else if (body?.kind === 'array') {
        throw new TsonSchemaValidationError(
          `${where} names '${name}', and '${reached}' is a list, whose elements have no names -- a segment selects a field of a record or a key of a map, never a position (§5.12)`,
        );
      } else {
        throw new TsonSchemaValidationError(
          `${where} names '${name}', and '${reached}' is ${a(at)}, which has no member selected by name -- a segment selects a field of a record or a key of a namespace value (§5.12)`,
        );
      }
      reached = `${reached}.${segment}`;
    }
    if (!this.isA(at, wanted)) {
      throw new TsonSchemaValidationError(
        `${where} wants ${a(wanted)} value, and '${name}' is ${a(at)}, which is no '${wanted}' (§5.12, §7.2)`,
      );
    }
    if (absent !== undefined) {
      throw new TsonSchemaValidationError(
        `${where} names '${name}', and ${absent}, so the name reaches no value`,
      );
    }
    return value;
  }

  /**
   * The type a dependent field of `record` has in the value `holder`: the one its sibling `sibling` names
   * there (§5.2), by the read path's rules. The sibling's value is its pin wherever it is written, and
   * otherwise the value `holder` holds, or its default where it holds none. Refused, opening with `naming`,
   * where the sibling holds nothing or names no type a value can be read against; `holder` is `undefined`
   * where an earlier segment reached no value, and a sibling with no pin or default then has no type to go
   * on with, so the name is refused as reaching no value, in `unreached`'s words.
   */
  private dependentType(
    naming: string,
    record: RecordBody,
    sibling: string,
    holder: MetaValue | undefined,
    unreached: string | undefined,
  ): string {
    const declared = record.fields.entries.get(sibling);
    if (declared === undefined) {
      throw new TsonInternalError(
        `${naming}, which the record does not declare; the linker refuses one`,
      );
    }
    let held: string | undefined;
    if (declared.role === 'FIXED') {
      held = declared.value?.text;
    } else if (holder?.form === 'record') {
      const written = holder.fields.get(sibling);
      held = written === undefined ? undefined : metaText(written);
    }
    if (held === undefined && declared.role === 'DEFAULT') held = declared.value?.text;
    if (held === undefined && holder === undefined) {
      throw new TsonSchemaValidationError(unreached ?? naming);
    }
    const named = referenceIn(held);
    if (named === undefined) {
      throw new TsonSchemaValidationError(
        `${naming}, which the value does not hold, so the name has no type to go on through`,
      );
    }
    const typed = typeNamedIn(named, declared, this.merged);
    if (typed.kind === 'none') {
      throw new TsonSchemaValidationError(
        `${naming}, which holds ${typed.held} -- so the name has no type to go on through`,
      );
    }
    return typed.name;
  }

  /** A `type_ref` slot of a value body: a name that resolves, with as many arguments as the entry declares parameters, and never a value (§4.1). */
  private judgeApplication(where: string, name: string): void {
    const end = terminal(name, this.local);
    const referent = this.merged.get(end);
    if (referent === undefined) {
      throw new TsonSchemaValidationError(
        `${where} names '${name}', which is no type declared in this schema or its imports`,
      );
    }
    if (isNamespaceValue(referent)) {
      throw new TsonSchemaValidationError(
        `${where} names '${name}', which is ${aValueNoType(referent)}`,
      );
    }
    const parameters = typeParameters(referent).length;
    if (parameters !== 0) {
      throw new TsonSchemaValidationError(
        `${where} applies '${name}' to 0 arguments, and it declares ${String(parameters)} parameter${parameters === 1 ? '' : 's'}`,
      );
    }
  }

  /** The constructor an entry's facts record it applying, where any is recorded. */
  private headOf(name: string): string | undefined {
    return this.options.facts.get(name)?.head;
  }

  /**
   * The constructor that built `definition`'s body: its tag where that names a constructor of the
   * governing meta, and otherwise the kernel constructor its body is the shape of.
   */
  private constructorOfEntry(name: string, definition: Top): string {
    const tag = this.headOf(name);
    if (tag !== undefined) {
      const end = terminal(tag, this.structure);
      const constructor = this.structure(end);
      if (constructor !== undefined && isConstructor(constructor, end)) return end;
    }
    return constructorOf(definition);
  }

  /** §7.2: the type `type` is `wanted`, or lists it among its supertypes, both in the governing meta's namespace. */
  private isA(type: string, wanted: string): boolean {
    const end = terminal(type, this.structure);
    const target = terminal(wanted, this.structure);
    if (end === target) return true;
    return supertypesOf(this.structure(end)).some(
      (supertype) => terminal(supertype, this.structure) === target,
    );
  }
}

/**
 * What a sibling declared `sibling` and holding `named` types its dependent field by in the namespace
 * `merged`: the read path's rule (`typeNamed`), the sibling's reference resolving an application, and a
 * value entry naming no type either.
 */
export function typeNamedIn(
  named: TypeRef,
  sibling: RecordField,
  merged: ReadonlyMap<string, Top>,
): TypeNamed {
  const lookup: EntryLookup = (name) => merged.get(name);
  const typed = typeNamed(named, siblingType(sibling, lookup), lookup);
  if (typed.kind === 'entry') {
    const body = terminalDefinition(typed.name, lookup);
    if (body !== undefined && isValueEntry(body)) {
      return { kind: 'none', held: `'${named.name}', ${aValueNoType(body)}` };
    }
  }
  return typed;
}

/**
 * The family a segment is a name of where it enters a container (§5.12): its name, as a message says it, the reader
 * a document's own key or field name there is read by, and the form two names are one in.
 */
interface Family {
  /** `segment` as a name of this family, in its form; refused, opening with `naming`, where it is none. */
  read(naming: string, role: string, segment: string): string;
  /** Whether `key`, as declared or as a value holds it, is the name `read`. */
  names(read: string, key: string): boolean;
}

function family(name: string, reader: AtomType<unknown>, form: Normalization): Family {
  return {
    read(naming, role, segment): string {
      try {
        const value = reader.read({ text: segment, form: 'unquoted' });
        return typeof value === 'string' ? value : segment;
      } catch (error) {
        if (!(error instanceof TsonAtomParseError || error instanceof TsonAtomValidationError)) {
          throw error;
        }
        throw new TsonSchemaValidationError(
          `${naming}, and '${segment}' is no name of '${name}', ${role} -- ${error.message}`,
        );
      }
    },
    names: (read, key) => read === applyNormalization(form, key),
  };
}

/** The reader of the series' identifier (§7.7), what the kernel's `type_name` and `meta.identifier` read. */
const IDENTIFIER_READER: AtomType<string> = createIdentifierParser(
  'meta.identifier',
  TYPE_NAME_GRAMMAR,
);

/** A schema map's members and the root are named by `meta.type_name` (§5.12). */
const TYPE_NAME_FAMILY: Family = family('meta.type_name', IDENTIFIER_READER, 'NFC');

/** A record stating no name type names its fields with `meta.identifier` (§5.2). */
const DEFAULT_NAME_FAMILY: Family = family(DEFAULT_NAME_TYPE, IDENTIFIER_READER, 'NFC');

/** The field of `record` whose declared name is `read` under `names`, or `undefined` for none. */
function declaredField(record: RecordBody, names: Family, read: string): string | undefined {
  if (record.fields.entries.has(read)) return read;
  for (const declared of record.fields.entries.keys()) {
    if (names.names(read, declared)) return declared;
  }
  return undefined;
}

/** The value under the key that is `key` under `keys`. */
function keyed(
  entries: ReadonlyMap<string, MetaValue>,
  keys: Family,
  key: string,
): MetaValue | undefined {
  const exact = entries.get(key);
  if (exact !== undefined) return exact;
  for (const [held, entry] of entries) {
    if (keys.names(key, held)) return entry;
  }
  return undefined;
}

/** The text a name value spells, `undefined` for any other form. */
function metaText(value: MetaValue): string | undefined {
  return value.form === 'token' ? value.token.text : undefined;
}

/** The map a value of a namespace type holds, by key. */
function entriesOf(value: MetaValue): ReadonlyMap<string, MetaValue> | undefined {
  if (value.form === 'held') return entriesOf(value.value);
  if (value.form === 'namespace') return value.value.entries;
  if (value.form === 'map') {
    const entries = new Map<string, MetaValue>();
    for (const [key, entry] of value.entries) {
      if (key.form === 'token') entries.set(key.token.text, entry);
    }
    return entries;
  }
  return undefined;
}

/** What a namespace entry is, where a type is wanted: a value, which nothing can be typed by (§4.1). */
function aValueNoType(entry: Top): string {
  const type = isValueEntry(entry) ? entry.type : 'a type';
  return `a value of the type '${type}' -- a value and not a type, so nothing can be typed by it (§4.1)`;
}

/** A type named with its article, as a message says it: `a 'method'`, `an 'interface'`. */
function a(typeName: string): string {
  return `${'aeiou'.includes(typeName.charAt(0)) ? 'an' : 'a'} '${typeName}'`;
}

/** A slot as an RFC 6901 pointer into the body. */
function pointer(steps: readonly string[]): string {
  return steps.map((step) => `/${step.replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');
}
