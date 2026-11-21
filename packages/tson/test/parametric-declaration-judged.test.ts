/**
 * [TSON-SCHEMA] §5.10, §5.10.1: whatever no argument changes has its verdict where a parametric record is declared,
 * once, applied or not -- a name that is no parameter, productivity with the parameters assumed inhabited, a
 * selector's type, a literal under a type naming no parameter. What an argument decides stays with the application.
 * Reports keep declaration order, and a declared application of a refused parametric record reports nothing further.
 */
import { describe, expect, it } from 'vitest';

import { collector, type Diagnostic } from '../src/core/diagnostic.js';
import { fromString, runSync } from '../src/io/bytes.js';
import { parseSchemaDocument } from '../src/compiler/schemaParser.js';
import { resolveSchema, type SchemaResolverDeps } from '../src/compiler/schemaResolver.js';
import { canonicalizeIdentity } from '../src/link/identity.js';
import { linkSchema, type LinkDeps } from '../src/link/link.js';
import { createDefinitionMetaReader } from '../src/schema/metaReader.js';
import { createDefinitionValueReader } from '../src/schema/namespaceReader.js';
import { standardLibrary } from '../src/stdlib/index.js';

const CORE = 'https://tson.io/2026/40/m/core.tn';
const tson = standardLibrary();

/** Resolves and links `body` collecting every diagnostic, as the front door's collecting form reports them. */
function check(body: string): readonly Diagnostic[] {
  const core = tson.schemas.get(canonicalizeIdentity(CORE));
  if (core === undefined) throw new Error('core.tn is not registered');
  const resolveImport: NonNullable<LinkDeps['resolveImport']> = () => ({
    entries: core.entries,
    facts: core.facts,
    keyAnnotations: core.keyAnnotations,
    originOf: (entry) => core.origins.get(entry) ?? core.id,
    enumForms: core.enumForms,
    nameTypes: core.nameTypes,
  });
  const deps: SchemaResolverDeps = {
    readers: (lookup) => ({
      meta: createDefinitionMetaReader(lookup),
      value: createDefinitionValueReader(lookup),
    }),
    resolveImport,
  };
  const receiver = collector();
  const document = runSync(
    parseSchemaDocument(
      fromString(`!!id:"https://example.test/judged.tn" !!import:"${CORE}"\n!schema {\n${body}\n}`),
    ),
  );
  const resolved = resolveSchema(document, deps, { receiver });
  linkSchema(resolved, { resolveImport, receiver });
  return receiver.diagnostics;
}

function pointers(problems: readonly Diagnostic[]): (string | undefined)[] {
  return problems.map((problem) => problem.schemaPointer);
}

describe('a parametric record is judged once at its declaration (§5.10, §5.10.1)', () => {
  const declarations = [
    'box => <T> { v: T  w: no_such_type }',
    'box => <T> { v: T  w: [{ x: no_such_type }] }',
    'box => <T> { v: T  w: no_such_head<T> }',
    'box => <T> { v: T  next: box<T> }',
    'box => <T> { k: selector =?  v: T }',
    'box => <T> { v: T  n?: int8 ~ 500 }',
  ];
  const appliers = [
    '',
    '\n  b => box<text>',
    '\n  holder => { f: box<text> }',
    '\n  b => box<text>\n  holder => { f: box<int32> }',
  ];
  for (const declaration of declarations) {
    for (const applier of appliers) {
      // At a slot, a recursion with no declaration to tie to (§5.10.1) and an abstract record in place (§4.2) are
      // the holder's own faults.
      if (
        (declaration.includes('next: box<T>') || declaration.includes('=?')) &&
        applier.includes('holder')
      ) {
        continue;
      }
      it(`§5.10: '${declaration}' with${applier === '' ? 'out an applier' : ` ${applier.trim().replaceAll('\n', ' ')}`} is reported once, at '/box'`, () => {
        const problems = check(`${declaration}\n  selector => { k: text }${applier}`);
        expect(pointers(problems), problems.map((d) => d.message).join(' | ')).toEqual(['/box']);
      });
    }
  }

  it('§5.10: an unapplied parametric record is judged for its own text, word for word', () => {
    expect(check('box => <T> { v: T  w: no_such_type }').map((d) => d.message)).toEqual([
      "'box' field 'w' has an unresolved reference 'no_such_type'",
    ]);
    expect(check('loop => <T> { v: T  next: loop<T> }')[0]?.message).toMatch(
      /^'loop' can never be satisfied by any document: loop needs loop/,
    );
    expect(check('base => { k: text }  p => <T> { k: base =?  v: T }')[0]?.message).toMatch(
      /^'p': the discriminator 'k' is typed 'base', which is not an atom-family instance or an enum/,
    );
    expect(check('t => <T> { a: T  n?: int8 ~ 500 }')[0]?.message).toMatch(
      /^'t': field 'n' is declared 'int8', but its default 500 is not a value of that type/,
    );
  });

  it('§5.10: verdicts are reported in declaration order, a parametric record where it stands', () => {
    const problems = check(`
      first => { x: nope }
      box => <T> { v: T  w: no_such_type }
      last => { y: nada }`);
    expect(pointers(problems)).toEqual(['/first', '/box', '/last']);
  });

  it('§5.10: what a parameter decides is still judged where the application closes', () => {
    expect(check('pair => <A, B> { v: (A | B) }')).toEqual([]);
    expect(pointers(check('pair => <A, B> { v: (A | B) }  p => pair<text, text>'))).toEqual(['/p']);
  });

  it('§5.10: an unresolved argument stays with the applier', () => {
    expect(pointers(check('box => <T> { v: T }  b => box<some_typo>'))).toEqual(['/b']);
  });
});

describe('productivity at the declaration, parameters assumed inhabited (§5.10.1)', () => {
  const tree = `
    nonempty => !meta.array ^ { min_items: 1 }
    tree => <T> { value: T  children: nonempty<tree<T>> }`;

  it('§5.10.1: an uninhabited parametric record is refused at its declaration, applied or not, naming it', () => {
    for (const applier of ['', '\n  use => tree<text>']) {
      const problems = check(tree + applier);
      expect(pointers(problems)).toEqual(['/tree']);
      expect(problems[0]?.message).toMatch(/^'tree' can never be satisfied/);
    }
  });

  it('§5.10.1: the chain runs through the application the parametric record holds', () => {
    expect(check(tree)[0]?.message).toContain('tree needs tree');
  });

  it('§5.10.1: an unguarded mutual recursion is refused at the declarations, an application of it reporting nothing further', () => {
    const records = `
      a => <T> { v: T  b: b<T> }
      b => <T> { a: a<T> }`;
    for (const applier of ['', '\n  a_text => a<text>']) {
      const problems = check(records + applier);
      expect(problems[0]?.message).toContain(
        "'a' can never be satisfied by any document: a needs b needs a",
      );
      expect(pointers(problems).filter((pointer) => pointer === '/a_text')).toEqual([]);
    }
  });

  it('§5.10.1: an unguarded self recursion in a parametric record nobody applies is refused', () => {
    expect(check('loop => <T> { v: T  next: loop<T> }')[0]?.message).toContain('loop needs loop');
  });

  it('§5.10.1: a guarded recursion is productive at the declaration, applied or not', () => {
    const records = `
      linked_list => <T> { value: T  next?: linked_list<T> }
      tree        => <T> { value: T  children?: [tree<T>] }
      a           => <T> { v: T  b?: b<T> }
      b           => <T> { w: T  a: a<T> }`;
    expect(check(records)).toEqual([]);
    expect(
      check(`${records}\n  ll => linked_list<text>\n  tr => tree<int32>\n  ab => a<text>`),
    ).toEqual([]);
  });

  it('§5.10.1: a required parameter-typed field is assumed inhabited', () => {
    expect(check('box => <T> { v: T  w: [T; 1..]  p: (T | text) }')).toEqual([]);
  });
});
