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
 * **`unit` has no schema-shape signal of its own.** meta-kernel.tn's own doc for the `unit`
 * constructor states this outright: its three kernel instances (`value`, `token`, `void`) "are
 * opaque atoms distinguished by name and prose-level parsing contract, not by schema shape" --
 * every one of them resolves to the identical empty `{ kind: 'unit' }` body, so nothing in
 * `schema/meta`'s types can tell them apart. This module dispatches those three names
 * specifically (`byUnitName`); a user schema's own `~unit {}` instance under any other name has
 * no established contract to fall back on, and is read the same way `token` is -- its canonical
 * lexeme, verbatim -- as the most general "opaque atom" reading available. This is a real
 * spec-feedback finding worth recording upstream, not a silent guess: the resolved schema model
 * gives a compiler no shape-level way to honour §4.2's own three-way distinction.
 *
 * **`enum` has the same gap for exactly one built-in instance.** `boolean => !enum [true false]`
 * (core.tn) is schema-shape-identical to any other two-member user enum (`status => !enum [UP
 * DOWN]`), yet its own two members are §4's base-resolution spellings of the JS booleans a caller
 * reasonably expects back, not the literal strings `"true"`/`"false"`. Recognising the exact
 * `{true, false}` member set and narrowing to a real host `boolean` is this module's own
 * documented reading of that same ambiguity, applied narrowly (a three-member enum that happens
 * to include `true` stays string-valued) rather than guessed at every enum.
 */
import { TsonAtomValidationError } from '../core/errors.js';
import type { AtomToken, AtomType } from '../atom/contract.js';
import type { Atom } from '../schema/meta/typedef.js';
import type { EnumBody } from '../schema/meta/bodies.js';
import type { RegexType, TextType } from '../schema/meta/atoms-text.js';
import type { AtomValue, Value } from '../tree/nodes.js';
import { absentNode, atomNode } from '../tree/nodes.js';
import type { Task } from '../io/bytes.js';
import type { ReadContext, TypeReader } from '../reader/contracts.js';
import { atomTreeReader, atomTypeReader } from '../reader/tree/atom.js';
import { absentTreeReader } from '../reader/tree/absent.js';
import { captureAnnotations } from '../reader/tree/annotations.js';
import { describeEvent, skipAnnotationsAndTypeRef, skipCoreValue } from '../reader/tree/grammar.js';
import { resolveBaseType, type BaseValue } from '../base/baseTypeResolver.js';
import { toExactDecimal, toExactInteger } from '../base/numberNarrowing.js';
import type { NumberForm } from '../base/numberGrammar.js';

import { createIntegerParser } from '../atom/numeric/integer.js';
import { createDecimalParser } from '../atom/numeric/decimal.js';
import { createFloatParser } from '../atom/numeric/float.js';
import { createRationalParser } from '../atom/numeric/rational.js';
import { createComplexParser } from '../atom/numeric/complex.js';
import { createBinaryParser } from '../atom/numeric/binary.js';
import { createTextParser } from '../atom/text/text.js';
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

/** Wraps a concrete {@link AtomType} as a `TypeReader<Value>` -- the port of `reader/tree/atom.ts`'s own two-function pipeline, applied uniformly to every non-`unit` atom family. */
function wrap<T extends AtomValue>(atomType: AtomType<T>, typeRef: string): TypeReader<Value> {
  return atomTreeReader(atomTypeReader(atomType, typeRef), typeRef);
}

// ── enum ─────────────────────────────────────────────────────────────────────────────────────

/** See this module's own top note on the `{true, false}` special case. */
function buildEnumAtomType(typeRef: string, body: EnumBody): AtomType<string | boolean> {
  const members = body.members;
  const memberSet = new Set(members);
  const isBoolean = members.length === 2 && memberSet.has('true') && memberSet.has('false');
  const membership = `one of (${members.join(', ')})`;

  return {
    read(token: AtomToken): string | boolean {
      if (!memberSet.has(token.text)) {
        throw new TsonAtomValidationError(
          typeRef,
          `'${token.text}' is not a member of '${typeRef}' -- expected ${membership}`,
          membership,
        );
      }
      return isBoolean ? token.text === 'true' : token.text;
    },
    write(value: string | boolean): string {
      return typeof value === 'boolean' ? (value ? 'true' : 'false') : value;
    },
  };
}

// ── unit ─────────────────────────────────────────────────────────────────────────────────────

/** `token`, and every other schema's own `~unit {}` instance with no established prose contract -- the canonical lexeme, verbatim. See this module's own top note. */
function tokenTextAtomType(): AtomType<string> {
  return {
    read: (token: AtomToken): string => token.text,
    write: (value: string): string => value,
  };
}

/** §4's base value narrowed to the natural host value it implies, `null` standing for the base `null` token -- this module's own copy of `reader/schemaless/tree.ts`'s `narrowBaseValue`/`narrowNumberForm`, duplicated rather than imported for the same reason that module states its own duplication: a small structural rule, nothing library-specific, and sub-agents share no context to import across. */
function narrowBaseValue(value: BaseValue): AtomValue | null {
  switch (value.kind) {
    case 'null':
      return null;
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
 * `value`'s own reading contract (meta-kernel.tn: "the result of base type resolution ([TSON-DATA]
 * §4) applied to a source token, with no further interpretation"). Not routed through {@link wrap}:
 * base resolution's `null` case has no member of {@link AtomValue} to stand for it (the tree model
 * has one no-value node, not a null atom), so this reads a `Value` directly -- an {@link AbsentNode}
 * for the base `null`, an {@link AtomNode} for everything else -- mirroring `reader/schemaless/
 * tree.ts`'s own `leaf` exactly, for the one type whose contract is "read like an untyped leaf".
 */
function unitValueTreeReader(displayName: string): TypeReader<Value> {
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
        return absentNode(undefined, annotations);
      }
      yield* ctx.next();
      const narrowed = narrowBaseValue(resolveBaseType({ text: e.text, form: e.form }));
      return narrowed === null
        ? absentNode(undefined, annotations)
        : atomNode(narrowed, undefined, annotations);
    },
  };
}

/** Dispatches `unit`'s three kernel names, and falls back to {@link tokenTextAtomType} for every other `~unit {}` instance. See this module's own top note. */
function buildUnitReader(name: string): TypeReader<Value> {
  if (name === 'void') return absentTreeReader(name);
  if (name === 'value') return unitValueTreeReader(name);
  return wrap(tokenTextAtomType(), name);
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
  const { minLength, maxLength, length, pattern } = atom;
  return {
    kind: 'text_type',
    ...(minLength === undefined ? {} : { minLength }),
    ...(maxLength === undefined ? {} : { maxLength }),
    ...(length === undefined ? {} : { length }),
    ...(pattern === undefined ? {} : { pattern }),
  };
}

// ── Dispatch ─────────────────────────────────────────────────────────────────────────────────

/**
 * Builds the compiled reader for one resolved {@link Atom} body, under its own compiled entry
 * name `name` -- `compile.ts`'s one call into this module. Exhaustive over {@link Atom}'s own
 * closed union with no `default`, so a new atom family lands here as a type error, not a silent
 * `NOT_IMPLEMENTED` at read time.
 */
export function buildAtomReader(name: string, atom: Atom): TypeReader<Value> {
  switch (atom.kind) {
    case 'unit':
      return buildUnitReader(name);
    case 'enum':
      return wrap(buildEnumAtomType(name, atom), name);
    case 'integer_type':
      return wrap(createIntegerParser(name, atom), name);
    case 'text_type':
      return wrap(createTextParser(name, atom), name);
    case 'uri_type':
      return wrap(createUriParser(name, atom), name);
    case 'regex_type':
      // `regex_type => ~text_type & atom_specification & { spec: = ... }` (§5.7): every field
      // `createTextParser` reads (`minLength`/`maxLength`/`length`/`pattern`) is one `regex_type`
      // carries too, so its own length/pattern contract is `text_type`'s, unmodified -- reusing
      // it here rather than authoring a second copy of the same four checks. `pattern`
      // enforcement is deferred exactly as `text_type`'s own instance already defers it (that
      // module's own documented gap, not a new one).
      return wrap(createTextParser(name, asTextConstraints(atom)), name);
    case 'email_type':
      return wrap(createEmailParser(name, atom), name);
    case 'decimal_type':
      return wrap(createDecimalParser(name, atom), name);
    case 'float_type':
      return wrap(createFloatParser(name, atom), name);
    case 'rational_type':
      return wrap(createRationalParser(name, atom), name);
    case 'uuid_type':
      return wrap(createUuidParser(name, atom), name);
    case 'binary':
      return wrap(createBinaryParser(name, atom), name);
    case 'date_type':
      return wrap(createDateParser(name, atom), name);
    case 'time_type':
      return wrap(createTimeParser(name, atom), name);
    case 'datetime_type':
      return wrap(createDateTimeParser(name, atom), name);
    case 'duration_type':
      return wrap(createDurationParser(name, atom), name);
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
