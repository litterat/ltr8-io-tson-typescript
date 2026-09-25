/**
 * Meta-kernel's own pre-loaded bootstrap (Part 2 §1.5): "The `!!meta` directive names this file
 * itself -- the one deliberate circularity in the series, closed by pre-loading rather than by
 * resolution: implementations ship the kernel's resolved structure, and this document describes
 * it." Ordinary resolution (`compiler/schemaResolver.ts`) can't bootstrap meta-kernel from
 * nothing: resolving a constructor-*application* instance (`!C value`, §5.5, e.g.
 * `integer => !integer_type {}`) needs `C`'s own vocabulary already known, and for meta-kernel,
 * every `C` it uses is defined *within the same file*.
 *
 * Ported from the reference implementation's `MetaKernelBootstrapResolver`
 * (`tson-compiler/.../resolver/MetaKernelBootstrapResolver.java`); see that file's own module doc
 * for the exhaustive rationale. This module states only what differs in the port.
 *
 * {@link bootstrapMetaKernel} resolves the source it is handed in **two passes**: every
 * non-`Instance` declaration first (an ordinary `definitionResolver.ts` pass, one source-order
 * walk -- meta-kernel's own non-`Instance` declarations never forward-reference each other, so
 * this needs none of `schemaResolver.ts`'s own on-demand/cycle-detecting machinery), then every
 * deferred `Instance` declaration (`value => !unit {}`, `boolean => !enum [true false]`, ...) once
 * every constructor they reference -- including ones declared *later* in the file, e.g.
 * `boolean => !enum [true false]` precedes `enum`'s own declaration -- has an entry to transfer a
 * kind from.
 *
 * **Every `Instance` resolves through {@link instanceBody}, a closed, hand-written switch, not
 * the generic `DefinitionMetaReader` path.** A schema-driven reader can't safely bootstrap
 * meta-kernel from its own in-progress state: `integer_size => { bits: ... signed: boolean }` is a
 * first-pass entry whose `signed` field already references `boolean`, which the *second* pass
 * resolves, so there is no moment at which a reader could be compiled against a complete schema.
 * Meta-kernel only ever instantiates constructors in three known shapes -- a bare `{}`, a bare
 * array of tokens (`enum`), and the binding record `desugar.ts` emits for a container application
 * -- so {@link instanceBody} hand-picks all nine of its own real constructor targets uniformly.
 *
 * **Desugaring needs no equivalent trick.** `desugar.ts`'s own sugar table is fixed by the sugar
 * forms (§5.3) and consults no governing meta at all -- which for meta-kernel would have been the
 * very entries this function is producing -- so the ordinary `desugar()` call runs unmodified.
 *
 * **This function's own output is not linked.** `subtypes` (the transitive inverse of
 * `supertypes` across the whole namespace) and `disjoint` (choice-variant discrimination
 * distinctness) are both resolver-derived *caches*, computed by a later work package's linker over
 * a schema's whole entry graph -- not a per-declaration or even a per-document resolution concern.
 * This function's {@link Schema} is `spec/m/meta-kernel-resolved.tn` minus those two caches; a
 * caller that needs the fully linked form runs this function's output through that later linker.
 *
 * **Zero I/O, by design.** The reference implementation reads meta-kernel.tn as a packaged
 * classpath resource; this port has no equivalent packaging step yet (a later work package's
 * concern), so `source` is a parameter rather than a hard-coded fetch -- the caller (a test, or
 * the eventual front door) is responsible for handing this function meta-kernel's own real,
 * bundled bytes (`spec/m/meta-kernel.tn`, vendored verbatim per `CLAUDE.md`), unread and
 * unmodified. This keeps the module import-clean for a browser bundle: no `node:fs`, no
 * conditional export.
 */
import { TsonInternalError } from '../core/errors.js';
import { fromBytes, runSync } from '../io/bytes.js';
import type { CoreValue, DataValue } from '../ast/value.js';
import type { Declaration, SchemaDocument } from '../ast/schema/document.js';
import type { Instance } from '../ast/schema/fields.js';
import type { TypeRef } from '../ast/schema/typeref.js';
import { toCoreValue } from '../bind/encode.js';
import { createDefinitionResolver } from '../compiler/definitionResolver.js';
import { createDefinitionMetaReader } from './metaReader.js';
import type { DefinitionGetter } from '../compiler/resolverTypes.js';
import { desugar } from '../compiler/desugar.js';
import { parseSchemaDocument } from '../compiler/schemaParser.js';
import type { Schema } from '../compiler/schemaResolver.js';
import type { ArrayBody, EnumBody, MapBody } from './meta/bodies.js';
import type { Top, TypeDefinition } from './meta/typedef.js';
import { defaultAtomEncoder } from '../write/bindingWriter.js';
import { topBinding } from './bindings.js';

/** Parses and resolves meta-kernel's own source text (see this module's own doc). */
export function bootstrapMetaKernel(source: Uint8Array): Schema {
  const parsed = runSync(parseSchemaDocument(fromBytes(source)));
  // Meta-kernel desugars like every other schema, and needs no special case -- see this module's
  // own doc.
  const document = desugar(parsed, new Set());
  const entries = resolveEntries(document);
  const id = document.id;
  if (id === undefined) {
    throw new TsonInternalError(
      'meta-kernel.tn has no !!id -- this should never happen for the real, bundled fixture',
    );
  }
  return {
    id,
    meta: document.meta,
    imports: document.imports,
    entries,
    // The bootstrap route attaches no @synthetic marker, deliberately: this output stands in only
    // as the transient governing meta for meta-kernel's own resolution, and nothing here reads the
    // marker. A caller wanting meta-kernel's entries properly marked runs `schemaResolver.ts`'s
    // ordinary `resolveSchema` over the same document instead, governed by this function's own
    // output -- ordinary resolution is what everything else meta-kernel produces comes from.
    keyAnnotations: new Map(),
    bootstrap: true,
  };
}

/**
 * The name a declaration's own head resolves EAGERLY -- the one entry that must already be in the
 * map before this declaration can be resolved at all, or `undefined` where the head names none.
 *
 * A refinement's source, a construction's first supertype, an instance's constructor and a plain
 * reference's target are each read at resolution time; every other name a body mentions (a field's
 * declared type, an element type) is a reference resolved later, not now. That distinction is what
 * makes the ordering below a finite walk over an acyclic relation rather than a topological sort
 * of the whole self-referential kernel: no type refines, composes with, constructs from or aliases
 * itself.
 */
function eagerSourceName(typeDef: Declaration['typeDef']): string | undefined {
  switch (typeDef.kind) {
    case 'atomRefinement':
      return typeDef.target;
    case 'instance':
      return typeDef.value.typeRef;
    case 'referenceTypeDef':
      return simpleRefName(typeDef.ref);
    case 'structuralTypeDef':
      switch (typeDef.body.kind) {
        case 'refinedDef':
          return simpleRefName(typeDef.body.target);
        case 'constructionDef':
          return simpleRefName(typeDef.body.supertypes[0]);
        case 'recordDef':
          return undefined;
      }
  }
}

/** `ref`'s own name where it is a bare or generic reference, and `undefined` for the bracket, brace and paren forms, which name a container rather than an entry. */
function simpleRefName(ref: TypeRef): string | undefined {
  return ref.kind === 'simpleRef' || ref.kind === 'genericRef' ? ref.name : undefined;
}

/**
 * Meta-kernel's declarations, resolved in DEPENDENCY order rather than source order.
 *
 * Source order does not suffice and the kernel says why: `non_negative_integer => !integer ^ { min: 0 }`
 * refines `integer`, which is itself `integer => !integer_type {}` -- an instance whose kind is
 * transferred from a constructor declared elsewhere. Ordering by declaration KIND does not suffice
 * either, for the same pair from the other side: it puts every instance after every refinement, so
 * a refinement OF an instance is resolved while its source is still pending and
 * `resolveAtomRefinement` reports the source as undeclared (§3.3.1).
 *
 * So each declaration waits for the one entry its head names ({@link eagerSourceName}), and a
 * sweep that resolves at least one declaration is repeated until none is left or none can move. A
 * declaration whose head names something the document does not declare at all is not waiting for
 * anything and resolves immediately; anything still pending when the sweeps stop is resolved in
 * source order regardless, so a genuine cycle or a genuinely undeclared source reaches the
 * resolver and is reported as the error it is, rather than being silently dropped here.
 */
function resolveEntries(document: SchemaDocument): Map<string, TypeDefinition> {
  const entries = new Map<string, TypeDefinition>();
  const governing: DefinitionGetter = (name) => entries.get(name);
  const resolver = createDefinitionResolver({
    // Meta-kernel governs itself, so its own accumulating map is both the type-name namespace
    // and the structure namespace a constructor application is read against. The kernel's one
    // atom refinement (`non_negative_integer => !integer ^ { min: 0 }`) reaches the meta reader
    // for `integer_type`, which the dependency ordering below has already resolved by then.
    definitionMetaReader: createDefinitionMetaReader(governing),
    metaDefinitions: governing,
    namespaceDefinitions: governing,
    // §5.7: an atom refinement merges onto its source's wire record before binding, and the
    // kernel has one of its own -- `non_negative_integer => !integer ^ { min: 0 }`. A `Binding`
    // here is bidirectional by construction, so the merge runs through `bind/encode.ts` rather
    // than through a writer the resolver would otherwise have to hold.
    encodeSourceBody: (body) => toCoreValue(topBinding, body, defaultAtomEncoder),
  });

  const declarations = [...document.body.declarations.values()];
  const declared = new Set(declarations.map((declaration) => declaration.name));

  const ready = (declaration: Declaration): boolean => {
    const source = eagerSourceName(declaration.typeDef);
    if (source === undefined || source === declaration.name) return true;
    return !declared.has(source) || entries.has(source);
  };

  let pending = declarations;
  for (;;) {
    const deferred: Declaration[] = [];
    for (const declaration of pending) {
      if (ready(declaration)) resolveInto(entries, resolver, declaration);
      else deferred.push(declaration);
    }
    if (deferred.length === 0) return entries;
    if (deferred.length === pending.length) break;
    pending = deferred;
  }
  for (const declaration of pending) resolveInto(entries, resolver, declaration);
  return entries;
}

/**
 * Resolves one declaration into `entries`.
 *
 * An `Instance` takes its own route: §5.5's constructor application produces a fresh entry with
 * no supertypes and no parameters of its own -- `kind` is never transferred, since it is derived
 * rather than stored (`schema/meta/typedef.ts`'s own `typeKind`, consulted by a later caller that
 * needs it, not by this bootstrap). Waiting for `target` to exist in `entries`
 * before proceeding still matters, though: it is what makes the two-pass sweep converge in
 * declaration order regardless of forward references, since {@link instanceBody} builds the new
 * entry's body directly from the kernel's own vocabulary without consulting `target` any further
 * -- which is why the generic resolver is handed {@link NEVER_CALLED} as its meta reader. An
 * instance whose target is unrecognised, or not yet resolved after every sweep, is left out
 * rather than guessed at; `instanceBody`'s own doc says why that is not an error here.
 */
function resolveInto(
  entries: Map<string, TypeDefinition>,
  resolver: ReturnType<typeof createDefinitionResolver>,
  declaration: Declaration,
): void {
  if (declaration.typeDef.kind !== 'instance') {
    entries.set(declaration.name, resolver.resolve(declaration));
    return;
  }
  const instance = declaration.typeDef;
  const targetName = requireTypeRef(instance.value, declaration.name);
  const target = entries.get(targetName);
  if (target === undefined) return;
  const body = instanceBody(instance, targetName);
  if (body === undefined) return;
  entries.set(declaration.name, {
    source: { name: targetName, arguments: [], annotations: [] },
    supertypes: [],
    subtypes: [],
    body,
    annotations: [],
  });
}

function requireTypeRef(value: DataValue, declarationName: string): string {
  if (value.typeRef === undefined) {
    throw new TsonInternalError(
      `'${declarationName}': an Instance's own value always carries a type-ref naming its constructor`,
    );
  }
  return value.typeRef;
}

const RFC_3986 = 'https://www.rfc-editor.org/rfc/rfc3986';
const RFC_9485 = 'https://www.rfc-editor.org/rfc/rfc9485';

/**
 * The direct, hand-written construction for one of meta-kernel's own nine real constructor
 * targets, `undefined` for anything else -- left for the caller to decide what that means (today:
 * the declaration is simply left out of the result, rather than failing the whole bootstrap;
 * unexercised against the real fixture, since every real target is one of the nine).
 *
 * Exported so a test can exercise the unrecognised-target and wrong-shape-body branches directly
 * -- neither is reachable through the real fixture (every real target is one of the nine, and
 * every empty-bodied one really is empty).
 */
export function instanceBody(instance: Instance, target: string): Top | undefined {
  switch (target) {
    case 'unit':
      requireEmptyBody(instance, target);
      return { kind: 'unit' };
    case 'integer_type':
      requireEmptyBody(instance, target);
      return { kind: 'integer_type' };
    case 'text_type':
      requireEmptyBody(instance, target);
      return { kind: 'text_type' };
    case 'uri_type':
      requireEmptyBody(instance, target);
      return { kind: 'uri_type', spec: RFC_3986 };
    case 'regex_type':
      requireEmptyBody(instance, target);
      return { kind: 'regex_type', spec: RFC_9485 };
    case 'enum':
      return toEnumBody(instance.value);
    // `array` is emitted by desugar.ts above; `set_type` is written by hand in the kernel too
    // (`integer_member_set`, `enum_set`). They differ only in the defaults `set_type` tightens
    // (§5.7): ordered/duplicating vs unordered/unique.
    case 'array':
      return toArrayBody(instance.value, false);
    case 'set_type':
      return toArrayBody(instance.value, true);
    case 'map':
      return toMapBody(instance.value);
    default:
      return undefined;
  }
}

/** Every empty-bodied target above is only ever instantiated as a bare `{}` in the real fixture -- checked rather than assumed, since each one's own constraint value is a hand-picked constant, not parsed from the instance body. */
function requireEmptyBody(instance: Instance, target: string): void {
  if (instance.value.coreValue.kind !== 'empty-brace') {
    throw new TsonInternalError(
      `expected {} for !${target}, found ${instance.value.coreValue.kind}`,
    );
  }
}

/** `!array { element_type: T }` / `!set { element_type: T }` as the body each denotes. */
function toArrayBody(value: DataValue, unique: boolean): ArrayBody {
  return {
    kind: 'array',
    elementType: { name: bindingField(value, 'element_type'), arguments: [], annotations: [] },
    state: 'REQUIRED',
    unordered: unique,
    uniqueItems: unique,
  };
}

/**
 * `!map { key_type: K  value_type: V }` as the body it denotes. Meta-kernel's own sole map
 * instance (`schema => {type_name => type_definition}`) never desugars with the value-optional
 * sugar, so `state` is always `REQUIRED`, its default -- there is no `state` field in the
 * binding record to read (§8.1 omits a field at its default).
 */
function toMapBody(value: DataValue): MapBody {
  return {
    kind: 'map',
    keyType: { name: bindingField(value, 'key_type'), arguments: [], annotations: [] },
    valueType: { name: bindingField(value, 'value_type'), arguments: [], annotations: [] },
    state: 'REQUIRED',
  };
}

/** One field of a desugared instance's binding record -- always a bare token naming a type. */
function bindingField(value: DataValue, name: string): string {
  const record = requireRecord(value.coreValue);
  for (const field of record.fields) {
    if (field.name !== name) {
      continue;
    }
    const core = field.value.value.coreValue;
    if (core.kind === 'token') {
      return core.text;
    }
    break;
  }
  throw new TsonInternalError(`no '${name}' in ${JSON.stringify(record)}`);
}

function requireRecord(value: CoreValue): Extract<CoreValue, { kind: 'record' }> {
  if (value.kind !== 'record') {
    throw new TsonInternalError(`expected a binding record, found ${value.kind}`);
  }
  return value;
}

/**
 * `!enum [true false]`'s value is a bare array (§5.6's positional form for a single-field
 * constructor), not `{ members: [...] }`.
 */
function toEnumBody(value: DataValue): EnumBody {
  if (value.coreValue.kind !== 'array') {
    throw new TsonInternalError(`expected an array for !enum, found ${value.coreValue.kind}`);
  }
  const members: string[] = [];
  for (const element of value.coreValue.elements) {
    const core = element.value.coreValue;
    if (core.kind !== 'token') {
      throw new TsonInternalError(`expected a token enum member, found ${core.kind}`);
    }
    members.push(core.text);
  }
  return { kind: 'enum', members, profile: 'IDENTIFIER' };
}
