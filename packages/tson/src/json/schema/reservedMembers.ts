/**
 * [TSON-JSON] §3.2's reserved member namespace, and the peek at an object's leading members that
 * every dispatcher in this directory ({@link ./dispatchTag.js}, {@link ./dispatchMember.js},
 * {@link ./dispatchChoice.js}) decides from. Ported from the Java reference's `ReservedMembers`
 * (`tson-json/.../reader/ReservedMembers.java`); see that file's own doc for the exhaustive
 * rationale, restated here only where this port differs.
 *
 * **Named for the namespace it reads, not for the spec's own "annotation object" noun** — this
 * port's `Annotations`/`@name` vocabulary (`annotations/`, `tree/nodes.ts`) means one specific
 * thing already, and it has no JSON carrier at all (§4.3), so a module named for §3.3 would be the
 * one place "annotation" meant something else. This module reads §3.2's `$`-namespace and cites
 * §3.3 throughout for what that namespace carries.
 *
 * **The selectors lead, so a bounded peek answers the question.** §3.3 puts `$schema` first where
 * present and `$type` after it; §6.1.5 puts a sealed position's discriminators next, in any order
 * among themselves. {@link lead} reads exactly that many members and rewinds
 * (`json/readContext.ts`'s own {@link lookingAhead}), so what a reader holds before dispatch is a
 * count the schema fixes ([TSON-JSON] §10.1), never one the document chooses. A selector's value is
 * captured only when it is a scalar (string/number/boolean/null) — one that is not stops the peek,
 * matching the Java reference's own `isScalar` gate.
 *
 * **Every refusal this module reports is `UNRECOGNIZED_FIELD`.** §3.2/§3.3's own prose calls a
 * misplaced or unknown reserved member "a resolver error" (as it calls every rule that stops a
 * schema-governed value from being read at all), but that prose category and this codebase's own
 * `DiagnosticCode` taxonomy are two different things: `UNRECOGNIZED_FIELD` files under
 * `test/conformance/validate.ts`'s `VALIDATION_CODES`, and so does the reference implementation's
 * own `categoryOf` (`Class2ConformanceSuiteTest.java`) — the Java reference reports the identical
 * case with the identical code, `ReservedMembers.refuseUnknown`/`refuseMisplaced`. A `DiagnosticCode`
 * names *which rule fired*, not a commitment to §8.1's four-category framework, and that framework
 * is RUNNER.md's own contract for the Class 2 schema/link layer specifically — a governing schema
 * failing to load — which a namespace violation inside an already-loaded document's own value is
 * not. `UNRECOGNIZED_FIELD` is the accurate code either way: the name has no home in the object,
 * exactly what that code's own doc (`core/diagnostic.ts`) says, whether the reason is §6.1.1's
 * ordinary closure test or §3.2's reserved-namespace test running first and instead of it.
 */
import type { Task } from '../../io/bytes.js';
import { toNfc } from '../../unicode/nfc.js';
import { lookingAhead, type JsonReadContext } from '../readContext.js';
import type { JsonEvent } from '../stream.js';
import { skipNextValue } from './eventSkip.js';
import type { JsonTypeReader } from './types.js';

/** §3.2's closed set. */
export const SCHEMA = '$schema';
export const TYPE = '$type';
export const VALUE = '$value';
export const RESERVED: readonly string[] = [SCHEMA, TYPE, VALUE];

const EMPTY_SET: ReadonlySet<string> = new Set();
const EMPTY_MAP: ReadonlyMap<string, JsonEvent> = new Map();

/**
 * What an object's leading members say about it.
 *
 * @param schema whether `$schema` leads — never admitted by anything this package reads (§8.5's
 *   scoped positions are a recorded gap, `json/schema/compile.ts`'s own top note)
 * @param typed whether a `$type` member leads, whatever its value
 * @param type that member's string content, or `undefined` where it is absent or not a string
 * @param wrapper whether `$value` follows the reserved members — §3.3's wrapper form
 * @param selectors the scalar value of each requested member found leading after the reserved
 *   ones, by NFC name; a requested member not among them is absent here
 */
export interface Lead {
  readonly schema: boolean;
  readonly typed: boolean;
  readonly type: string | undefined;
  readonly wrapper: boolean;
  readonly selectors: ReadonlyMap<string, JsonEvent>;
}

export const NO_LEAD: Lead = {
  schema: false,
  typed: false,
  type: undefined,
  wrapper: false,
  selectors: EMPTY_MAP,
};

/** Whether `lead` opens a §3.3 reading at all — the recognition test itself (§3.3, §8.3.1). */
export function leadPresent(lead: Lead): boolean {
  return lead.schema || lead.typed || lead.wrapper;
}

function isScalarEvent(event: JsonEvent): boolean {
  return (
    event.kind === 'string' ||
    event.kind === 'number' ||
    event.kind === 'boolean' ||
    event.kind === 'null'
  );
}

/** Steps past a scalar member value under `ahead`, answering `false` — and consuming nothing — where the peeked value is not one. */
function* skipScalar(ahead: JsonReadContext): Task<boolean> {
  const peeked = yield* ahead.peek();
  if (!isScalarEvent(peeked)) return false;
  yield* ahead.next();
  return true;
}

function isMemberNamed(
  event: JsonEvent,
  name: string,
): event is JsonEvent & { kind: 'member-name' } {
  return event.kind === 'member-name' && event.name === name;
}

/**
 * The leading reserved members (and, where `wanted` names any, the leading selectors after them)
 * of the object at `ctx`'s cursor — `NO_LEAD` where `ctx` is not positioned at an `object-start`.
 * Always a peek: every event consumed while deciding is rewound (`lookingAhead`), so whichever
 * reader is selected next sees the object exactly as if this had never run.
 */
export function* lead(ctx: JsonReadContext, wanted: ReadonlySet<string> = EMPTY_SET): Task<Lead> {
  return yield* lookingAhead(ctx, function* (ahead): Task<Lead> {
    const opening = yield* ahead.next();
    if (opening.kind !== 'object-start') return NO_LEAD;

    let schema = false;
    let typed = false;
    let type: string | undefined;
    let event = yield* ahead.next();

    if (isMemberNamed(event, SCHEMA)) {
      schema = true;
      if (!(yield* skipScalar(ahead))) {
        return {
          schema: true,
          typed: false,
          type: undefined,
          wrapper: false,
          selectors: EMPTY_MAP,
        };
      }
      event = yield* ahead.next();
    }
    if (isMemberNamed(event, TYPE)) {
      typed = true;
      const peeked = yield* ahead.peek();
      type = peeked.kind === 'string' ? peeked.value : undefined;
      if (!(yield* skipScalar(ahead))) {
        return { schema, typed: true, type: undefined, wrapper: false, selectors: EMPTY_MAP };
      }
      event = yield* ahead.next();
    }
    if (isMemberNamed(event, VALUE)) {
      return { schema, typed, type, wrapper: true, selectors: EMPTY_MAP };
    }

    const selectors = new Map<string, JsonEvent>();
    while (selectors.size < wanted.size && event.kind === 'member-name') {
      const name = toNfc(event.name);
      const value = yield* ahead.peek();
      if (!wanted.has(name) || selectors.has(name) || !isScalarEvent(value)) break;
      selectors.set(name, value);
      yield* ahead.next(); // the value just peeked
      event = yield* ahead.next(); // the next member-name, or whatever follows
    }
    return { schema, typed, type, wrapper: false, selectors };
  });
}

/** Whether `name` is one this encoding reserves — true of any `$`-initial name, closed set or not (§3.2). */
export function isReservedName(name: string): boolean {
  return name.startsWith('$');
}

// ── The wrapper form, read ──────────────────────────────────────────────────────────────────

/**
 * §3.3's wrapper form, read from `ctx`'s cursor (an `object-start` not yet consumed): the
 * annotated value is the `$value` member, read at `target` — the reader `$type` selected, or the
 * position's own reader for a redundant restatement. Walks the object rather than assuming
 * `$value` comes last (§6.1.6: member order carries no meaning), and any member other than the
 * three reserved names is a resolver error — "the wrapper is apparatus, not a record".
 */
export function* readWrapped(ctx: JsonReadContext, target: JsonTypeReader): Task<unknown> {
  yield* ctx.next(); // object-start
  return yield* walkWrapper(ctx, target, SCHEMA, false, undefined);
}

/**
 * The rest of a wrapper whose leading members a caller has already read and whose `$value` name it
 * has just consumed — for a record reader that met `$value` straight after its own leading,
 * redundant `$type` (`json/schema/record.ts`'s own use).
 */
export function* readWrappedValue(ctx: JsonReadContext, target: JsonTypeReader): Task<unknown> {
  const value = yield* target.read(ctx.field(VALUE));
  return yield* walkWrapper(ctx, target, undefined, true, value);
}

function* walkWrapper(
  ctx: JsonReadContext,
  target: JsonTypeReader,
  next: string | undefined,
  foundValue: boolean,
  value: unknown,
): Task<unknown> {
  let found = foundValue;
  let awaiting = next;
  for (;;) {
    const event = yield* ctx.next();
    if (event.kind === 'object-end') {
      if (!found) {
        ctx.report(
          'TYPE_MISMATCH',
          "this is an annotation object in wrapper form and carries no '$value' to annotate",
          "a '$value' member",
          'no $value',
        );
        return undefined;
      }
      return value;
    }
    if (event.kind !== 'member-name') {
      throw new Error(`a member name or '}' was due and the stream produced '${event.kind}'`);
    }
    const name = event.name;
    if (name === VALUE) {
      if (found) {
        // §3.1/§9.1: two members of one object sharing a name is a resolver error at the repeat,
        // whatever the name -- `record.ts`'s own field loop reports this same code for a repeated
        // declared field, and a repeated `$value` is the wrapper's own version of it: reading and
        // discarding the first `$value` silently in favour of the second would decode the document
        // to something other than what it states.
        ctx
          .field(name)
          .report(
            'DUPLICATE_FIELD',
            `'${VALUE}' is written more than once in this annotation object`,
            'each reserved member written at most once',
            VALUE,
          );
        yield* skipNextValue(ctx.field(name));
        continue;
      }
      value = yield* target.read(ctx.field(VALUE));
      found = true;
      awaiting = undefined;
      continue;
    }
    const leading = !found && awaiting !== undefined && (name === awaiting || name === TYPE);
    awaiting = leading && name === SCHEMA ? TYPE : undefined;
    if (name === SCHEMA || name === TYPE) {
      if (!leading) refuseMisplaced(ctx, name);
    } else if (isReservedName(name)) {
      refuseUnknown(ctx, name);
    } else {
      ctx
        .field(name)
        .report(
          'UNRECOGNIZED_FIELD',
          `'${name}' stands beside '$value' in an annotation object, which is apparatus and not ` +
            `a record (§3.3) -- it admits the reserved members and nothing else`,
          RESERVED.join(' | '),
          name,
        );
    }
    yield* skipNextValue(ctx.field(name));
  }
}

/**
 * Reports a `$schema` or `$type` that does not lead its object (§3.3, `UNRECOGNIZED_FIELD` — this
 * module's own top note on the code): the selectors have a fixed place so that no decoder holds
 * more than the schema bounds before dispatch.
 */
export function refuseMisplaced(ctx: JsonReadContext, name: string): void {
  ctx
    .field(name)
    .report(
      'UNRECOGNIZED_FIELD',
      `'${name}' must lead its object -- '$schema' first where present, then '$type' (§3.3) -- ` +
        'and here it follows another member',
      `'${name}' as a leading member`,
      name,
    );
}

/**
 * Reports a `$`-initial member outside §3.2's closed set (`UNRECOGNIZED_FIELD` — this module's own
 * top note on the code): the name is not a declared field (no identifier begins with `$`, §3.2)
 * and not one of the three reserved names either, so §6.1.1's ordinary closure test never gets to
 * run on it at all — §3.2's reserved-namespace test runs first and in its place.
 */
export function refuseUnknown(ctx: JsonReadContext, name: string): void {
  ctx
    .field(name)
    .report(
      'UNRECOGNIZED_FIELD',
      `'${name}' begins with '$', which this encoding reserves (§3.2), and the reserved set is closed`,
      RESERVED.join(' | '),
      name,
    );
}
