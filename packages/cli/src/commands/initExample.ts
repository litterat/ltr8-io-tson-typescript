/**
 * `tson init-example [<dir>]` -- writes a small working schema (`person.tn`) and a matching data
 * document (`person-data.tn`) into `<dir>` (default `.`), so a caller has something real to run
 * `tson validate --schema person.tn --root person person-data.tn` against immediately.
 *
 * **The schema is hand-authored text; the data document is not.** There is no schema-document
 * writer anywhere in `@ltr8/tson` (`write/index.ts`'s whole public surface is `writeDocument*`
 * for the parse-preserving AST, `writeTree*` for the tree model, and `writeBinding*` for a bound
 * object -- none of them write a `SchemaDocument`), so `person.tn` is authored the same way the
 * bundled schemas themselves are: literal, checked-in TSON text. `person-data.tn` has no such
 * excuse -- it is an ordinary data document, so it is built as a `tree/nodes.ts` {@link Value} and
 * handed to `write()`, this work package's own "own writer, not string concatenation" requirement
 * for anything this CLI emits as TSON.
 *
 * `person.tn`'s `!!meta`/`!!import` reference meta.tn/core.tn by the *exact* canonical id the
 * bundled copies this CLI embeds declare (read back via `idDirective.ts`'s own `readIdDirective`
 * rather than hand-copied), so `tson validate --schema <dir>/person.tn --root person
 * <dir>/person-data.tn` resolves against this CLI's own bootstrapped standard library
 * (`../stdlib.ts`) with nothing further to configure.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomNode, recordNode, write, type Value } from '@ltr8/tson';
import { CORE_TN, META_TN } from '@ltr8/tson/stdlib';
import { readIdDirective } from '../idDirective.js';

const PERSON_SCHEMA_ID = 'https://example.com/tson-cli/examples/person.tn';

function idOf(schemaText: string, label: string): string {
  const id = readIdDirective(new TextEncoder().encode(schemaText))?.id;
  if (id === undefined) {
    // Unreachable against the real, bundled schemas this module embeds -- both declare a plain,
    // unescaped !!id line. A loud failure here is safer than silently writing a broken !!import.
    throw new Error(`${label} carries no readable !!id -- this should never happen`);
  }
  return id;
}

function personSchemaText(): string {
  const metaId = idOf(META_TN, 'meta.tn');
  const coreId = idOf(CORE_TN, 'core.tn');
  return `!!id:"${PERSON_SCHEMA_ID}"
!!meta:"${metaId}"
!!import:"${coreId}"
@doc:"An example schema for the tson CLI's own init-example command."
{
  person => {
    name:   text
    age:    uint8
    active: boolean
  }
}
`;
}

function personDataText(): string {
  const fields = new Map<string, Value>([
    ['name', atomNode('Ada Lovelace')],
    ['age', atomNode(36n)],
    ['active', atomNode(true)],
  ]);
  const root = recordNode(fields, 'person');
  return `${write(root, { schema: PERSON_SCHEMA_ID })}\n`;
}

export interface InitExampleResult {
  readonly schemaFile: string;
  readonly dataFile: string;
}

/** Writes `person.tn`/`person-data.tn` into `dir` (created if it does not exist), overwriting either that already exists there. */
export async function runInitExample(dir: string): Promise<InitExampleResult> {
  await mkdir(dir, { recursive: true });
  const schemaFile = join(dir, 'person.tn');
  const dataFile = join(dir, 'person-data.tn');
  await writeFile(schemaFile, personSchemaText(), 'utf8');
  await writeFile(dataFile, personDataText(), 'utf8');
  return { schemaFile, dataFile };
}
