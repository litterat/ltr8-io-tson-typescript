/**
 * `HeldBody` — the held tree of an open entry (§5.10): a constructor application, still in wire
 * form, unread until `templateSubstitution.ts` substitutes its parameters away.
 *
 * **Two kernel shapes carry an open entry, and one tree serves both.** A record template is a
 * `record` with `parameters` (`schema/meta`'s `RecordBody`, a family base and itself a type);
 * every other open entry's value is the kernel's `template`, the application held as text
 * (`TemplateBody`). Closing reads one tree shape whichever kind of open entry it came from:
 * {@link heldOf} answers for any value, writing a record template's tree through `wireForm.ts`'s
 * `heldRecord` and keeping the tree a held `TemplateBody` was built from.
 *
 * **`TemplateBody` itself is text** (§8.1: what is compared is the parsed form of the text, never
 * the text), so `parameters`/`template` alone satisfy the contract `schema/meta` declares.
 * `HeldBody` carries more: the live `application` value beneath the text, and the two query
 * methods ({@link HeldBody.names}/{@link HeldBody.applications}) the resolver asks of it. A held
 * body built here answers both directly over the `DataValue` it was built from; one that arrived
 * as text alone is parsed once, by {@link heldOf}.
 *
 * The wire vocabulary and the shape of an application (`isApplication`/`typeRefOf`) are
 * `wireForm.ts`'s own concern, shared with every other phase that writes or reads one — see that
 * module's own doc for why one spelling matters.
 */
import type { CoreValue, DataValue } from '../ast/value.js';
import { fromBytes, runSync } from '../io/bytes.js';
import { encodeUtf8 } from '../io/utf8.js';
import type { TemplateBody, TemplateParam } from '../schema/meta/bodies.js';
import { TYPE_KIND } from '../schema/meta/bodies.js';
import type { Top, TypeRef } from '../schema/meta/typedef.js';
import { isFamilyBase, isTemplateBody } from '../schema/meta/typedef.js';
import { writeDataValue } from '../write/astWriter.js';
import { parseDocument } from './dataParser.js';
import { heldRecord, isApplication, typeRefOf } from './wireForm.js';

/**
 * A held application (§5.10) with the parameters it binds: the `TemplateBody` `schema/meta`
 * declares the seat for, plus `application`, the tree beneath the text.
 *
 * `names()`/`applications()` answer the only two questions a held, unresolved body can answer
 * without being resolved: every unquoted name it mentions, at any depth (a declared parameter the
 * body never references is an author error, §5.10), and every type application it writes, at any
 * depth (a recursive application that does not pass its parameters through unchanged grows its
 * argument at every level, §5.10.1).
 */
export interface HeldBody extends TemplateBody {
  readonly application: DataValue;
  /** The parameter names, in declaration order — {@link TemplateBody.parameters} without the types. */
  readonly parameterNames: readonly string[];
  names(): ReadonlySet<string>;
  applications(): readonly TypeRef[];
}

/** Whether a resolved `TemplateBody` carries its tree -- true of every one this module built. */
export function isHeldBody(body: TemplateBody): body is HeldBody {
  return 'application' in body;
}

/** The kernel's kind of the types (§4.2) — what an unclassified parameter starts as, a type parameter. */
const TYPE_KIND_REF: TypeRef = { name: TYPE_KIND, arguments: [], annotations: [] };

/**
 * A held body over `application`, each of `parameters` starting as a type parameter until
 * `parameterTypes.ts` derives its type from the positions it stands in (§5.10).
 */
export function createHeldBody(application: DataValue, parameters: readonly string[]): HeldBody {
  return heldBodyOf(
    application,
    parameters.map((name): TemplateParam => ({ name, type: TYPE_KIND_REF })),
  );
}

/** `held` with each parameter replaced by `settled`'s entry for it, where there is one. */
export function withParameters(
  held: HeldBody,
  settled: ReadonlyMap<string, TemplateParam>,
): HeldBody {
  return heldBodyOf(
    held.application,
    held.parameters.map((parameter) => settled.get(parameter.name) ?? parameter),
  );
}

/**
 * The held tree of an entry whose value is `value`, or `undefined` for a closed entry: a held
 * `TemplateBody`'s own tree (parsed from its text where it arrived as text alone), or a record
 * template's, written through `heldRecord` -- its own `extension` (each application's) stated
 * where it is not OPEN, its parents as written, and no selector list, which a member never
 * carries.
 */
export function heldOf(value: Top | undefined): HeldBody | undefined {
  if (value === undefined) return undefined;
  if (isTemplateBody(value)) {
    if (isHeldBody(value)) return value;
    return heldBodyOf(parseHeldText(value.template), value.parameters);
  }
  if (isFamilyBase(value)) {
    const { discriminators: _selectors, parameters, ...record } = value;
    void _selectors;
    return heldBodyOf(heldRecord({ ...record }), parameters);
  }
  return undefined;
}

/** A held body's text back as the application it spells. */
function parseHeldText(text: string): DataValue {
  return runSync(parseDocument(fromBytes(encodeUtf8(text)))).document.root;
}

function heldBodyOf(application: DataValue, parameters: readonly TemplateParam[]): HeldBody {
  const body: TemplateBody = {
    parameters,
    template: writeDataValue(application),
  };
  return Object.defineProperties(body, {
    application: { value: application },
    parameterNames: { value: parameters.map((parameter) => parameter.name) },
    names: {
      value(): ReadonlySet<string> {
        const names = new Set<string>();
        collectNames(application.coreValue, names);
        return names;
      },
    },
    applications: {
      value(): readonly TypeRef[] {
        const applications: TypeRef[] = [];
        collectApplications(application.coreValue, applications);
        return applications;
      },
    },
  }) as HeldBody;
}

function collectNames(value: CoreValue, into: Set<string>): void {
  switch (value.kind) {
    case 'token':
      if (value.form === 'unquoted') into.add(value.text);
      return;
    case 'array':
      for (const element of value.elements) collectNames(element.value.coreValue, into);
      return;
    case 'record':
      for (const field of value.fields) collectNames(field.value.value.coreValue, into);
      return;
    case 'map':
      // A parameter stands wherever a token stands, map keys and values alike --
      // `extern_of => <S> !scoped { scope: [EXTERN] schemas: { S => _ } }` binds `S` as a map key,
      // never a field or element, so a walk that skipped this case would call `extern_of` a
      // declared-but-unused parameter (§5.10's own error, wrongly raised).
      for (const entry of value.entries) {
        collectNames(entry.key.coreValue, into);
        collectNames(entry.value.value.coreValue, into);
      }
      return;
    case 'empty-brace':
    case 'void':
      return;
  }
}

function collectApplications(value: CoreValue, into: TypeRef[]): void {
  switch (value.kind) {
    case 'record':
      if (isApplication(value)) {
        into.push(typeRefOf(value));
        return;
      }
      for (const field of value.fields) collectApplications(field.value.value.coreValue, into);
      return;
    case 'array':
      for (const element of value.elements) collectApplications(element.value.coreValue, into);
      return;
    case 'map':
      // A map is exactly as legitimate a container to find a nested application inside as an
      // array or a record field is -- both the key and value side of each entry are walked.
      for (const entry of value.entries) {
        collectApplications(entry.key.coreValue, into);
        collectApplications(entry.value.value.coreValue, into);
      }
      return;
    case 'token':
    case 'empty-brace':
    case 'void':
      return;
  }
}

/**
 * `value` with each of its parameters replaced by `settled`'s entry for it, where there is one --
 * how a parameter's derived type is stamped (§5.10). A closed entry is returned as it is.
 */
export function withParametersOf(value: Top, settled: ReadonlyMap<string, TemplateParam>): Top {
  if (isTemplateBody(value)) {
    const held = heldOf(value);
    return held === undefined ? value : withParameters(held, settled);
  }
  if (isFamilyBase(value)) {
    return {
      ...value,
      parameters: value.parameters.map((parameter) => settled.get(parameter.name) ?? parameter),
    };
  }
  return value;
}
