/**
 * Turns one resolved {@link Atom} body into the compiled leaf reader for it -- the bridge Wave 5's
 * compiler needs between `schema/meta`'s resolved constraint vocabulary and `atom/`'s own
 * per-family parsers (§5, §9). Every `create*Parser` factory in `atom/{numeric,temporal,network,
 * text}/` already takes exactly this shape (`(typeRef, constraints) => AtomType<T>`) -- built for
 * `reader/schemaless/vocabulary.ts`'s hand-authored built-in table, reused here unchanged for a
 * schema-declared instance instead of a hardcoded one. `{@link buildAtomReader}` is the one
 * dispatch every `Atom.kind` reaches, and it hands back a whole `TypeReader<Value>` (annotations
 * captured, node built), the same shape `reader/tree/factory.ts`'s four container factories
 * already return, so `compile.ts`'s own resolver never has to know an entry it just built is a
 * leaf.
 *
 * **`value` and `void` are recognised by constructor.** `value_type` and `void_type` are atom
 * constructors with empty vocabularies (§4.2), so a `value_type` body reads its token
 * uninterpreted for the position to resolve, and a `void_type` body admits only the void sentinel
 * (§7.3). Nothing here consults a declared name.
 *
 * **`enum` has the same gap for exactly one built-in instance.** `boolean => !enum [true false]`
 * (core.tn) is schema-shape-identical to any other two-member user enum (`status => !enum [UP
 * DOWN]`), yet its own two members are §4's base-resolution spellings of the JS booleans a caller
 * reasonably expects back, not the literal strings `"true"`/`"false"`. Recognising the exact
 * `{true, false}` member set and narrowing to a real host `boolean` is this module's own
 * documented reading of that same ambiguity, applied narrowly (a three-member enum that happens
 * to include `true` stays string-valued) rather than guessed at every enum (`atom/enum.ts`).
 *
 * **A value of an identifier family is a name** (§8.2), so it meets the per-name mechanisms under
 * the family's own profile, with the policy this compile was given ({@link AtomReaderOptions}).
 */
import type { AtomToken, AtomType } from '../atom/contract.js';
import type { Atom } from '../schema/meta/typedef.js';
import type { Normalization, RegexType, TextType } from '../schema/meta/atoms-text.js';
import type { AtomValue, Value } from '../tree/nodes.js';
import { atomNode } from '../tree/nodes.js';
import type { Task } from '../io/bytes.js';
import type { ReadContext, TypeReader } from '../reader/contracts.js';
import { atomTreeReader, atomTypeReader } from '../reader/tree/atom.js';
import { absentTreeReader } from '../reader/tree/absent.js';
import { captureAnnotations } from '../reader/tree/annotations.js';
import { describeEvent, skipAnnotationsAndTypeRef, skipCoreValue } from '../reader/tree/grammar.js';
import { abandonedValue } from '../reader/tree/support.js';
import { resolveBaseType, type BaseValue } from '../base/baseTypeResolver.js';
import { toExactDecimal, toExactInteger } from '../base/numberNarrowing.js';
import type { NumberForm } from '../base/numberGrammar.js';

import { createIntegerParser } from '../atom/numeric/integer.js';
import { createDecimalParser } from '../atom/numeric/decimal.js';
import { createFloatParser } from '../atom/numeric/float.js';
import { createRationalParser } from '../atom/numeric/rational.js';
import { createComplexParser } from '../atom/numeric/complex.js';
import { createBinaryParser } from '../atom/numeric/binary.js';
import { createMembershipCheck, createPatternCheck, createTextParser } from '../atom/text/text.js';
import { createIdentifierParser } from '../atom/text/identifier.js';
import { createEnumParser } from '../atom/enum.js';
import { identifierProfileOf } from '../unicode/identifier-profile.js';
import { DEFAULT_NAME_POLICY, judgeName, type NamePolicy } from '../unicode/policy.js';
import { reportNameViolations } from '../reader/tree/refusal.js';
import { createUuidParser } from '../atom/network/uuid.js';
import { createUriParser } from '../atom/network/uri.js';
import { createEmailParser } from '../atom/network/email.js';
import { createMacParser } from '../atom/network/mac.js';
import { createIpv4Parser } from '../atom/network/ipv4.js';
import { createIpv6Parser } from '../atom/network/ipv6.js';
import { createCidr4Parser } from '../atom/network/cidr4.js';
import { createCidr6Parser } from '../atom/network/cidr6.js';
import { createDateParser } from '../atom/temporal/date.js';
import { createTimeParser } from '../atom/temporal/time.js';
import { createDateTimeParser } from '../atom/temporal/datetime.js';
import { createDurationParser } from '../atom/temporal/duration.js';
import { createPeriodParser } from '../atom/temporal/period.js';

/** Wraps a concrete {@link AtomType} as a `TypeReader<Value>` -- the port of `reader/tree/atom.ts`'s own two-function pipeline, applied uniformly to every atom family but `void` and `value`. */
function wrap<T extends AtomValue>(atomType: AtomType<T>, typeRef: string): TypeReader<Value> {
  return atomTreeReader(atomTypeReader(atomType, typeRef), typeRef);
}

// ── value, void ──────────────────────────────────────────────────────────────────────────────

/** §4's base value narrowed to the natural host value it implies -- this module's own copy of `reader/schemaless/tree.ts`'s `narrowBaseValue`/`narrowNumberForm`, duplicated rather than imported for the same reason that module states its own duplication: a small structural rule, nothing library-specific, and sub-agents share no context to import across. */
function narrowBaseValue(value: BaseValue): AtomValue {
  switch (value.kind) {
    case 'boolean':
      return value.value;
    case 'string':
      return value.text;
    case 'number':
      return narrowNumberForm(value.form);
  }
}

function narrowNumberForm(form: NumberForm): AtomValue {
  switch (form.kind) {
    case 'special-value':
      return form.special === 'nan' ? NaN : form.sign === 'minus' ? -Infinity : Infinity;
    case 'integer':
    case 'based-integer':
      return toExactInteger(form);
    case 'float':
      return toExactDecimal(form);
  }
}

/**
 * `value`'s own reading contract (meta-kernel.tn: "the token, uninterpreted, read by the type the
 * position hands it to"). Not routed through {@link wrap} since its host inhabitants span three of
 * `AtomValue`'s cases rather than being fixed to one -- this is the one type whose contract is
 * "carry the token and let the position decide". There is no absent outcome here, since `_` is a
 * distinct event kind this reader never sees as a `token`.
 *
 * The escape hatch is a *carrier*, not a resolution step: base type resolution applies only in
 * schemaless documents ([TSON-DATA] §4.1), and under a schema every value is typed by its position
 * or by its tag. A `value`-typed facet is therefore read under the atom the slot stands for, once
 * that atom is in scope ([TSON-SCHEMA] §5.2, §7.4) -- which is why `decimal_type.min`'s `1` and
 * `1.0` are one number rather than an integer beside a float.
 */
function valueTreeReader(displayName: string): TypeReader<Value> {
  return {
    *read(ctx: ReadContext): Task<Value> {
      const annotations = yield* captureAnnotations(ctx);
      yield* skipAnnotationsAndTypeRef(ctx); // no-op past the capture above; consumes an optional type-ref, matching atomTypeReader's own pattern
      const e = yield* ctx.peek();
      if (e.kind !== 'token') {
        ctx.report(
          'TYPE_MISMATCH',
          `'${displayName}' expects a scalar value`,
          `a scalar for '${displayName}'`,
          describeEvent(e),
        );
        yield* skipCoreValue(ctx);
        return abandonedValue();
      }
      yield* ctx.next();
      const narrowed = narrowBaseValue(resolveBaseType({ text: e.text, form: e.form }));
      return atomNode(narrowed, undefined, annotations);
    },
  };
}

// ── regex_type ───────────────────────────────────────────────────────────────────────────────

/**
 * `regex_type => ~text_type & atom_specification & { spec: = ... }` (§5.7): every constraint
 * `createTextParser` reads is one `regex_type` carries too under the identical field names, but
 * with a `kind: 'regex_type'` discriminant `TextType` itself does not accept -- structurally a
 * strict superset, nominally a mismatch. This rebuilds the `text_type`-shaped subset by hand
 * (`exactOptionalPropertyTypes` forbids simply spreading the optional fields across, since an
 * absent field must stay absent rather than become an explicit `undefined`) rather than widening
 * `createTextParser`'s own signature to accept either discriminant.
 */
function asTextConstraints(atom: RegexType): TextType {
  const { minLength, maxLength, length, pattern, members, normalization } = atom;
  return {
    kind: 'text_type',
    normalization,
    ...(minLength === undefined ? {} : { minLength }),
    ...(maxLength === undefined ? {} : { maxLength }),
    ...(length === undefined ? {} : { length }),
    ...(pattern === undefined ? {} : { pattern }),
    ...(members === undefined ? {} : { members }),
  };
}

/**
 * Wraps `atomType` with `text_type.members`/`text_type.pattern`'s own read-time enforcement
 * (§7.4, §5.5, §5.7, #22), for the two text-shaped families with no `createTextParser`-backed
 * reader of their own — `uri_type`/`email_type` each compose `text_type`'s `members` and
 * `pattern` facets (§9) but keep an independent parser (`atom/network/{uri,email}.ts`), whose
 * host value is the token's own text unchanged, so a post-read check on the returned string is
 * exactly a pre-read check on the token would have been. `text_type`/`regex_type` need no such
 * wrapping: both dispatch through `createTextParser`, which enforces both facets itself
 * (`atom/text/text.ts`) — this function reuses that module's own `createMembershipCheck`/
 * `createPatternCheck` rather than a second copy of either.
 */
function withTextFacets(
  atomType: AtomType<string>,
  typeRef: string,
  members: readonly string[] | undefined,
  pattern: string | undefined,
): AtomType<string> {
  const checkPattern = createPatternCheck(typeRef, pattern);
  const checkMembership = createMembershipCheck(typeRef, members);
  if (checkPattern === undefined && checkMembership === undefined) return atomType;
  return {
    read(token: AtomToken): string {
      const value = atomType.read(token);
      checkPattern?.(value);
      checkMembership?.(value);
      return value;
    },
    write: (value: string): string => atomType.write(value),
  };
}

// ── Dispatch ─────────────────────────────────────────────────────────────────────────────────

/** What a compile knows about an atom position beyond its body. */
export interface AtomReaderOptions {
  /** The `normalization` of an enum's label type (§7.4), recorded by linking (`LinkedSchema.enumForms`); `NONE` when absent. */
  readonly enumForm?: Normalization;
  /** [TSON-DATA] §8.2's name-hygiene policy over the values of identifier families; {@link DEFAULT_NAME_POLICY} when absent. */
  readonly identifierPolicy?: NamePolicy;
}

/**
 * Builds the compiled reader for one resolved {@link Atom} body, under its own compiled entry
 * name `name` -- `compile.ts`'s one call into this module. Exhaustive over {@link Atom}'s own
 * closed union with no `default`, so a new atom family lands here as a type error, not a silent
 * `NOT_IMPLEMENTED` at read time.
 */
export function buildAtomReader(
  name: string,
  atom: Atom,
  options: AtomReaderOptions = {},
): TypeReader<Value> {
  switch (atom.kind) {
    case 'value_type':
      return valueTreeReader(name);
    case 'void_type':
      return absentTreeReader(name);
    case 'enum':
      return wrap(createEnumParser(name, atom, options.enumForm), name);
    case 'integer_type':
      return wrap(createIntegerParser(name, atom), name);
    case 'text_type':
      return wrap(createTextParser(name, atom), name);
    case 'identifier_type': {
      const profile = identifierProfileOf(atom);
      const policy = options.identifierPolicy ?? DEFAULT_NAME_POLICY;
      return atomTreeReader(
        atomTypeReader(createIdentifierParser(name, atom), name, (ctx, value) => {
          const violations = judgeName(value, profile, policy);
          if (violations.length === 0) return false;
          reportNameViolations(ctx, value, violations);
          return true;
        }),
        name,
      );
    }
    case 'uri_type':
    case 'iri_type':
      return wrap(
        withTextFacets(createUriParser(name, atom), name, atom.members, atom.pattern),
        name,
      );
    case 'regex_type':
      // `regex_type => ~text_type & atom_specification & { spec: = ... }` (§5.7): every field
      // `createTextParser` reads (`minLength`/`maxLength`/`length`/`pattern`/`members`) is one
      // `regex_type` carries too, so its own length/pattern/members contract is `text_type`'s,
      // unmodified -- reusing it here rather than authoring a second copy of the same checks.
      // `atom/text/text.ts`'s own TSDoc states what `createTextParser` enforces at read time.
      return wrap(createTextParser(name, asTextConstraints(atom)), name);
    case 'email_type':
      return wrap(
        withTextFacets(createEmailParser(name, atom), name, atom.members, atom.pattern),
        name,
      );
    case 'decimal_type':
      return wrap(createDecimalParser(name, atom), name);
    case 'float_type':
      return wrap(createFloatParser(name, atom), name);
    case 'rational_type':
      return wrap(createRationalParser(name, atom), name);
    case 'uuid_type':
      return wrap(createUuidParser(name, atom), name);
    case 'bytes_type':
      return wrap(createBinaryParser(name, atom), name);
    case 'date_type':
      return wrap(createDateParser(name, atom), name);
    case 'time_type':
      return wrap(createTimeParser(name, atom), name);
    case 'datetime_type':
      return wrap(createDateTimeParser(name, atom), name);
    case 'duration_type':
      return wrap(createDurationParser(name, atom), name);
    case 'period_type':
      return wrap(createPeriodParser(name, atom), name);
    case 'cidr4_type':
      return wrap(createCidr4Parser(name, atom), name);
    case 'cidr6_type':
      return wrap(createCidr6Parser(name, atom), name);
    case 'mac_type':
      return wrap(createMacParser(name, atom), name);
    case 'ipv4_type':
      return wrap(createIpv4Parser(name, atom), name);
    case 'ipv6_type':
      return wrap(createIpv6Parser(name, atom), name);
    case 'complex_type':
      return wrap(createComplexParser(name), name);
  }
}
