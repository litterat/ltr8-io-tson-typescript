/**
 * Turns a {@link LinkedSchema} (`link/link.ts`) into a {@link JsonCompiledSchema} — one
 * {@link JsonTypeReader} per entry, compiled **eagerly** so a broken entry surfaces at compile
 * time rather than on the first document that reaches it, mirroring the Java reference's own
 * `JsonSchemaCompiler`.
 *
 * **What this compiler builds, and what it does not (§4, §5, §6.1.1–§6.1.4, §6.1.6, §6.2, §6.3, §6.4,
 * §7).** Every atom family (`json/schema/atoms.ts`), every closed record (no subtypes to
 * dispatch among — `json/schema/record.ts`), arrays/sets and tuples (`json/schema/array.ts`,
 * `json/schema/tuple.ts`), and maps in both wire forms (`json/schema/map.ts`). A position that
 * needs **dispatch** — an ABSTRACT or member-dispatched record (§6.1.5), an untagged choice
 * (§8), a scoped position (§8.5), or the annotation object itself (§3.3), since recognising one
 * at all is dispatch's own first step — compiles to {@link notImplementedReader}: the plan stays
 * **total** (every entry gets a reader, so a schema whose types include one of these still
 * compiles), and reading such a position reports `NOT_IMPLEMENTED`, [TSON-DATA] §8.1's own
 * non-verdict "a construct this implementation has not built yet".
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
import { isDataBody, type NonDataTop } from '../../link/bodyKind.js';
import type { LinkedSchema } from '../../link/link.js';
import { isTemplateBody, type TypeDefinition } from '../../schema/meta/typedef.js';
import type { JsonReadContext } from '../readContext.js';
import {
  atomReader,
  enumReader,
  identifierReader,
  treeAtomReader,
  valuePositionReader,
  voidReader,
  type AtomReader,
} from './atoms.js';
import { buildArrayReader } from './array.js';
import { skipNextValue } from './eventSkip.js';
import { buildMapReader } from './map.js';
import { buildRecordReader } from './record.js';
import { buildTupleReader } from './tuple.js';
import type { JsonTypeReader } from './types.js';

export type { JsonTypeReader } from './types.js';

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
}

/**
 * A reader reporting `NOT_IMPLEMENTED` for a position this package cannot read yet -- see this
 * module's own top note for exactly which ones. **Still consumes the whole value it
 * cannot read** ({@link skipNextValue}): a gap must leave the event stream exactly where a reader
 * that understood this position would have left it, or the sibling field/element read next would
 * desynchronise against events this reader never pulled.
 */
export function notImplementedReader(displayName: string, reason: string): JsonTypeReader {
  return {
    *read(ctx: JsonReadContext): Task<undefined> {
      ctx.report(
        'NOT_IMPLEMENTED',
        `'${displayName}' is ${reason}, which this package does not read yet`,
      );
      yield* skipNextValue(ctx);
      return undefined;
    },
  };
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
  const def = linked.entries.get(name);
  const schemaId = linked.origins.get(name) ?? linked.id;
  return {
    schemaId,
    pointer: `/${name}`,
    ...(def?.position === undefined ? {} : { position: def.position }),
  };
}

/** Compiles `linkedSchema` in tree mode: one {@link JsonTypeReader} per entry, eagerly. */
export function compileJsonSchema(linkedSchema: LinkedSchema): JsonCompiledSchema {
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
  };

  function build(name: string, def: TypeDefinition): JsonTypeReader {
    const body = def.body;
    const location = locationOf(linkedSchema, name);

    if (isTemplateBody(body)) {
      return notImplementedReader(name, 'an open template family base');
    }
    if (isDataBody(body)) {
      return notImplementedReader(name, "a meta-layer 'data' construct, which names no value");
    }
    const nonData: NonDataTop = body;

    if (nonData.kind === 'reference') {
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
      case 'unit':
        switch (name) {
          case 'void':
            return voidReader(name, location);
          case 'value':
            // Tree-mode-wrapped like every other atom position, so a `value`-typed record field
            // or container element stores the `JsonValue` node this package's containers expect
            // rather than the bare host scalar `valuePositionReader` itself produces (its own
            // classification is still what validates the position -- `treeAtomReader` discards
            // the classified value and keeps the node, exactly as it does for every other atom).
            return treeAtomReader(valuePositionReader(name, location));
          case 'identifier': {
            const raw = identifierReader(name, location);
            atomReaders.set(name, raw);
            return treeAtomReader(raw);
          }
          default:
            return notImplementedReader(
              name,
              "a 'unit' instance with no content grammar of its own",
            );
        }
      case 'enum': {
        const raw = enumReader(name, constructorBody, location);
        atomReaders.set(name, raw);
        return treeAtomReader(raw);
      }
      case 'record':
        if (constructorBody.extension === 'ABSTRACT') {
          return notImplementedReader(
            name,
            constructorBody.discriminators.length > 0
              ? 'a member-dispatched record family'
              : 'an abstract record',
          );
        }
        return buildRecordReader(name, constructorBody, location, context);
      case 'array':
        return buildArrayReader(name, constructorBody, location, context);
      case 'tuple':
        return buildTupleReader(name, constructorBody, location, context);
      case 'map':
        return buildMapReader(name, constructorBody, location, context);
      case 'choice':
        return notImplementedReader(name, 'an untagged choice (§8)');
      case 'scoped':
        return notImplementedReader(name, 'a scoped position (§8.5)');
      default: {
        const raw = atomReader(name, constructorBody, location);
        atomReaders.set(name, raw);
        return treeAtomReader(raw);
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
