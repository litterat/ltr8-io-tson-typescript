/**
 * What every phase says of an extern ([TSON-SCHEMA] §5.13): which declarations of a document are externs, found by
 * their written head before any name resolves, how a message names one, and the one refusal of an operation an
 * extern is sealed against.
 */
import type { Declaration } from '../ast/schema/document.js';
import type { CoreValue } from '../ast/value.js';
import { TsonSchemaValidationError } from '../core/errors.js';
import { metaName } from '../schema/meta/kernel.js';
import type { Extern } from '../schema/meta/typedef.js';
import { terminal, type EntryLookup } from './aliasChain.js';

/** The kernel's constructor of externs, which an extern's head names as written (§5.13). */
export const EXTERN_HEAD = metaName('extern');

/**
 * An extern's payload as written, each field absent where it is not written as a token: the read of the payload
 * refuses it.
 */
export interface WrittenExtern {
  readonly schema?: string;
  readonly type?: string;
}

/**
 * Each declaration whose head is written `!meta.extern`, members of nested schema maps included (they are keyed by
 * path), with what its payload writes. Found on the parsed document, so a document's externs are known with its
 * imports (§3.4.1, §5.13): a head reaching `meta.extern` through an alias is no extern head, and the resolver refuses
 * it.
 */
export function writtenExterns(
  declarations: ReadonlyMap<string, Declaration>,
): ReadonlyMap<string, WrittenExtern> {
  const externs = new Map<string, WrittenExtern>();
  for (const [name, declaration] of declarations) {
    const typeDef = declaration.typeDef;
    if (typeDef.kind !== 'instance' || typeDef.value.typeRef !== EXTERN_HEAD) continue;
    const schema = textField(typeDef.value.coreValue, 'schema');
    const type = textField(typeDef.value.coreValue, 'type');
    externs.set(name, {
      ...(schema === undefined ? {} : { schema }),
      ...(type === undefined ? {} : { type }),
    });
  }
  return externs;
}

function textField(value: CoreValue, field: string): string | undefined {
  if (value.kind !== 'record') return undefined;
  const written = value.fields.find((candidate) => candidate.name === field);
  const core = written?.value.coreValue;
  return core?.kind === 'token' ? core.text : undefined;
}

/** The extern `name` names past its alias hops, or `undefined` where it names something else or nothing. */
export function terminalExtern(name: string, entries: EntryLookup): Extern | undefined {
  const end = entries(terminal(name, entries));
  return end?.kind === 'extern' ? end : undefined;
}

/** How a message names an extern: the foreign entry and its schema. */
export function describeExtern(extern: Extern): string {
  return `an extern of '${extern.type}' in '${extern.schema}'`;
}

/**
 * The refusal of `operation` on `written`, which names `extern` directly or through its alias hops to
 * `terminalName`, stated against `subject` (§5.13: an extern is sealed).
 */
export function sealedExtern(
  subject: string,
  operation: string,
  written: string,
  terminalName: string,
  extern: Extern,
): TsonSchemaValidationError {
  return new TsonSchemaValidationError(
    `${subject}: ${operation} '${written}'` +
      (written === terminalName ? '' : `, an alias of '${terminalName}'`) +
      `, which is ${describeExtern(extern)} -- an extern is sealed: it names another schema's type as that ` +
      "schema declares it, so it takes no '&', '-' or '^', heads no construction or application, and a field " +
      'typed by it takes no default or pin ([TSON-SCHEMA] §5.13)',
  );
}
