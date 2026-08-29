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
import { createDefinitionResolver } from '../compiler/definitionResolver.js';
import type { DefinitionGetter, DefinitionMetaReader } from '../compiler/resolverTypes.js';
import { desugar } from '../compiler/desugar.js';
import { flattenSchema } from '../compiler/referenceFlattener.js';
import { parseSchemaDocument } from '../compiler/schemaParser.js';
import type { Schema } from '../compiler/schemaResolver.js';
import type { ArrayBody, EnumBody, MapBody } from './meta/bodies.js';
import type { Top, TypeDefinition } from './meta/typedef.js';

/** Parses and resolves meta-kernel's own source text (see this module's own doc). */
export function bootstrapMetaKernel(source: Uint8Array): Schema {
  const parsed = runSync(parseSchemaDocument(fromBytes(source)));
  // Meta-kernel desugars like every other schema, and needs no special case -- see this module's
  // own doc.
  const document = desugar(parsed, new Set());
  const entries = resolveEntries(document);
  // §8.3 applies here as it does to any other schema: this is a shorter route to the same
  // resolved form, not a different one, and this output governs anything whose !!meta is
  // meta-kernel -- so a use site flattened by ordinary resolution and left unflattened here would
  // be two answers to one question. No minted entries to stop at: this bootstrap runs no
  // materialisation, and meta-kernel imports nothing, so `entries` is the whole namespace a chain
  // can walk.
  const flattened = flattenSchema(entries, entries, new Set());
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
    entries: flattened,
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
 * A `DefinitionMetaReader` that always throws -- the first pass below only ever calls
 * `DefinitionResolver#resolve` on a non-`Instance` declaration, so `bindAtomInstance` can never
 * actually be reached from here (every `Instance` is filtered out and resolved through
 * {@link instanceBody} directly, in the second pass, never through the generic resolver at all).
 * A loud failure if that assumption is ever wrong is safer than silently handing the resolver a
 * reader that could return something meaningless.
 */
const NEVER_CALLED: DefinitionMetaReader = (type) => {
  throw new TsonInternalError(
    `'${type}': meta-kernel's own bootstrap resolves every Instance declaration through instanceBody ` +
      'directly -- this reader should never be called',
  );
};

/** Meta-kernel governs itself, so it has no separate structure namespace to fall back to -- the first pass never reaches a constructor-application `Instance` at all, the one place a structure namespace is ever consulted. */
const EMPTY_META_DEFINITIONS: DefinitionGetter = () => undefined;

function resolveEntries(document: SchemaDocument): Map<string, TypeDefinition> {
  const entries = new Map<string, TypeDefinition>();
  const resolver = createDefinitionResolver({
    definitionMetaReader: NEVER_CALLED,
    metaDefinitions: EMPTY_META_DEFINITIONS,
    namespaceDefinitions: (name) => entries.get(name),
  });
  const instances: Declaration[] = [];

  for (const declaration of document.body.declarations.values()) {
    if (declaration.typeDef.kind === 'instance') {
      // Deferred to the second pass: an Instance's own kind is transferred from its target, which
      // (e.g. "enum", declared long after "boolean" uses it) may not be resolved yet in source order.
      instances.push(declaration);
      continue;
    }
    entries.set(declaration.name, resolver.resolve(declaration));
  }

  for (const declaration of instances) {
    if (declaration.typeDef.kind !== 'instance') {
      throw new TsonInternalError(
        `'${declaration.name}': expected an Instance in the deferred second pass`,
      );
    }
    const instance = declaration.typeDef;
    const targetName = requireTypeRef(instance.value, declaration.name);
    const target = entries.get(targetName);
    if (target === undefined) {
      continue; // unreachable against the real, bundled fixture -- see instanceBody's own doc
    }
    const body = instanceBody(instance, targetName);
    if (body === undefined) {
      continue; // an unrecognised target -- see instanceBody's own doc on why this is not an error here
    }
    // §5.5: constructor application transfers only the target's kind; no supertypes, no
    // parameters -- this is construction, not composition or refinement.
    entries.set(declaration.name, {
      source: { name: targetName, arguments: [], annotations: [] },
      kind: target.kind,
      parameters: [],
      constructor: false,
      supertypes: [],
      subtypes: [],
      body,
      annotations: [],
    });
  }
  return entries;
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
    // Emitted by desugar.ts above, never written by hand in the fixture. array and set differ
    // only in the defaults set tightens (§5.7): ordered/duplicating vs unordered/unique.
    case 'array':
      return toArrayBody(instance.value, false);
    case 'set':
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
  return { kind: 'enum', members };
}
