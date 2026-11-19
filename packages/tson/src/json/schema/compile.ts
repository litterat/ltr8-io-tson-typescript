/**
 * Turns a {@link LinkedSchema} (`link/link.ts`) into a {@link JsonCompiledSchema} — one
 * {@link JsonTypeReader} per entry, compiled **eagerly** so a broken entry surfaces at compile
 * time rather than on the first document that reaches it, mirroring the Java reference's own
 * `JsonSchemaCompiler`.
 *
 * **What this compiler builds (§3–§8.4).** Every atom family (`json/schema/atoms.ts`), every
 * record — closed (`json/schema/record.ts`) and every record-family position §6.1.5 governs:
 * OPEN-with-subtypes and ABSTRACT-with-no-`discriminators` (`json/schema/dispatchTag.ts`),
 * ABSTRACT/family-base-template naming `discriminators` (`json/schema/dispatchMember.ts`) —
 * arrays/sets and tuples (`json/schema/array.ts`, `json/schema/tuple.ts`), maps in both wire
 * forms (`json/schema/map.ts`), and every choice (§8, `json/schema/dispatchChoice.ts`). §3.3's
 * annotation object is read at every position that admits it: records and every record-family
 * dispatcher read it themselves; an atom, array or tuple position — which has no subtype of its
 * own to select into — is wrapped with `json/schema/atoms.ts`'s own `withAnnotationObject` right
 * here, at compile time, so a redundant `$type` restating the position's own type (or an alias of
 * it) is the only form §7.2 subsumption admits there.
 *
 * **A declared position (§7.8)**, the open sum of `meta.declared_type`, compiles to a
 * {@link notImplementedReader}: reading a value that names its own type in the JSON annotation object
 * is not built yet, and a dependent field (§5.2) likewise.
 *
 * **A namespace type reads as its map** ([TSON-SCHEMA] §4.1): a field typed `headers`, where
 * `headers => !meta.namespace { key_type: header_name  value_type: text }`, takes a JSON object
 * read as `{header_name => text}` and never as a record of the facets.
 *
 * **What it does not.** A template that is no family base (a genuine open template, never applied
 * bare, §5.10) and an entry holding a namespace *value* (`defaults => !headers { ... }`, a value
 * of a meta layer's vocabulary and never a type, §4.1) compile to {@link notImplementedReader}:
 * the plan stays **total** (every entry gets a reader, so a schema holding one still compiles and
 * its types read), and reading against such an entry reports `NOT_IMPLEMENTED`, [TSON-DATA]
 * §8.1's own non-verdict, as the reference's `ErrorReader` does for both.
 *
 * **A closed reference collapses at compile time** ([TSON-SCHEMA] §8.3): `day => date` compiles
 * to exactly the reader `date` itself compiles to, resolved once here rather than walked on every
 * value — `Compilation.resolve` below is where that walk happens, and it is also where a
 * self- or mutually-recursive record (`node => { children: [node] }`) is broken: a name still
 * being built resolves to a **deferred proxy** that looks the real reader up again at read time,
 * by which point compilation has always finished (compilation is synchronous and total; nothing
 * here suspends).
 */
import { TsonInternalError } from '../../core/errors.js';
import type { Task } from '../../io/bytes.js';
import type { NonHeldTop } from '../../link/bodyKind.js';
import type { LinkedSchema } from '../../link/link.js';
import type { RecordField } from '../../schema/meta/bodies.js';
import type { Namespace } from '../../schema/meta/typedef.js';
import { namespaceMapOf } from '../../schema/meta/namespaces.js';
import { isFamilyBase, isTemplateBody, subtypesOf, type Top } from '../../schema/meta/typedef.js';
import type { JsonReadContext } from '../readContext.js';
import {
  atomReader,
  enumReader,
  enumFormOf,
  treeAtomReader,
  voidReader,
  withAnnotationObject,
  type AtomReader,
} from './atoms.js';
import { buildArrayReader } from './array.js';
import { buildChoiceReader } from './dispatchChoice.js';
import { buildMemberDispatcher } from './dispatchMember.js';
import { buildTagDispatcher } from './dispatchTag.js';
import { notImplementedReader } from './notImplemented.js';
import { buildMapReader } from './map.js';
import { buildRecordReader } from './record.js';
import { createForeignLookup, type ForeignLookup, type ForeignSchemas } from './foreign.js';
import { buildTupleReader } from './tuple.js';
import type { JsonTypeReader } from './types.js';

export { notImplementedReader } from './notImplemented.js';
export type { JsonTypeReader } from './types.js';
export type { ForeignSchemas } from './foreign.js';

/** {@link compileJsonSchema}'s dependencies. */
export interface JsonCompileDeps {
  /** Where a value's own `$schema` is looked up as it arrives ([TSON-JSON] §8.5). Omitted, a scope push reports `SCHEMA_NOT_PERMITTED`. */
  readonly foreignSchemas?: ForeignSchemas;
}

/** What a factory needs beyond the entry it is building — one held per compile, never mutated after it finishes. */
export interface CompileContext {
  readonly linkedSchema: LinkedSchema;
  /** The reader for `name`, resolved (and, if not yet finished, deferred) through this compile's own `Compilation`. */
  resolve(name: string): JsonTypeReader;
  /** `name`'s own `SchemaLocation` — its origin schema id, `/name` pointer, and source position, when known. */
  locationOf(name: string): import('../../core/diagnostic.js').SchemaLocation;
  /** Whether `name`'s reader is a `treeAtomReader`-wrapped atom -- used only by `array.ts`'s own set-keying decision. */
  isAtomReader(name: string): boolean;
  /**
   * `name`'s own **unwrapped** atom reader -- the host-value-producing reader `treeAtomReader`
   * wraps, not the `JsonValue`-node-producing reader `resolve` hands back. `undefined` unless
   * {@link isAtomReader} answers `true` for `name`. `array.ts`'s own use: a set's duplicate check
   * needs the *decoded* value's identity (`json/schema/valueIdentity.ts`'s `identityOfHost`,
   * which a `JsonValue` node cannot answer for a compound value space like `rational` or
   * `datetime` — two spellings of one instant are two different node trees), and this is the one
   * reader that produces that decoded value.
   */
  rawAtomReader(name: string): AtomReader | undefined;
  /** The lookup a position reaches a document-named schema through (§8.5). */
  readonly foreign: ForeignLookup;
}

// ---------------------------------------------------------------------------------------------
// The compile
// ---------------------------------------------------------------------------------------------

/** A linked schema with one {@link JsonTypeReader} compiled per entry — `JsonSchemaCompiler.compile`'s port. */
export interface JsonCompiledSchema {
  readonly linkedSchema: LinkedSchema;
  /** `name`'s reader, or `undefined` when this schema declares no such entry. */
  find(name: string): JsonTypeReader | undefined;
  /** `name`'s reader; throws when this schema declares no such entry. */
  get(name: string): JsonTypeReader;
  /**
   * Where a read entering through `name` roots its schema pointer — the name the caller named,
   * not necessarily the entry it resolves to (they differ exactly when `name` aliases something
   * the resolver minted). `undefined` for a name this schema does not declare.
   */
  rootDeclaration(name: string): import('../../core/diagnostic.js').SchemaLocation | undefined;
}

function locationOf(
  linked: LinkedSchema,
  name: string,
): import('../../core/diagnostic.js').SchemaLocation {
  const position = linked.facts.get(name)?.position;
  const schemaId = linked.origins.get(name) ?? linked.id;
  return {
    schemaId,
    pointer: `/${name}`,
    ...(position === undefined ? {} : { position }),
  };
}

/**
 * Compiles `linkedSchema` in tree mode: one {@link JsonTypeReader} per entry, eagerly.
 * `foreign` is the lookup shared with the schema that admitted this one, so a scope push
 * compiles each foreign identity once.
 */
export function compileJsonSchema(
  linkedSchema: LinkedSchema,
  deps: JsonCompileDeps = {},
  foreign?: ForeignLookup,
): JsonCompiledSchema {
  const lookup: ForeignLookup =
    foreign ??
    createForeignLookup(deps.foreignSchemas, (linked) => compileJsonSchema(linked, deps, lookup));
  const finished = new Map<string, JsonTypeReader>();
  const atomReaders = new Map<string, AtomReader>();
  const building = new Set<string>();

  function resolve(name: string): JsonTypeReader {
    const done = finished.get(name);
    if (done !== undefined) return done;
    if (building.has(name)) {
      // A cycle: `name` is still being built by an enclosing `resolve` call on this same stack.
      // The real reader is always finished by the time anything actually reads through this --
      // compilation is synchronous and every entry is resolved before `compileJsonSchema`
      // returns -- so looking it up again at read time is correct and cheap (`finished.get`).
      return {
        *read(ctx: JsonReadContext): Task<unknown> {
          const real = finished.get(name);
          if (real === undefined) {
            throw new TsonInternalError(
              `'${name}' was read through before its own compile finished -- every entry is ` +
                'resolved before compileJsonSchema returns, so this is a library bug',
            );
          }
          return yield* real.read(ctx);
        },
      };
    }
    building.add(name);
    try {
      const def = linkedSchema.entries.get(name);
      if (def === undefined) {
        throw new TsonInternalError(
          `'${name}' is referenced but not present in the linked schema -- linking should ` +
            'already have rejected this before compilation ever started',
        );
      }
      const built = build(name, def);
      finished.set(name, built);
      return built;
    } finally {
      building.delete(name);
    }
  }

  const context: CompileContext = {
    linkedSchema,
    resolve,
    locationOf: (name: string) => locationOf(linkedSchema, name),
    isAtomReader: (name: string) => atomReaders.has(name),
    rawAtomReader: (name: string) => atomReaders.get(name),
    foreign: lookup,
  };

  function build(name: string, def: Top): JsonTypeReader {
    const body = def;
    const location = locationOf(linkedSchema, name);

    if (isFamilyBase(body)) {
      // A record template is a family base (§5.10): a position typed by it dispatches over its
      // members and never reads the template itself.
      const discriminators = body.discriminators ?? [];
      return discriminators.length > 0
        ? buildMemberDispatcher({
            name,
            displayName: name,
            discriminators,
            // A template's fields name their types, which is all dispatch reads of them.
            baseFields: body.fields as Namespace<RecordField>,
            entries: linkedSchema.entries,
            schemaLocation: location,
            ctx: context,
          })
        : buildTagDispatcher({
            name,
            displayName: name,
            entries: linkedSchema.entries,
            subtypes: subtypesOf(def),
            untagged: undefined,
            schemaLocation: location,
            resolve,
          });
    }
    if (isTemplateBody(body)) {
      // Not yet a type at all (§5.10): a template is applied, never read directly. Matches the
      // pinned Java reference's own `OpenTemplateReader`, which this package has not built as a
      // dedicated "not a type" refusal yet -- reported as a gap rather than misdiagnosed.
      return notImplementedReader(name, 'an open template');
    }
    if (body.kind === 'value_entry') {
      return notImplementedReader(name, "a value of a meta layer's vocabulary and no type");
    }
    if (body.kind === 'namespace') {
      const map = namespaceMapOf(body);
      return buildMapReader(
        name,
        {
          kind: 'map',
          keyType: body.keyType,
          valueType: body.valueType,
          voidable: false,
          ordered: map.ordered,
        },
        location,
        context,
      );
    }
    if (body.kind === 'declared_type') {
      return notImplementedReader(name, 'a declared position');
    }
    const nonData: NonHeldTop = body;

    if (nonData.kind === 'alias') {
      if (nonData.target.arguments.length > 0) {
        return notImplementedReader(name, 'an unmaterialised generic application');
      }
      const targetReader = resolve(nonData.target.name);
      // §8.3's reference collapse: `name` reads exactly as its target does, so it inherits the
      // target's raw atom reader too (if it has one) -- an alias of an atom family (`day =>
      // date`) is itself an atom-reader entry, not merely a pointer to one.
      const targetAtom = atomReaders.get(nonData.target.name);
      if (targetAtom !== undefined) atomReaders.set(name, targetAtom);
      return targetReader;
    }
    const constructorBody = nonData;

    switch (constructorBody.kind) {
      case 'void_type':
        return withAnnotationObject(name, linkedSchema.entries, voidReader(name, location));
      case 'enum': {
        const raw = enumReader(name, constructorBody, location, enumFormOf(linkedSchema, name));
        atomReaders.set(name, raw);
        return withAnnotationObject(name, linkedSchema.entries, treeAtomReader(raw));
      }
      case 'record': {
        if (constructorBody.extension === 'ABSTRACT') {
          return constructorBody.discriminators !== undefined
            ? buildMemberDispatcher({
                name,
                displayName: name,
                discriminators: constructorBody.discriminators,
                baseFields: constructorBody.fields,
                entries: linkedSchema.entries,
                schemaLocation: location,
                ctx: context,
              })
            : buildTagDispatcher({
                name,
                displayName: name,
                entries: linkedSchema.entries,
                subtypes: subtypesOf(def),
                untagged: undefined,
                schemaLocation: location,
                resolve,
              });
        }
        if (constructorBody.extension === 'OPEN' && subtypesOf(def).length > 0) {
          return buildTagDispatcher({
            name,
            displayName: name,
            entries: linkedSchema.entries,
            subtypes: subtypesOf(def),
            untagged: buildRecordReader(name, constructorBody, location, context),
            schemaLocation: location,
            resolve,
          });
        }
        return buildRecordReader(name, constructorBody, location, context);
      }
      case 'array':
        return withAnnotationObject(
          name,
          linkedSchema.entries,
          buildArrayReader(name, constructorBody, location, context),
        );
      case 'tuple':
        return withAnnotationObject(
          name,
          linkedSchema.entries,
          buildTupleReader(name, constructorBody, location, context),
        );
      case 'map':
        return buildMapReader(name, constructorBody, location, context);
      case 'choice':
        return buildChoiceReader(name, constructorBody, location, context);
      default: {
        const raw = atomReader(name, constructorBody, location, {
          // A JSON read is of data, whose names resolve in the closure the schema linked over (§4.2, §5.12).
          judgesKindMembers: true,
        });
        atomReaders.set(name, raw);
        return withAnnotationObject(name, linkedSchema.entries, treeAtomReader(raw));
      }
    }
  }

  for (const name of linkedSchema.entries.keys()) {
    resolve(name);
  }

  return {
    linkedSchema,
    find: (name: string) => finished.get(name),
    get: (name: string) => {
      const reader = finished.get(name);
      if (reader === undefined) {
        throw new TsonInternalError(
          `'${name}' is not declared in this compiled schema (${String(finished.size)} entries)`,
        );
      }
      return reader;
    },
    rootDeclaration: (name: string) =>
      linkedSchema.entries.has(name) ? locationOf(linkedSchema, name) : undefined,
  };
}
