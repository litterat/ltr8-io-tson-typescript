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
 * is no namespace -- and a type entry admits none. An open entry is no referent: a template denotes
 * no value until it is applied (§5.10). Found first, judged after, never a choice among candidates.
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
import { TsonNotImplementedError, TsonSchemaValidationError } from '../core/errors.js';
import type { EntryFacts, MetaValue, Namespace, NameSlot, Top } from '../schema/meta/typedef.js';
import {
  constructorOf,
  isConstructor,
  isNamespaceValue,
  isOpen,
  isTemplateBody,
  supertypesOf,
  typeParameters,
} from '../schema/meta/typedef.js';
import { isNamespaceType, namespaceMapOf } from '../schema/meta/namespaces.js';
import { schemaPositionOf, spellingOf } from './facts.js';
import { isKindMember } from './kindMembers.js';
import { terminal, type EntryLookup } from './referenceChain.js';

/** Dependencies {@link checkValuesByName} needs beyond the merged namespace. */
export interface ValuesByNameOptions {
  readonly schemaId: string;
  readonly facts: ReadonlyMap<string, EntryFacts>;
  /** The governing meta's namespace, where every slot's declared type is named. */
  readonly structureNamespace: ReadonlyMap<string, Top>;
  /** The governing meta's entry facts, so a slot type it minted is named as its author wrote it. */
  readonly structureFacts?: ReadonlyMap<string, EntryFacts>;
  readonly receiver?: DiagnosticsReceiver;
}

/** One name a value holds, where it sits, and the slot it fills. */
interface HeldName {
  readonly name: string;
  readonly path: readonly string[];
  readonly slot: NameSlot;
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
  const judge = new Judge(merged, options);
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
function namesIn(value: Namespace<MetaValue>): readonly HeldName[] {
  const found: HeldName[] = [];
  const walk = (meta: MetaValue, path: readonly string[]): void => {
    switch (meta.form) {
      case 'token':
        if (meta.slot !== undefined) found.push({ name: meta.token.text, path, slot: meta.slot });
        return;
      case 'void':
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
  for (const [key, entry] of value.entries) walk(entry, [key]);
  return found;
}

class Judge {
  private readonly local: EntryLookup;
  private readonly structure: EntryLookup;

  constructor(
    private readonly merged: ReadonlyMap<string, Top>,
    private readonly options: ValuesByNameOptions,
  ) {
    this.local = (name) => merged.get(name);
    this.structure = (name) => options.structureNamespace.get(name);
  }

  /** A slot's declared type as the meta's author wrote it (`kind<record>`, `link/facts.ts`). */
  private slotSpelling(type: string): string {
    return spellingOf(type, this.structure(type), this.options.structureFacts);
  }

  judge(where: string, held: HeldName): void {
    const { name, slot } = held;
    if (slot.role === 'application') {
      this.judgeApplication(where, name);
      return;
    }
    const segments = name.split('.');
    const head = segments[0] ?? name;
    if (!this.merged.has(head)) {
      throw new TsonSchemaValidationError(
        `${where} names '${name}', and '${head}' is no ` +
          (slot.role === 'kind' && segments.length === 1
            ? 'type declared in this schema or its imports -- a name resolves in the schema holding it and its imports, never in the meta layer declaring its slot (§3.3.2)'
            : 'entry of this schema or its imports -- the first segment names the entry a value is reached through, and a member is reached through its entry (§5.12)'),
      );
    }
    const end = terminal(head, this.local);
    const referent = this.merged.get(end);
    if (referent === undefined) {
      throw new TsonSchemaValidationError(
        `${where} names '${name}', and the alias '${head}' reaches no entry (§8.3)`,
      );
    }
    const entry = end === head ? `'${head}'` : `'${head}' (an alias of '${end}')`;
    if (isOpen(referent) || isTemplateBody(referent)) {
      throw new TsonSchemaValidationError(
        `${where} names '${name}', and ${entry} is an open entry: a template denotes no value until it is applied (§5.10), so nothing is there to name`,
      );
    }
    if (slot.role === 'kind') {
      this.judgeMember(where, name, segments, slot, end, referent, entry);
      return;
    }
    this.judgeReference(where, name, segments, slot, end, referent, entry);
  }

  /**
   * A kind-typed slot holds a type's name, one segment, a member of the kind (§4.2): built with the
   * kind's `of` or a constructor IS-A it, and no constructor of types. A namespace entry is refused
   * as a value, however many segments name it.
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
    const wants = `${where} wants the name of a type built with '${slot.of}' (a member of '${kind}'), and `;
    if (segments.length > 1 && isNamespaceValue(referent)) {
      throw new TsonSchemaValidationError(
        `${wants}'${name}' reaches into ${entry}, which is ${aValueNoType(referent)} -- and what a further segment selects in a value is a value too`,
      );
    }
    if (segments.length > 1) {
      throw new TsonNotImplementedError(
        `${where} names '${name}' at a position typed by the kind '${kind}', which holds a type's name -- this library does not yet read a type through a namespace of types, so the name is one segment`,
      );
    }
    if (isKindMember(name, slot.of, this.local, (n) => this.headOf(n), this.structure)) return;
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
  ): void {
    const wanted = slot.of;
    let at = this.constructorOfEntry(end, referent);
    if (segments.length === 1) {
      if (!this.isA(at, wanted)) {
        throw new TsonSchemaValidationError(
          `${where} wants ${a(wanted)} value, and ${entry} is an entry whose body is built by '${at}', which is no '${wanted}' (§5.12)`,
        );
      }
      return;
    }
    if (!isNamespaceValue(referent)) {
      throw new TsonSchemaValidationError(
        `${where} names '${name}', and ${entry} is a type: a type entry admits no further segment, so '${segments[1] ?? ''}' selects in no value (§5.12)`,
      );
    }
    let value: MetaValue | undefined = { form: 'namespace', value: referent };
    let absent: string | undefined;
    let reached = segments[0] ?? name;
    for (const segment of segments.slice(1)) {
      const atName = terminal(at, this.structure);
      const body = this.structure(atName);
      const namespaceType = isNamespaceType(body, atName) ? body : undefined;
      if (namespaceType !== undefined) {
        const map = namespaceMapOf(namespaceType);
        if (map === undefined) {
          throw new TsonSchemaValidationError(
            `${where} names '${name}', and '${reached}' is ${a(at)}, a namespace type leaving its 'value_type' open`,
          );
        }
        if (value !== undefined) {
          const entries = entriesOf(value);
          const found = entries?.get(segment);
          if (found === undefined) {
            const keys = entries === undefined ? [] : [...entries.keys()];
            throw new TsonSchemaValidationError(
              `${where} names '${name}', and '${reached}' has no key '${segment}' -- it holds ${keys.length === 0 ? 'none' : keys.join(', ')}`,
            );
          }
          value = found;
        }
        at = map.valueType;
      } else if (body !== undefined && !isTemplateBody(body) && body.kind === 'record') {
        const field = body.fields.entries.get(segment);
        if (field === undefined) {
          throw new TsonSchemaValidationError(
            `${where} names '${name}', and '${reached}' is ${a(at)}, which has no field '${segment}' -- it declares ${[...body.fields.entries.keys()].join(', ') || 'none'}`,
          );
        }
        if (value !== undefined) {
          const held: MetaValue | undefined =
            value.form === 'record' ? value.fields.get(segment) : undefined;
          if (held === undefined && absent === undefined) {
            absent = `'${reached}' is ${a(at)} whose field '${segment}' is not present in the value`;
          }
          value = held;
        }
        at = field.type.name;
      } else if (body !== undefined && !isTemplateBody(body) && body.kind === 'map') {
        throw new TsonSchemaValidationError(
          `${where} names '${name}', and '${reached}' is ${a(at)}, a map that is no namespace, so it is not entered by name -- a segment selects a key of a namespace value or a field of a record value (§5.12)`,
        );
      } else if (body !== undefined && !isTemplateBody(body) && body.kind === 'array') {
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

/** The map a value of a namespace type holds, by key. */
function entriesOf(value: MetaValue): ReadonlyMap<string, MetaValue> | undefined {
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
function aValueNoType(namespace: Namespace<MetaValue>): string {
  return `a value of the namespace type '${namespace.type}', a map of names -- a value and not a type, so nothing can be typed by it (§4.1)`;
}

/** A type named with its article, as a message says it: `a 'method'`, `an 'interface'`. */
function a(typeName: string): string {
  return `${'aeiou'.includes(typeName.charAt(0)) ? 'an' : 'a'} '${typeName}'`;
}

/** A slot as an RFC 6901 pointer into the body. */
function pointer(steps: readonly string[]): string {
  return steps.map((step) => `/${step.replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');
}
