/**
 * The position an extern types ([TSON-SCHEMA] §5.13): the boundary between the scope that holds a value and the
 * foreign schema's, which the value's body is read in ([TSON-SCHEMA] §7.9, [TSON-JSON] §8.6). It selects how the
 * value crosses and builds nothing, so one reader serves every position.
 *
 * **The `$type` leading the object, or its wrapper, is the enclosing scope's.** It is judged here, against this
 * namespace, before the value crosses: a name of this scope reaching the target, a subtype or a variant of it, by
 * identity (`link/externAdmission.ts`, the one admission both encodings read). A foreign reader reads the rest as that
 * entry -- the inline form's object without its `$type`, the wrapper's `$value` as it stands. The wrapper's own
 * members are apparatus of the enclosing scope and are judged here, and so is a `$type` leading its `$value`, refused
 * before the value crosses (§3.3: the value's one type name is the boundary's). Every other name inside the value
 * resolves in the foreign schema, its reader being that schema's own compile.
 *
 * **An extern of a map is a map-typed position** (§3.3, §6.4): its object's members are keys, a leading `$type` among
 * them, so no annotation object is recognised and the value always crosses as written. A dispatcher that matched its
 * tag hands it a wrapper ({@link ExactReader.takesWrapper}), whose `$value` crosses.
 *
 * **The cursor, receiver, policies and data path are the document's** (`json/readContext.ts`'s `readingAcross`): the
 * schema location restarts inside, and every diagnostic raised there names the foreign schema and the extern.
 *
 * @module
 */
import type { SchemaLocation } from '../../core/diagnostic.js';
import type { Task } from '../../io/bytes.js';
import { describeExtern } from '../../link/externs.js';
import { externAdmission, namesASubtype } from '../../link/externAdmission.js';
import { declaringIdentity, landingDefinition, type Landing } from '../../link/externTarget.js';
import type { ForeignScope } from '../../link/foreignScope.js';
import { canonicalizeIdentity } from '../../link/identity.js';
import type { LinkedSchema } from '../../link/link.js';
import type { Top } from '../../schema/meta/typedef.js';
import { readingAcross, type JsonReadContext } from '../readContext.js';
import { skipNextValue } from './eventSkip.js';
import { nameHygieneRefuses } from './nameHygiene.js';
import type { ExactReader } from './route.js';
import { lead as leadOf, leadPresent, readWrapped, VALUE, type Lead } from './tagMembers.js';
import { refusesScope } from './tags.js';
import type { JsonTypeReader } from './types.js';

/**
 * How a value crosses through one extern: the foreign entry's reader, which reads the value untagged as that entry;
 * the scope it is read in; whether the entry is abstract with no selectors, where a value must name a subtype of it;
 * whether it reads an object as a record, where the annotation members may stand inline; and whether it is map-typed,
 * where a wrapper's `$value` holds keys (§3.3).
 */
interface Crossing {
  readonly reader: JsonTypeReader;
  readonly scope: ForeignScope;
  readonly namesASubtype: boolean;
  readonly record: boolean;
  readonly keyed: boolean;
}

/** Where a compile obtains the readers of a schema a foreign value is read in, each compiled once per compile. */
export interface ForeignJsonReaders {
  /** `linked`'s reader of `name`. */
  reader(linked: LinkedSchema, name: string): JsonTypeReader;
  /** The reader of `name` in the schema of canonical identity `identity`, or `undefined` where none can be obtained. */
  readerIn(identity: string, name: string): JsonTypeReader | undefined;
}

/** Whether a value of `definition` is a map, whose object's members are keys and never annotation members (§3.3). */
function keyed(definition: Top | undefined): boolean {
  return definition?.kind === 'map' || definition?.kind === 'namespace';
}

/** Whether a value of `definition` is a record, whose annotation members may stand inline (§3.3). */
function readsARecord(definition: Top | undefined): boolean {
  return definition?.kind === 'record' && (definition.parameters?.length ?? 0) === 0;
}

/**
 * The boundary at a position typed by the extern `name` of `linked`: every name of this namespace that reaches, past
 * its alias chain and its externs, the entry `name` lands on or one it admits, each with the foreign reader it crosses
 * through. `undefined` where the extern is attached to nothing, which a linked schema never holds.
 */
export function externBoundary(
  linked: LinkedSchema,
  name: string,
  location: SchemaLocation,
  foreign: ForeignJsonReaders,
): (JsonTypeReader & ExactReader) | undefined {
  const admission = externAdmission(linked, name);
  const attached = linked.externs?.get(name);
  if (admission === undefined || attached === undefined) return undefined;
  const scopeOf = (extern: string, schema: string): ForeignScope => ({
    extern,
    declaredIn: declaringIdentity(linked, extern),
    schema,
  });
  const crossing = (extern: string, landing: Landing): Crossing => {
    const target = linked.externs?.get(extern) ?? attached;
    const definition = landingDefinition(landing);
    return {
      reader: foreign.reader(target.foreign, target.type),
      scope: scopeOf(extern, canonicalizeIdentity(target.foreign.id)),
      namesASubtype: namesASubtype(definition),
      record: readsARecord(definition),
      keyed: keyed(definition),
    };
  };
  const own = crossing(name, admission.landing);
  // A name of this scope that is no extern and reaches an entry narrower than the target is read in the position's
  // foreign schema, or in the namespace its target lands in, where either holds that entry, else in the schema
  // declaring it (§7.9).
  const imported = (entry: string, declaredBy: string, reached: Top): Crossing => {
    const facts = {
      namesASubtype: namesASubtype(reached),
      record: readsARecord(reached),
      keyed: keyed(reached),
    };
    for (const within of [attached.foreign, admission.landing.in]) {
      if (within.entries.has(entry) && declaringIdentity(within, entry) === declaredBy) {
        return {
          reader: foreign.reader(within, entry),
          scope: scopeOf(name, canonicalizeIdentity(within.id)),
          ...facts,
        };
      }
    }
    return {
      reader: foreign.readerIn(declaredBy, entry) ?? unobtainable(entry, declaredBy),
      scope: scopeOf(name, declaredBy),
      ...facts,
    };
  };
  const admitted = new Map<string, Crossing>();
  const byEntry = new Map<string, Crossing>([[name, own]]);
  const narrower: string[] = [];
  for (const [written, reach] of admission.admitted) {
    let through = byEntry.get(reach.terminal);
    if (through === undefined) {
      through =
        reach.through !== undefined
          ? crossing(reach.terminal, reach.through)
          : reach.by === 'TARGET'
            ? own
            : imported(reach.terminal, reach.declaringSchema, reach.reached);
      byEntry.set(reach.terminal, through);
    }
    admitted.set(written, reach.by === 'TARGET' && reach.through === undefined ? own : through);
    // What a message offers is a tag that is read: an abstract record naming no selectors would refuse in turn.
    if (reach.by !== 'TARGET' && !namesASubtype(reach.reached)) narrower.push(written);
  }
  const extern = linked.entries.get(name);
  return boundaryReader({
    name,
    location,
    outer: linked.entries,
    describe: extern?.kind === 'extern' ? describeExtern(extern) : 'an extern',
    own,
    admitted,
    selectsNone: admission.selectsNone,
    narrower: narrower.join(' | '),
    mapTyped: keyed(landingDefinition(admission.landing)),
  });
}

/** A reader for an entry no schema this compile can obtain declares: reported as not implemented, never a verdict. */
function unobtainable(entry: string, identity: string): JsonTypeReader {
  return {
    *read(ctx: JsonReadContext): Task<unknown> {
      ctx.report(
        'NOT_IMPLEMENTED',
        `'${entry}' reaches '${identity}#${entry}', which a compile with no registry cannot read in its own ` +
          "schema's scope ([TSON-SCHEMA] §7.9)",
        'a schema this compile can obtain',
        entry,
      );
      yield* skipNextValue(ctx);
      return undefined;
    },
  };
}

interface Boundary {
  readonly name: string;
  readonly location: SchemaLocation;
  readonly outer: ReadonlyMap<string, Top>;
  readonly describe: string;
  readonly own: Crossing;
  /** Every name this scope may tag the value with, mapped to how the value crosses. */
  readonly admitted: ReadonlyMap<string, Crossing>;
  /** Every name IS-A more than one variant of a choice the target is and meaning none, to those variants. */
  readonly selectsNone: ReadonlyMap<string, readonly string[]>;
  /** The admitted names a value may carry that land on a subtype or a variant of the target, joined for a message. */
  readonly narrower: string;
  /** Whether the target is a map: its object's members are keys, and no annotation object is recognised. */
  readonly mapTyped: boolean;
}

function boundaryReader(boundary: Boundary): JsonTypeReader & ExactReader {
  const { name, location, outer, own, admitted, selectsNone, narrower, mapTyped } = boundary;
  const admissible = [...admitted.keys()].join(' | ');
  const offered = narrower === '' ? 'no tag this scope can write' : narrower;

  function abstractNamed(written: string): string {
    return (
      `'${written}' reaches an abstract record naming no discriminators, which has no direct instances, so a ` +
      'value here names a subtype of it, by a name of the enclosing scope, ' +
      (narrower === '' ? 'and this scope has none' : `one of (${narrower})`) +
      ' ([TSON-SCHEMA] §7.2, §7.9)'
    );
  }

  function refusal(tag: string): string {
    const admits =
      'a tag is admitted where it reaches the target, a subtype of it, or a variant of it ' +
      `(${admissible}) ([TSON-SCHEMA] §7.9)`;
    return outer.has(tag)
      ? `'${tag}' is not admissible at a '${name}' position, which is ${boundary.describe}: the tag is read in ` +
          `the enclosing scope, where '${tag}' reaches another type, and ${admits}`
      : `'${tag}' names no type of the enclosing scope, and a tag at a '${name}' position, which is ` +
          `${boundary.describe}, is read there: the foreign schema's own names are not, and ${admits}`;
  }

  /** `through`'s reader of the value at `ctx`, inside its scope; `dropsTag` where the object leads with the tag. */
  function* cross(ctx: JsonReadContext, through: Crossing, dropsTag: boolean): Task<unknown> {
    return yield* readingAcross(ctx, through.scope, dropsTag, (inner) =>
      through.reader.read(inner),
    );
  }

  function* abandon(ctx: JsonReadContext): Task<undefined> {
    yield* skipNextValue(ctx);
    return undefined;
  }

  function* tagged(ctx: JsonReadContext, lead: Lead): Task<unknown> {
    if (
      yield* refusesScope(
        ctx,
        lead,
        name,
        `is ${boundary.describe}, whose value is read in the scope its schema states and never one the data ` +
          'names (§8.6)',
      )
    ) {
      return undefined;
    }
    const tag = lead.type;
    if (tag === undefined) {
      if (lead.typed) {
        ctx.report(
          'TYPE_MISMATCH',
          "this object leads with this encoding's annotation members but no '$type' naming a type (§3.3)",
          "a '$type' member holding a type name",
          'no $type',
        );
      } else {
        // A bare `$value`: resolver category, as every misplaced annotation member is here (`tagMembers.ts`).
        ctx
          .field(VALUE)
          .report(
            'UNKNOWN_TYPE_REF',
            "'$value' belongs to an annotation object in wrapper form, which leads with '$type' naming the " +
              "value's type (§3.3)",
            "'$value' straight after a leading '$type'",
            VALUE,
          );
      }
      return yield* abandon(ctx);
    }
    const through = admitted.get(tag);
    if (through === undefined) {
      // At the value and not at `/$type`, as every tag refusal here is: §9.4 holds both encodings to one pointer for
      // a rule they share, and TSON's tag has no pointer step of its own.
      if (!nameHygieneRefuses(ctx, tag)) {
        const among = selectsNone.get(tag);
        ctx.report(
          outer.has(tag) ? 'TYPE_MISMATCH' : 'UNKNOWN_TYPE_REF',
          among === undefined
            ? refusal(tag)
            : `'${tag}' is a subtype of more than one variant of the choice a '${name}' position is, which is ` +
                `${boundary.describe} -- [${among.join(', ')}] -- and names none of them, so it selects none ` +
                '([TSON-SCHEMA] §5.4, §7.9)',
          admissible,
          tag,
        );
      }
      return yield* abandon(ctx);
    }
    if (through.namesASubtype) {
      ctx.report(
        'TYPE_MISMATCH',
        `a tag naming '${tag}' selects nothing -- ${abstractNamed(tag)}`,
        offered,
        tag,
      );
      return yield* abandon(ctx);
    }
    if (lead.wrapper || !through.record) {
      return yield* readWrapped(
        ctx,
        { read: (inner) => cross(inner, through, false) },
        through.keyed,
      );
    }
    return yield* cross(ctx, through, true);
  }

  const reader: JsonTypeReader & ExactReader = {
    *read(given: JsonReadContext): Task<unknown> {
      const ctx = given.underDeclaration(location);
      if (!mapTyped && (yield* ctx.peek()).kind === 'object-start') {
        const lead = yield* leadOf(ctx);
        if (leadPresent(lead)) return yield* tagged(ctx, lead);
      }
      if (own.namesASubtype) {
        ctx.report(
          'TYPE_MISMATCH',
          `'${name}' takes a value that names its type -- ${abstractNamed(name)}`,
          offered,
          '(no tag)',
        );
        return yield* abandon(ctx);
      }
      return yield* cross(ctx, own, false);
    },
    /** Reached by a dispatcher that matched this extern's name: the whole annotation object, its tag judged again. */
    *readExact(ctx: JsonReadContext): Task<unknown> {
      return mapTyped ? yield* readWrapped(ctx, reader, true) : yield* reader.read(ctx);
    },
    takesWrapper: true,
  };
  return reader;
}
