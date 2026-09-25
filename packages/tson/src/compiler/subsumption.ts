/**
 * §7.2's rule that a value's own type annotation must be admitted by the position it stands in:
 * "at a position whose declared type is `T`, a value annotated `!S` is valid if and only if,
 * after following the reference chain of both (§8.3) to its terminal, `S` is `T` or `T` appears
 * in `S`'s transitive `type_definition.supertypes`". Ported from the reference implementation's
 * `Subsumption` (`tson-compiler/.../reader/Subsumption.java`) and the dispatch half of its
 * `VariantSchemaReader`; see those files' own module docs for the exhaustive rationale.
 *
 * **The guard follows the body, not `definition.kind`.** {@link TypeDefinition.kind} and
 * {@link TypeDefinition.body} are two independent facts about one entry -- a hand-built entry can
 * carry a `ChoiceBody` while claiming `kind: 'PRODUCT'` -- and only an `Atom` or `Product` (record,
 * array, map, tuple) body takes this guard. §7.2 excludes every other shape by name: a `choice`
 * discriminates by variant membership (§5.4) and a `scoped` instance by its own value shape
 * (§7.8), each with its own dispatcher whose membership this guard must not override, and a value
 * is never typed by a `Reference` position at all -- every use site's own type resolves through
 * one to a terminal type before this guard is even built (§8.3).
 *
 * **An entry's aliases are the entry.** §7.2 compares "after following the chain of *both* to its
 * terminal", so `!created` at a `created`-typed position, where `created => event_created`
 * aliases another entry, names the position's own type even though the reader running there
 * belongs to `event_created`'s own instantiation. The accepted set -- `name` plus every entry
 * whose own chain terminates at it -- is computed once, at compile time, since the reader itself
 * cannot know which of its aliases a given position was written as.
 *
 * **§5.2's three readings of an unannotated/annotated value at an ABSTRACT position** are this
 * module's other half, alongside the ordinary tag dispatch above (which still governs OPEN and
 * FINAL positions unchanged, and an ABSTRACT one with no `discriminators` past its own tag
 * requirement):
 *
 * - **No `discriminators`** (`body.discriminators.length === 0`): the base has no direct
 *   instances and names no selector field either, so the tag is the only way a value can ever be
 *   placed. The ordinary dispatch below is reused unchanged for the tagged case (a tag naming a
 *   subtype dispatches to it exactly as it would at an OPEN position) with two additions gated on
 *   `isAbstract`: an absent tag is a validation error rather than "the position's own type", and a
 *   tag naming the base itself (`own.has(annotated)`) is refused rather than admitted, since no
 *   value's effective type is ever the base (§5.2, §7.2's own "three readings").
 * - **Non-empty `discriminators`** ({@link buildMemberDispatchReader}): the value is placed by
 *   reading the marked field(s), not by a tag. **In text, a selector may arrive after the fields
 *   it selects** ([TSON-DATA] §2.5) -- a record's fields carry no significant order -- so this
 *   reader looks ahead over the *whole* record before it can decide anything, via
 *   `reader/context.ts`'s existing {@link lookingAhead} mechanism (the same one
 *   `compiler/choiceReader.ts` already uses for its own, shallower type-ref lookahead) rather than
 *   a second lookahead mechanism. **Memory there is bounded by one record's own size, not by
 *   depth**: the lookahead consumes and rewinds exactly the fields of the one record a
 *   member-dispatched position governs, never descending into a nested container's own contents
 *   (an unrelated field's value is discarded whole via {@link skipScopedValue}, not read into).
 *   Every discriminator token the lookahead finds is captured raw, then decoded, outside the
 *   lookahead, through the BASE's own declared type for that field -- "the pin and the member's
 *   value are decoded by the same parser before either is compared" (§4.3), which is what lets
 *   `= 0xFF` and a document's `255` collide correctly rather than by spelling. **Decoding never
 *   happens inside the lookahead itself**, only after it returns: a `TypeReader` invoked mid-
 *   lookahead could report a diagnostic that the real read then reported again once it reached
 *   the same token for real, and {@link readSchemaLiteral}'s own isolated, throwing context (the
 *   same one that decodes a member's own pin at construction, {@link candidatePins}) reads a
 *   token against a type with no such side effect either way -- a token that fails to parse there
 *   is treated exactly like one this dispatch could not read at all (run the ordinary record
 *   reader, whose own read reports the real problem through the real context). **That reader's
 *   own clean success is not this dispatch's to accept, though**: `name` is ABSTRACT, so a value
 *   this dispatch could not place among the family is refused even where the ordinary reader
 *   would have parsed it outright -- {@link buildMemberDispatchReader}'s own note has the
 *   checkpoint. The lookahead itself skips a discriminator's own leading annotations/`!type-ref`
 *   before checking for its plain token, so a self-annotated or redundantly self-tagged selector
 *   still dispatches; only a genuinely non-scalar shape falls through to the ordinary reader.
 */
import type { Task } from '../io/bytes.js';
import { TsonInternalError } from '../core/errors.js';
import type { ReadContext, TypeReader } from '../reader/contracts.js';
import { lookingAhead } from '../reader/context.js';
import {
  skipAnnotations,
  skipAnnotationsAndTypeRef,
  skipCoreValue,
  skipDataValue,
  skipScopedValue,
  typeRefAhead,
} from '../reader/tree/grammar.js';
import type { RecordBody, RecordField } from '../schema/meta/bodies.js';
import type { Token, Top, TypeDefinition } from '../schema/meta/typedef.js';
import { isTemplateBody } from '../schema/meta/typedef.js';
import type { Value } from '../tree/nodes.js';
import { valuesEqual } from '../reader/tree/equality.js';
import { abandonedValue, readSchemaLiteral } from '../reader/tree/support.js';
import { isAtom } from './atomChecks.js';
import { directMembers, type Member } from '../link/recordExtension.js';
import { selfNames, terminal } from '../link/referenceChain.js';
import { metaFormOfLexer } from './tokenForms.js';

const PRODUCT_KINDS: ReadonlySet<string> = new Set(['record', 'array', 'map', 'tuple']);

/**
 * Whether `body` is `Atom`- or `Product`-shaped, or a record-bodied template family base --
 * the bodies §7.2's rule governs. A family base (§5.10) is the one `TemplateBody` shape this rule
 * reaches: it may be named bare at a type position, and a position typed by one dispatches exactly
 * as an ABSTRACT record's own does, over its instantiations.
 */
function isGuardedBody(body: Top): boolean {
  if (isAtom(body)) return true;
  if ('kind' in body) return PRODUCT_KINDS.has(body.kind);
  return isTemplateBody(body) && body.extension !== undefined;
}

/** `Top`'s open `Data.kind: string` member defeats a plain `'kind' in body && body.kind === 'record'` narrowing (`compiler/compile.ts`'s own note); this guard is this module's own copy. */
function isRecordBody(body: Top): body is RecordBody {
  return 'kind' in body && body.kind === 'record';
}

/**
 * `reader` guarded by §7.2, or `reader` unchanged where the body it was built for is not one the
 * rule governs ({@link isGuardedBody}). `entries` is the whole linked schema's own namespace
 * (imports merged, §2.2.3), consulted only to compute {@link selfNames} -- the same set every
 * position built against this `name` shares, so `entries` is expected to be the caller's
 * whole-schema map rather than one recomputed per call.
 *
 * A value with no leading `!type-ref`, or one naming a member of `selfNames`, reads straight
 * through `reader` -- the position's own type is always admitted (§7.2's "S is T"). A value naming
 * one of `definition.subtypes` dispatches to that subtype's own compiled reader via `resolve`,
 * read against the same, still-unconsumed value. Anything else is a refusal, split on whether the
 * written name denotes anything in `entries` at all: one `entries` has no entry for is
 * `UNKNOWN_TYPE_REF` (§7.2's own opening paragraph -- "a built-in annotation name not defined by
 * the active schema is an unresolved-type error" -- generalised past built-ins to any name this
 * schema's namespace does not contain, and `typeRefCheck.ts`'s own top note on the same code for
 * the schemaless path); one that resolves to a real entry this position simply does not admit is
 * `TYPE_MISMATCH`, with a message distinguishing a position whose type has no subtypes at all from
 * one whose subtypes just don't include what was named. Either way the whole value is discarded,
 * since nothing consumed it. **This reads §7.2 rather than the reference's own
 * `SubsumptionDiagnostics`/`VariantSchemaReader`, which report `TYPE_MISMATCH` unconditionally and
 * never consult whether the name resolves elsewhere** -- a divergence this port takes deliberately
 * (worth raising upstream) rather than silently, since §7.2's two-step reading ("resolve, then
 * admit") is what the spec text actually states.
 *
 * **An ABSTRACT position takes this module's other branch** (see this file's own top note): with
 * `discriminators`, every read goes through {@link buildMemberDispatchReader} instead of the tag
 * dispatch below; without any, the tag dispatch below still runs, gaining two ABSTRACT-only
 * refusals (an absent tag, and one naming the base itself).
 */
export function guardSubsumption(
  name: string,
  definition: TypeDefinition,
  reader: TypeReader<Value>,
  entries: ReadonlyMap<string, TypeDefinition>,
  resolve: (name: string) => TypeReader<Value>,
): TypeReader<Value> {
  if (!isGuardedBody(definition.body)) {
    return reader;
  }
  const own = selfNames(name, entries);
  const subtypeNames = definition.subtypes;
  // §7.2 follows BOTH chains: the position's own type through `selfNames`, and the annotated name
  // through the same walk. The set is keyed on terminals so that `!d_alias` is admitted wherever
  // the entry it aliases is -- an alias is a hop, not a different type (§8.3) -- while the
  // diagnostic below still names the annotation the author actually wrote.
  const subtypeTerminals = new Map(
    subtypeNames.map((subtype) => [terminal(subtype, (n) => entries.get(n)), subtype] as const),
  );
  const subtypeList = subtypeNames.join(', ');
  const recordBody = isRecordBody(definition.body) ? definition.body : undefined;
  // §5.10: a record-bodied template's own (open) entry carries the same two facts on its
  // `TemplateBody` wrapper instead of on a `RecordBody` -- `isGuardedBody` above is what let one
  // reach this function at all.
  const isTemplateFamily = recordBody === undefined && isTemplateBody(definition.body);
  const isAbstract = recordBody?.extension === 'ABSTRACT' || isTemplateFamily;
  // A template family base's own `discriminators` mirrors a record base's (§5.10); it has no
  // reader of its own for `buildMemberDispatchReader`'s fallback to run (a template is never read
  // as itself), where a record base offers its ordinary record reader.
  const discriminators =
    recordBody?.discriminators ??
    (isTemplateFamily && isTemplateBody(definition.body) ? definition.body.discriminators : []) ??
    [];

  if (discriminators.length > 0) {
    return buildMemberDispatchReader(
      name,
      discriminators,
      recordBody?.fields,
      recordBody !== undefined ? reader : undefined,
      entries,
      own,
      resolve,
    );
  }

  return {
    *read(ctx: ReadContext): Task<Value> {
      const ref = yield* typeRefAhead(ctx);
      if (ref === undefined) {
        if (isAbstract) {
          const remedy =
            subtypeNames.length === 0
              ? `no schema in this closure declares a subtype of '${name}' -- the schema that ` +
                'does is missing from the imports'
              : `an untagged value is never one of (${subtypeList})`;
          ctx.report(
            'VALIDATION_ERROR',
            `a value at '${name}' needs a '!type-ref' -- '${name}' is abstract and has no direct ` +
              `instances (§5.2), so ${remedy}`,
            subtypeNames.length === 0 ? `a subtype of '${name}'` : `one of (${subtypeList})`,
            '(no type annotation)',
          );
          yield* skipDataValue(ctx);
          return abandonedValue();
        }
        return yield* reader.read(ctx);
      }
      if (own.has(ref)) {
        if (isAbstract) {
          return yield* refuseTaggedBase(ctx, name, ref, subtypeList, subtypeNames.length === 0);
        }
        return yield* reader.read(ctx);
      }
      const annotated = terminal(ref, (n) => entries.get(n));
      if (own.has(annotated)) {
        if (isAbstract) {
          return yield* refuseTaggedBase(ctx, name, ref, subtypeList, subtypeNames.length === 0);
        }
        return yield* reader.read(ctx);
      }
      const subtype = subtypeTerminals.get(annotated);
      if (subtype !== undefined) {
        return yield* resolve(subtype).read(ctx);
      }
      // §7.2's own opening paragraph resolves a type annotation in two steps, and this is the
      // second: "all type annotations MUST resolve through the schema's type-name namespace; a
      // built-in annotation name not defined by the active schema is an unresolved-type error" is
      // the first (the name must denote *something* the schema declares), and subsumption -- is
      // the denoted type admitted here -- is the second, asked only once the first holds. A name
      // `entries` has no entry for at all fails the first step and is `UNKNOWN_TYPE_REF`
      // ("the name denotes nothing", `typeRefCheck.ts`'s own top note, restated for the
      // schema-directed path this comment is on); a name that resolves to a real entry the
      // position simply does not admit fails only the second and is `TYPE_MISMATCH`. The
      // reference's own `SubsumptionDiagnostics`/`VariantSchemaReader` report `TYPE_MISMATCH`
      // unconditionally here and never make this split -- see this port's own spec-feedback note
      // on the divergence -- but §7.2's text states the two-step rule plainly, and doing otherwise
      // would mean a name that resolves nowhere in this schema at all is validated as though the
      // schema had a considered opinion about it, which it never formed.
      const resolves = entries.has(annotated);
      ctx.report(
        resolves ? 'TYPE_MISMATCH' : 'UNKNOWN_TYPE_REF',
        resolves
          ? subtypeNames.length === 0
            ? `'!${ref}' is not valid at a '${name}' position -- a type annotation must name the ` +
              `position's own type, which has no subtypes (§7.2)`
            : `'!${ref}' is not a known subtype of '${name}' (§7.2) -- expected one of (${subtypeList})`
          : `'!${ref}' does not resolve in the governing schema's namespace (§7.2) -- expected ` +
              (subtypeNames.length === 0 ? `'${name}'` : `one of (${subtypeList})`),
        subtypeNames.length === 0 ? `'${name}'` : `one of (${subtypeList})`,
        `!${ref}`,
      );
      yield* skipDataValue(ctx); // framing included: nothing consumed it, this value being unreadable
      return abandonedValue();
    },
  };
}

/** §5.2: "a tag naming the base itself is refused, no value satisfying it" -- shared by both the no-`discriminators` and the member-dispatch branches. */
function* refuseTaggedBase(
  ctx: ReadContext,
  name: string,
  ref: string,
  subtypeList: string,
  noSubtypes: boolean,
): Task<Value> {
  ctx.report(
    'VALIDATION_ERROR',
    `'!${ref}' names '${name}' itself, but '${name}' is abstract and has no direct instances ` +
      `(§5.2) -- no value satisfies it; expected ${noSubtypes ? `a subtype of '${name}'` : `one of (${subtypeList})`}`,
    noSubtypes ? `a subtype of '${name}'` : `one of (${subtypeList})`,
    `!${ref}`,
  );
  yield* skipDataValue(ctx);
  return abandonedValue();
}

// ── Member dispatch (§5.2's discriminated family, non-empty `discriminators`) ──────────────────

/** One direct member, precompiled: its name and its own pin for each of the base's `discriminators`, in the base's own declaration order. `undefined` where a member fails to pin one -- excluded from dispatch entirely, since `link/recordExtension.ts` already refuses such a schema at link time and a reader reaching this point is trusting that verdict, not re-deriving it. */
interface DispatchCandidate {
  readonly name: string;
  readonly pins: readonly Value[];
}

/**
 * `member`'s own pin for each of `discriminators`, decoded through `fieldReaders` (one per
 * discriminator, all the BASE's own declared type -- see this file's own top note on why the
 * whole family is parsed with one set of readers) -- or `undefined` where `member` fails to pin
 * one, or its literal fails to parse against a type it was already checked to conform to at
 * schema load (§5.2's own eager-resolution rule). Either way `member` is excluded from dispatch
 * entirely: `link/recordExtension.ts` already refuses a schema whose members don't all pin, so a
 * reader reaching this point is trusting that verdict, not re-deriving it, and a decode failure
 * here can only mean a schema this build never linked.
 */
function candidatePins(
  discriminators: readonly string[],
  member: Member,
  fieldReaders: ReadonlyMap<string, TypeReader<Value>>,
): readonly Value[] | undefined {
  const pins: Value[] = [];
  for (const fieldName of discriminators) {
    const field = member.body.fields.find((candidate) => candidate.name === fieldName);
    const parser = fieldReaders.get(fieldName);
    if (field?.role !== 'FIXED' || field.value === undefined || parser === undefined) {
      return undefined;
    }
    try {
      pins.push(readSchemaLiteral(field.value, parser));
    } catch {
      return undefined;
    }
  }
  return pins;
}

function tuplesEqual(a: readonly Value[], b: readonly Value[]): boolean {
  return a.length === b.length && a.every((value, i) => valuesEqual(value, at(b, i)));
}

function at<T>(array: readonly T[], index: number): T {
  const value = array[index];
  if (value === undefined) {
    throw new TsonInternalError('internal error: tuplesEqual compared arrays of unequal length');
  }
  return value;
}

/**
 * The document's own raw token at `fieldName`, decoded through the same reader
 * {@link candidatePins} used for the member pins -- or `undefined` where it fails to parse (a
 * malformed value, which the fallback to the ordinary record reader reports properly, through the
 * real `ReadContext`, once this dispatch gives up on it rather than reporting it twice).
 */
function decodeDocumentToken(
  tokens: ReadonlyMap<string, Token>,
  fieldName: string,
  fieldReaders: ReadonlyMap<string, TypeReader<Value>>,
): Value | undefined {
  const token = tokens.get(fieldName);
  const parser = fieldReaders.get(fieldName);
  if (token === undefined || parser === undefined) return undefined;
  try {
    return readSchemaLiteral(token, parser);
  } catch {
    return undefined;
  }
}

/** One lookahead pass's own verdict: the value's own tag (if any), and every discriminator token the record stated as a plain value -- `undefined` for one this pass could not read as a plain token (omitted, written `_`, a nested shape, or the positional form of §5.6, which never reaches the record-shape check at all), which the caller reads as "run the ordinary record reader for its diagnostics, but its own success does not settle this dispatch". */
interface Lookahead {
  readonly tag: string | undefined;
  readonly tokens: ReadonlyMap<string, Token> | undefined;
}

/**
 * Builds the member-dispatch reader for `name`, an ABSTRACT base with a non-empty
 * `discriminators` (§5.2) -- a record base's own, or a record-bodied template family base's own
 * (§5.10), whose selector fields live only on its instantiations, never on the base itself.
 * `reader` is the base's own ordinary record reader where it has one, run whenever this dispatch
 * cannot determine a member on its own (see this file's own top note) so that a genuine defect --
 * a required field left out, `_` at a non-voidable field, a shape mismatch, a malformed atom -- is
 * reported through its own diagnostics (`FIELD_REQUIRED`, `ATOM_CONSTRAINT_VIOLATION`), the
 * library's one existing source of truth for those, rather than a second copy here. `undefined`
 * for a template family base, which has no record of its own to fall back to -- there is nothing
 * for `name` itself ever to have been (§5.10 never reads the held body), so a value this dispatch
 * cannot place goes straight to this function's own generic diagnostic. **A clean fallback success
 * is never handed back either way**: `name` is ABSTRACT, so no value's effective type is ever
 * `name` itself (§5.2, §7.2) -- a value this dispatch could not place among the family, but that
 * `reader` would otherwise accept outright (an annotated or otherwise decorated selector this
 * dispatch's own lookahead does not unwrap, the positional form, or simply no member at all in
 * this closure), is still refused, via the checkpoint at its one call site below.
 */
function buildMemberDispatchReader(
  name: string,
  discriminators: readonly string[],
  baseFields: readonly RecordField[] | undefined,
  reader: TypeReader<Value> | undefined,
  entries: ReadonlyMap<string, TypeDefinition>,
  own: ReadonlySet<string>,
  resolve: (name: string) => TypeReader<Value>,
): TypeReader<Value> {
  const discriminatorSet = new Set(discriminators);
  const members = directMembers(name, entries);
  // §5.2: "a decoder parses them with the one set of types it knows before dispatch" -- every
  // discriminator's reader is the family's own declared type, resolved once here and reused both
  // for every member's own pin (below) and for whatever the document states (read time). A record
  // base declares the field itself (`baseFields`), which also covers a family with no members yet
  // (§5.2's "empty family" case: there is nothing to scan, but there is still a base to read the
  // type from). A template family base declares no fields of its own (§5.10 never reads the held
  // body), so its selector's type is read off any member instead -- identical across every one by
  // §5.10's own condition on a selector (it mentions no type parameter, so substitution never
  // touches it).
  const fieldReaders = new Map(
    discriminators.map((fieldName) => {
      const typedField =
        baseFields?.find((candidate) => candidate.name === fieldName) ??
        members
          .map((member) => member.body.fields.find((candidate) => candidate.name === fieldName))
          .find((candidate) => candidate !== undefined);
      if (typedField === undefined) {
        throw new TsonInternalError(
          `internal error: '${name}' names '${fieldName}' in 'discriminators' but neither it nor ` +
            'any member of it declares such a field',
        );
      }
      return [fieldName, resolve(typedField.type.name)] as const;
    }),
  );
  const candidates: DispatchCandidate[] = [];
  for (const member of members) {
    const pins = candidatePins(discriminators, member, fieldReaders);
    if (pins !== undefined) candidates.push({ name: member.name, pins });
  }
  const memberList = candidates.map((c) => c.name).join(', ');
  const tuple =
    discriminators.length > 1
      ? `discriminators (${discriminators.join(', ')})`
      : `discriminator '${at(discriminators, 0)}'`;

  return {
    *read(ctx: ReadContext): Task<Value> {
      const lookahead = yield* lookingAhead(ctx, function* (aheadCtx): Task<Lookahead> {
        yield* skipAnnotations(aheadCtx);
        let tag: string | undefined;
        const tagPeek = yield* aheadCtx.peek();
        if (tagPeek.kind === 'type-ref') {
          tag = tagPeek.name;
          yield* aheadCtx.next();
        }
        const shapePeek = yield* aheadCtx.peek();
        if (shapePeek.kind !== 'record-start') {
          return { tag, tokens: undefined };
        }
        yield* aheadCtx.next();
        const tokens = new Map<string, Token>();
        for (;;) {
          const peeked = yield* aheadCtx.peek();
          if (peeked.kind === 'record-end') break;
          const fieldNameEvent = yield* aheadCtx.next();
          if (fieldNameEvent.kind !== 'field-name') {
            throw new TsonInternalError(
              `expected a field-name event while looking ahead over '${name}', found ` +
                `'${fieldNameEvent.kind}'`,
            );
          }
          if (discriminatorSet.has(fieldNameEvent.name) && !tokens.has(fieldNameEvent.name)) {
            const scopedPeek = yield* aheadCtx.peek();
            // No `!!schema` directive: a selector is never scoped (§5.2's own base-level checks
            // rule that out structurally), so a `schema-ref` here always belongs to some other
            // field's framing and this field is read the ordinary way, below. Otherwise a
            // discriminator's own leading `annotation* type-ref?` (§2.3-§2.4) is skipped before
            // looking for its plain token -- a self-annotation or a redundant `!type` on the
            // value (§7.2's "S is T") carries the same lexeme either way, and the pin comparison
            // below reads that lexeme through the BASE's own declared type regardless of how the
            // document happened to decorate it.
            if (scopedPeek.kind !== 'schema-ref') {
              yield* skipAnnotationsAndTypeRef(aheadCtx);
              const valuePeek = yield* aheadCtx.peek();
              if (valuePeek.kind === 'token') {
                yield* aheadCtx.next();
                tokens.set(fieldNameEvent.name, {
                  text: valuePeek.text,
                  form: metaFormOfLexer(valuePeek.form),
                });
                continue;
              }
              // Not a plain token even past its own framing (nested, `_`, `{}`) -- discard the
              // rest of its core-value; the framing already consumed is not re-skipped.
              yield* skipCoreValue(aheadCtx);
              continue;
            }
          }
          yield* skipScopedValue(aheadCtx);
        }
        yield* aheadCtx.next(); // record-end
        return { tag, tokens };
      });

      if (lookahead.tag !== undefined) {
        const annotated = terminal(lookahead.tag, (n) => entries.get(n));
        if (own.has(annotated)) {
          return yield* refuseTaggedBase(
            ctx,
            name,
            lookahead.tag,
            memberList,
            candidates.length === 0,
          );
        }
      }

      const tokens = lookahead.tokens;
      const documentPins =
        tokens === undefined ? undefined : decodeAll(discriminators, tokens, fieldReaders);
      if (documentPins === undefined) {
        // Missing, written '_', not a plain token, or one that failed to parse. The ordinary
        // record reader is run for its own diagnostics (a required field left out, '_' at a
        // non-voidable field, a shape mismatch, a malformed atom) -- but its own success is not
        // this dispatch's to accept: `name` is ABSTRACT (every reader reaching this branch was
        // built for one, §5.2), so no value's effective type is ever `name` itself (§7.2's
        // "three readings"). A clean parse that this dispatch could not place among the family's
        // members -- including the positional-form spelling of a single-selector base (§5.6),
        // which never reaches the record-shape check above at all -- is therefore still refused,
        // not silently admitted as the base. `ctx.reported()` is the checkpoint: it is monotonic
        // and receiver-agnostic (`reader/contracts.ts`'s own note), so it tells the two cases
        // apart without this reader knowing whether `reader` collects, streams, or throws.
        if (reader !== undefined) {
          const before = ctx.reported();
          const result = yield* reader.read(ctx);
          if (ctx.reported() > before) {
            return result;
          }
        } else {
          // A template family base has no reader of its own to fall back to (§5.10 never reads
          // the held body) -- nothing has consumed the value yet, so this dispatch does, the way
          // every other refusal in this function does.
          yield* skipDataValue(ctx);
        }
        ctx.report(
          'VALIDATION_ERROR',
          `'${name}' is abstract and has no direct instances (§5.2) -- its ${tuple} was not ` +
            'written plainly enough to place this value among its members (omitted, `_`, or not ' +
            `a plain token) -- expected ${
              candidates.length === 0 ? `a member of '${name}'` : `one of (${memberList})`
            }`,
          candidates.length === 0 ? `a member of '${name}'` : `one of (${memberList})`,
          '(unreadable)',
        );
        return abandonedValue();
      }
      const matched = candidates.find((candidate) => tuplesEqual(documentPins, candidate.pins));
      if (matched === undefined) {
        const remedy =
          candidates.length === 0
            ? `no schema in this closure declares a member of '${name}' -- the schema that does ` +
              'is missing from the imports'
            : `expected one of (${memberList})`;
        ctx.report(
          'VALIDATION_ERROR',
          `no member of '${name}' pins its ${tuple} to the value this record states -- ${remedy}`,
          candidates.length === 0 ? `a member of '${name}'` : `one of (${memberList})`,
          `${tuple} as stated`,
        );
        yield* skipDataValue(ctx);
        return abandonedValue();
      }

      if (lookahead.tag !== undefined) {
        const annotated = terminal(lookahead.tag, (n) => entries.get(n));
        const matchedDef = entries.get(matched.name);
        const agrees =
          annotated === matched.name || (matchedDef?.subtypes.includes(annotated) ?? false);
        if (!agrees) {
          ctx.report(
            'VALIDATION_ERROR',
            `'!${lookahead.tag}' contradicts the ${tuple}, which selects '${matched.name}' -- a ` +
              "tag at a sealed position may agree with the members' own pins and never overrule " +
              'them (§5.2)',
            matched.name,
            `!${lookahead.tag}`,
          );
          yield* skipDataValue(ctx);
          return abandonedValue();
        }
      }

      return yield* resolve(matched.name).read(ctx);
    },
  };
}

/** Every one of `discriminators`, decoded from `tokens` -- `undefined` the moment any one of them is missing or fails to parse, since a partial tuple decides nothing (§5.2's tuple case: all of them or none). */
function decodeAll(
  discriminators: readonly string[],
  tokens: ReadonlyMap<string, Token>,
  fieldReaders: ReadonlyMap<string, TypeReader<Value>>,
): readonly Value[] | undefined {
  const values: Value[] = [];
  for (const fieldName of discriminators) {
    const decoded = decodeDocumentToken(tokens, fieldName, fieldReaders);
    if (decoded === undefined) return undefined;
    values.push(decoded);
  }
  return values;
}
