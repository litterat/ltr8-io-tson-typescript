/**
 * The names this resolver mints, and the renderings their hashes run over — [TSON-SCHEMA] §8.2's
 * `head_arg_arg_hash`, "a readable head plus a structural hash".
 *
 * **Two families, not one.** A *binding record* names a closed form — what a sugar form lifts to,
 * and what closing an open synthetic produces ({@link ofBinding}) — and is rendered with its
 * fields under their own names. An *application* names an instantiation ({@link ofApplication})
 * and is rendered positionally. The two are deliberately separate functions over separate shapes;
 * merging them would be merging two questions that happen to share a spelling, and they reuse the
 * same tag letters in different roles — a binding-record rendering of `{v: text}` and an
 * application rendering of `<text>` under the same head are different renderings on purpose.
 *
 * **What must not fork is each family's own rendering.** {@link ofBinding} is called by both lift
 * channels — `desugar.ts` lifting a sugar form and `templates.ts` closing an open one — and that
 * shared call is exactly what makes a form written directly and the same form arriving through a
 * materialised template land on one entry (§8.2). Two functions of one record would name it twice.
 *
 * **The name is derived from the resolved binding record, not from the spelling that produced
 * it.** That is the one identity rule for internal entries: one entry per distinct concrete form,
 * schema-wide, so `[T; 3]` and `[T; 3..3]` collapse onto the same entry and a form arising from two
 * different declarations is written once.
 *
 * **Every hash runs over a rendering built here**, never over a host object's own default
 * stringification — which for a plain object or a `Map` is unspecified across engines and even
 * across property-insertion order on the very same one. Hashing a string built here, field by
 * field, length-prefixed, is the one construction that is deterministic by contract rather than by
 * accident.
 *
 * That determinism is load-bearing, not cosmetic. An entry name is part of the resolved form, and
 * an importing schema reaches an *imported* entry by deriving the same name for the same form —
 * meta.tn's `extern.types: [type_name]?` landing on the entry meta-kernel already produced.
 *
 * **The canonical renderings are separate from the names** so each is stated once: a rendering
 * decides whether two forms are the same form, which `mintedNames.ts` asks with it, and a second
 * copy free to drift would answer differently in the two places that ask. Each is injective by
 * construction — every value shape written under its own tag, each piece of author text written
 * length-first (`4:text`) — so no arrangement of delimiters inside a token can spell a different
 * record.
 *
 * Every token reaches its readable segment through `internalName.ts`'s own {@link part}, so a
 * document's own text can only ever contribute an ASCII, identifier-admitted fragment to a minted
 * name — see that module's own doc for why.
 */
import type { CoreValue, RecordField } from '../ast/value.js';
import type { Token, TypeArgument, TypeRef } from '../schema/meta/typedef.js';
import { fnv1a32, part } from './internalName.js';
import { canonicalNumber, numericTextOf } from './numericIdentity.js';

// ── A binding record: the closed form a lift produces ───────────────────────────────────────────

/** The name for a binding record, from both lift channels — see this module's own doc on why they share it. */
export function ofBinding(head: string, fields: readonly RecordField[]): string {
  const readable: string[] = [part(head)];
  for (const field of fields) {
    appendReadable(readable, field.value.value.coreValue);
  }
  const hash = fnv1a32(canonicalBinding(head, fields));
  return `${readable.join('')}_${hash.toString(16).padStart(8, '0')}`;
}

/** The readable half of a derived name: every scalar the binding record holds, in order, under `_`. */
function appendReadable(out: string[], value: CoreValue): void {
  switch (value.kind) {
    case 'token':
      out.push('_', part(numericTextOf(value.text, value.form === 'unquoted')));
      break;
    case 'record':
      value.fields.forEach((field) => {
        appendReadable(out, field.value.value.coreValue);
      });
      break;
    case 'array':
      value.elements.forEach((element) => {
        appendReadable(out, element.value.coreValue);
      });
      break;
    case 'map':
    case 'empty-brace':
    case 'absent':
      out.push('_v');
      break;
  }
}

/**
 * A binding record rendered structurally and injectively; two renderings are equal exactly when
 * the records are. What `mintedNames.ts` compares to decide §8.2's freshness MUST.
 */
export function canonicalBinding(head: string, fields: readonly RecordField[]): string {
  const out: string[] = ['A'];
  appendText(out, head);
  appendFields(out, fields);
  return out.join('');
}

function appendFields(out: string[], fields: readonly RecordField[]): void {
  out.push('(');
  for (const field of fields) {
    out.push('f');
    appendText(out, field.name);
    appendValue(out, field.value.value.coreValue);
  }
  out.push(')');
}

function appendValue(out: string[], value: CoreValue): void {
  switch (value.kind) {
    case 'token':
      out.push('v');
      appendText(out, value.form);
      appendNumberAware(out, value.text, value.form === 'unquoted');
      break;
    case 'record':
      out.push('r');
      appendFields(out, value.fields);
      break;
    case 'array':
      out.push('a(');
      value.elements.forEach((element) => {
        appendValue(out, element.value.coreValue);
      });
      out.push(')');
      break;
    case 'map':
    case 'empty-brace':
    case 'absent':
      out.push('?');
      break;
  }
}

// ── An application: the instantiation entry a closure produces ─────────────────────────────────

/** The name for an application, rendered positionally where a binding record is rendered by field name. */
export function ofApplication(head: string, args: readonly TypeArgument[]): string {
  const readable: string[] = [part(head)];
  for (const argument of args) {
    if (argument.kind === 'ref') {
      readable.push('_', part(argument.ref.name));
    } else {
      readable.push('_', part(canonicalArgumentText(argument.value)));
    }
  }
  const hash = fnv1a32(canonicalApplication(head, args));
  return `${readable.join('')}_${hash.toString(16).padStart(8, '0')}`;
}

/**
 * An application rendered structurally and injectively — what `mintedNames.ts` compares to decide
 * whether two applications are the same application.
 */
export function canonicalApplication(head: string, args: readonly TypeArgument[]): string {
  const out: string[] = ['A'];
  appendText(out, head);
  out.push('(');
  for (const argument of args) {
    if (argument.kind === 'ref') {
      out.push('r');
      appendRef(out, argument.ref);
    } else {
      out.push('v');
      appendText(out, argument.value.form);
      appendNumberAwareToken(out, argument.value);
    }
  }
  out.push(')');
  return out.join('');
}

function appendRef(out: string[], ref: TypeRef): void {
  out.push('n');
  appendText(out, ref.name);
  out.push('(');
  for (const argument of ref.arguments) {
    if (argument.kind === 'ref') {
      out.push('r');
      appendRef(out, argument.ref);
    } else {
      appendText(out, argument.value.form);
      appendNumberAwareToken(out, argument.value);
    }
  }
  out.push(')');
}

/** A value argument's readable segment, with §4.3's numeric equivalence applied. */
function canonicalArgumentText(token: Token): string {
  return numericTextOf(token.text, token.form === 'UNQUOTED');
}

// ── Shared leaves ────────────────────────────────────────────────────────────────────────────

/** Length-first, so concatenation stays unambiguous whatever the text contains. */
function appendText(out: string[], text: string): void {
  out.push(`${String(text.length)}:${text}`);
}

/**
 * A token's contribution to a hashed rendering, with §4.3's numeric equivalence applied. A number
 * writes its base-type kind and its canonical magnitude as two fields where anything else writes
 * its text as one; every field being length-prefixed, no token's own text can be mistaken for a
 * tagged number.
 */
function appendNumberAware(out: string[], text: string, unquoted: boolean): void {
  const canonical = canonicalNumber(text, unquoted);
  if (canonical !== undefined) {
    appendText(out, canonical.kind);
  }
  appendText(out, canonical === undefined ? text : canonical.text);
}

/** The same, over a `schema/meta` {@link Token} rather than an `ast` `TokenValue`. */
function appendNumberAwareToken(out: string[], token: Token): void {
  appendNumberAware(out, token.text, token.form === 'UNQUOTED');
}
