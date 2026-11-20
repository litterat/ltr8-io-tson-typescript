/**
 * The position an extern types ([TSON-SCHEMA] §5.13): the boundary between the scope that holds a value and the
 * foreign schema's, which the value's body is read in (§7.9).
 *
 * **The tag and the annotations in front of the value are the enclosing scope's.** They are read here, against this
 * namespace, before the value crosses. The tag selects how the value crosses -- a name of this scope reaching the
 * target, a subtype or a variant of it, judged of the entries by identity (`link/externAdmission.ts`) -- and a
 * foreign reader reads the rest, untagged, as that entry: handing it a foreign name instead would refuse what the
 * boundary admitted wherever the target takes no tag of its own name, a choice or a member-dispatched base.
 *
 * **The body is read by a foreign schema's own compiled reader**, so nothing re-resolves a name per scope: every
 * name inside resolves in that schema's namespace. The cursor, receiver, limits and data path are the document's
 * (`reader/context.ts`'s `readingAcross`), the schema location restarts inside, and every diagnostic raised there
 * names the foreign schema and the extern.
 *
 * **A tree value at the boundary carries the outer name** -- the tag written, else the extern -- so a writer writes
 * back a tag the enclosing scope admits; the names inside stay the foreign schema's.
 *
 * Tree mode only: binding a foreign value to host classes is not implemented, and reported as such.
 */
import type { Task } from '../io/bytes.js';
import type { SchemaLocation } from '../core/diagnostic.js';
import type { Annotations } from '../annotations/index.js';
import type { ReadContext, TypeReader } from '../reader/contracts.js';
import { readingAcross } from '../reader/context.js';
import type { ForeignScope } from '../link/foreignScope.js';
import { captureAnnotations } from '../reader/tree/annotations.js';
import { skipCoreValue } from '../reader/tree/grammar.js';
import { abandonedValue } from '../reader/tree/support.js';
import type { Top } from '../schema/meta/typedef.js';
import type { Value } from '../tree/nodes.js';
import { describeExtern } from '../link/externs.js';
import { externAdmission, namesASubtype } from '../link/externAdmission.js';
import { declaringIdentity, landingDefinition, type Landing } from '../link/externTarget.js';
import type { LinkedSchema } from '../link/link.js';
import { canonicalizeIdentity } from '../link/identity.js';

/**
 * How a value crosses through one extern: the foreign entry's reader, which reads the value untagged as that entry,
 * the scope it is read in, and whether the entry is abstract with no selectors, where a value must name a subtype.
 */
export interface Crossing {
  readonly reader: TypeReader<Value>;
  readonly scope: ForeignScope;
  /** Where the value is read in the foreign schema: the entry it crosses as, which seeds the schema location. */
  readonly location: SchemaLocation;
  readonly namesASubtype: boolean;
}

/** Where a boundary obtains the compiled readers of a schema a foreign value is read in (§7.9). */
export interface ForeignReaders {
  /** `linked`'s reader of `name`, `linked` compiled once per compile. */
  reader(linked: LinkedSchema, name: string): TypeReader<Value>;
  /** The reader of `name` in the schema of canonical identity `identity`, or `undefined` where none can be obtained. */
  readerIn(identity: string, name: string): TypeReader<Value> | undefined;
}

/**
 * The boundary at a position typed by the extern `name` of `linked` (§7.9): every name of this namespace that
 * reaches, past its alias chain and its externs, the entry `name` lands on or one it admits -- one IS-A it, §7.2's
 * subsumption, or a variant of it where it is a choice -- each with the foreign reader it crosses through.
 * `undefined` where the extern is attached to nothing, which a linked schema never holds.
 */
export function externBoundary(
  linked: LinkedSchema,
  name: string,
  location: SchemaLocation,
  foreign: ForeignReaders,
): TypeReader<Value> | undefined {
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
    return {
      reader: foreign.reader(target.foreign, target.type),
      // The scope is the foreign schema's, whose namespace the names inside resolve in.
      scope: scopeOf(extern, canonicalizeIdentity(target.foreign.id)),
      location: locationIn(target.foreign, target.type),
      namesASubtype: namesASubtype(landingDefinition(landing)),
    };
  };
  const own = crossing(name, admission.landing);
  // A name of this scope that is no extern and reaches an entry narrower than the target is read in the position's
  // foreign schema, or in the namespace its target lands in, where either holds that entry, else in the schema
  // declaring it.
  const imported = (entry: string, declaredBy: string, reached: Top): Crossing => {
    for (const within of [attached.foreign, admission.landing.in]) {
      if (within.entries.has(entry) && declaringIdentity(within, entry) === declaredBy) {
        return {
          reader: foreign.reader(within, entry),
          scope: scopeOf(name, canonicalizeIdentity(within.id)),
          location: locationIn(within, entry),
          namesASubtype: namesASubtype(reached),
        };
      }
    }
    return {
      reader: foreign.readerIn(declaredBy, entry) ?? unobtainable(entry, declaredBy),
      scope: scopeOf(name, declaredBy),
      location: { schemaId: declaredBy, pointer: `/${entry}` },
      namesASubtype: namesASubtype(reached),
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
  return externTreeReader({
    name,
    location,
    outer: linked.entries,
    describe: extern?.kind === 'extern' ? describeExtern(extern) : 'an extern',
    own,
    admitted,
    selectsNone: admission.selectsNone,
    narrower: narrower.join(' | '),
  });
}

/** `name`'s location in `linked`, the schema declaring it and its path there, with its source position where known. */
function locationIn(linked: LinkedSchema, name: string): SchemaLocation {
  const position = linked.facts.get(name)?.position;
  return {
    schemaId: declaringIdentity(linked, name),
    pointer: `/${name}`,
    ...(position === undefined ? {} : { position }),
  };
}

/** A reader for an entry no schema this compile can obtain declares: reported as not implemented, never a verdict. */
function unobtainable(entry: string, identity: string): TypeReader<Value> {
  return {
    *read(ctx: ReadContext): Task<Value> {
      ctx.report(
        'NOT_IMPLEMENTED',
        `'${entry}' reaches '${identity}#${entry}', which a compile with no registry cannot read in its own ` +
          "schema's scope ([TSON-SCHEMA] §7.9)",
        'a schema this compile can obtain',
        entry,
      );
      yield* skipCoreValue(ctx);
      return abandonedValue();
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
}

function externTreeReader(boundary: Boundary): TypeReader<Value> {
  const { name, location, outer, own, admitted, selectsNone, narrower } = boundary;
  const admissible = [...admitted.keys()].join(' | ');

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

  function* abandon(ctx: ReadContext): Task<Value> {
    yield* skipCoreValue(ctx);
    return abandonedValue();
  }

  return {
    *read(given: ReadContext): Task<Value> {
      const ctx = given.underDeclaration(location);
      const leading = yield* captureAnnotations(ctx);
      // The annotations in front of a foreign value are the enclosing scope's (§7.9): each names a type there.
      for (const annotation of leading.values) {
        if (outer.has(annotation.name)) continue;
        ctx.report(
          'UNKNOWN_TYPE_REF',
          `'@${annotation.name}' names no type of the enclosing scope, and the annotations in front of a value at ` +
            `a '${name}' position, which is ${boundary.describe}, are read there, not in the foreign schema ` +
            '([TSON-SCHEMA] §6, §7.9)',
          'an annotation naming a type of the enclosing scope',
          `@${annotation.name}`,
        );
        return yield* abandonAfterTag(ctx);
      }
      let through = own;
      let outerName = name;
      const peeked = yield* ctx.peek();
      if (peeked.kind === 'type-ref') {
        yield* ctx.next();
        const tag = peeked.name;
        const found = admitted.get(tag);
        if (found === undefined) {
          const among = selectsNone.get(tag);
          ctx.report(
            outer.has(tag) ? 'TYPE_MISMATCH' : 'UNKNOWN_TYPE_REF',
            among === undefined
              ? refusal(tag)
              : `'${tag}' is a subtype of more than one variant of the choice a '${name}' position is, which is ` +
                  `${boundary.describe} -- [${among.join(', ')}] -- and names none of them, so it selects none ` +
                  '([TSON-SCHEMA] §5.4, §7.9)',
            admissible,
            `!${tag}`,
          );
          return yield* abandon(ctx);
        }
        if (found.namesASubtype) {
          ctx.report(
            'TYPE_MISMATCH',
            `a tag naming '${tag}' selects nothing -- ${abstractNamed(tag)}`,
            narrower === '' ? 'no tag this scope can write' : narrower,
            `!${tag}`,
          );
          return yield* abandon(ctx);
        }
        through = found;
        outerName = tag;
      } else if (own.namesASubtype) {
        ctx.report(
          'TYPE_MISMATCH',
          `'${name}' takes a value that names its type -- ${abstractNamed(name)}`,
          narrower === '' ? 'no tag this scope can write' : narrower,
          '(no tag)',
        );
        return yield* abandon(ctx);
      }
      const crossing = through;
      const read = yield* readingAcross(ctx, crossing.scope, (inner) =>
        crossing.reader.read(inner.underDeclaration(crossing.location)),
      );
      return named(read, outerName, leading);
    },
  };
}

/** Skips the rest of a value whose leading annotations were refused: its tag, if any, and its core value. */
function* abandonAfterTag(ctx: ReadContext): Task<Value> {
  const peeked = yield* ctx.peek();
  if (peeked.kind === 'type-ref') yield* ctx.next();
  yield* skipCoreValue(ctx);
  return abandonedValue();
}

/**
 * `value`, a tree read at the boundary, named by this scope's name for it and carrying the annotations written in
 * front of it, which the outer scope reads back; the names inside stay the foreign schema's.
 */
function named(value: Value, outerName: string, leading: Annotations): Value {
  // An abandoned read is carried as `undefined` (`abandonedValue`), and stays so.
  const read = value as Value | undefined;
  if (read === undefined || read.kind === 'missing') return value;
  return {
    ...read,
    typeRef: outerName,
    annotations: leading.values.length === 0 ? read.annotations : leading,
  };
}
