import { describe, expect, it } from 'vitest';

import { TsonNotImplementedError, TsonSchemaValidationError } from '../src/core/errors.js';
import { fromString, runSync } from '../src/io/bytes.js';
import { position, type Position } from '../src/core/position.js';
import { parseSchemaDocument } from '../src/compiler/schemaParser.js';
import {
  desugar,
  internalName,
  lifted,
  type DesugarFailureReporter,
} from '../src/compiler/desugar.js';
import type { Declaration, SchemaDocument } from '../src/ast/schema/document.js';
import type { Instance } from '../src/ast/schema/fields.js';
import type { TypeRef } from '../src/ast/schema/typeref.js';
import type { CoreValue, RecordField } from '../src/ast/value.js';

const META = '!!meta:"https://example.com/m.tn1"';

/** Parses `{ ${declarations} }` as a complete schema document body. */
function parse(declarations: string): SchemaDocument {
  return runSync(parseSchemaDocument(fromString(`${META} { ${declarations} }`)));
}

function desugarDoc(
  declarations: string,
  imported: ReadonlySet<string> = new Set(),
  reporter?: DesugarFailureReporter,
): SchemaDocument {
  return desugar(parse(declarations), imported, reporter === undefined ? {} : { reporter });
}

function declarationOf(document: SchemaDocument, name: string): Declaration {
  const declaration = document.body.declarations.get(name);
  if (declaration === undefined) throw new Error(`declaration '${name}' missing`);
  return declaration;
}

function instanceOf(document: SchemaDocument, name: string): Instance {
  const typeDef = declarationOf(document, name).typeDef;
  if (typeDef.kind !== 'instance')
    throw new Error(`'${name}' is not an instance, got ${typeDef.kind}`);
  return typeDef;
}

/** The sole injected declaration whose derived name starts with `${prefix}_`. */
function onlyInjected(document: SchemaDocument, prefix: string): Declaration {
  const matching = [...document.body.declarations.values()].filter((d) =>
    d.name.startsWith(`${prefix}_`),
  );
  expect(matching, [...document.body.declarations.keys()].join(', ')).toHaveLength(1);
  const only = matching[0];
  if (only === undefined) throw new Error('unreachable: length checked above');
  return only;
}

/** The type-ref of `declaration`'s first record field -- the use site every fixture here reads back. */
function firstFieldTypeRef(document: SchemaDocument, declaration: string): TypeRef {
  const typeDef = declarationOf(document, declaration).typeDef;
  if (typeDef.kind !== 'structuralTypeDef' || typeDef.body.kind !== 'recordDef') {
    throw new Error(`'${declaration}' is not a fresh record declaration`);
  }
  const field = typeDef.body.entries[0];
  if (field?.kind !== 'fieldDef' || field.type === undefined) {
    throw new Error(`'${declaration}' has no first field`);
  }
  return field.type.typeRef;
}

/** The bare name a field's type-ref resolves to -- every fixture here that hoists lands on a `simpleRef`. */
function firstFieldType(document: SchemaDocument, declaration: string): string {
  const ref = firstFieldTypeRef(document, declaration);
  if (ref.kind !== 'simpleRef') throw new Error(`'${declaration}' field type is not a simpleRef`);
  return ref.name;
}

/** `value` as a record's field list, or throws -- every wire value this desugarer builds is record/array/token. */
function recordFields(value: CoreValue): readonly RecordField[] {
  if (value.kind !== 'record') throw new Error(`expected a record core value, got '${value.kind}'`);
  return value.fields;
}

/** `value` as an array's elements, or throws. */
function arrayElements(value: CoreValue) {
  if (value.kind !== 'array') throw new Error(`expected an array core value, got '${value.kind}'`);
  return value.elements;
}

/** The names of a record core value's own fields, in order. */
function fieldNames(value: CoreValue): string[] {
  return recordFields(value).map((field) => field.name);
}

/** One named field's core value out of a record core value, or `undefined` when the field is absent. */
function namedField(value: CoreValue, name: string): CoreValue | undefined {
  return recordFields(value).find((field) => field.name === name)?.value.value.coreValue;
}

/** The core value at `index` of an array core value, or throws. */
function elementAt(value: CoreValue, index: number): CoreValue {
  const elements = arrayElements(value);
  const element = elements[index];
  if (element === undefined) throw new Error(`no element at index ${String(index)}`);
  return element.value.coreValue;
}

/** Reads a named field off an `!C { ... }` instance's record payload, or throws when it is absent. */
function requiredField(instance: Instance, field: string): CoreValue {
  const value = namedField(instance.value.coreValue, field);
  if (value === undefined) throw new Error(`instance has no '${field}' field`);
  return value;
}

/** Reads a named field off an `!C { ... }` instance's record payload, or `undefined` when it is absent. */
function optionalField(instance: Instance, field: string): CoreValue | undefined {
  return namedField(instance.value.coreValue, field);
}

/** A token core value's own text, or throws when `value` is not a token. */
function tokenText(value: CoreValue): string {
  if (value.kind !== 'token') throw new Error(`expected a token core value, got '${value.kind}'`);
  return value.text;
}

// ── Structural sharing (§5.3, §8.2) ─────────────────────────────────────

describe('structural sharing', () => {
  it('returns the exact same document when nothing needs expanding', () => {
    const document = parse('plain => { a: text  b: integer? }');
    expect(desugar(document, new Set())).toBe(document);
  });

  it('leaves a sugar-free declaration as the same object, and rebuilds only the one that changed', () => {
    const document = parse('plain => { a: text }\nsugared => { tags: [text] }');
    const desugared = desugar(document, new Set());
    expect(declarationOf(desugared, 'plain')).toBe(declarationOf(document, 'plain'));
    expect(declarationOf(desugared, 'sugared')).not.toBe(declarationOf(document, 'sugared'));
  });

  /**
   * The one place a rewritten declaration replaces an original, and so the one place a caller's
   * own identity-keyed position table has to be re-registered. A structural (non-identity) map
   * here would silently merge two declarations that happen to render alike, corrupting whichever
   * one's position lost the race -- which is why `positions` is typed as a `WeakMap`.
   */
  it("carries a rewritten declaration's position onto the node that replaces it, via an identity-keyed WeakMap", () => {
    const document = parse('plain => { a: text }\nsugared => { tags: [text] }');
    const plain = declarationOf(document, 'plain');
    const sugared = declarationOf(document, 'sugared');
    const plainPosition = position(3, 1, 0);
    const sugaredPosition = position(5, 1, 0);
    const positions = new WeakMap<Declaration, Position>([
      [plain, plainPosition],
      [sugared, sugaredPosition],
    ]);

    const desugared = desugar(document, new Set(), { positions });

    const after = declarationOf(desugared, 'sugared');
    expect(after).not.toBe(sugared);
    expect(positions.get(after)).toBe(sugaredPosition);

    const untouched = declarationOf(desugared, 'plain');
    expect(untouched).toBe(plain);
    expect(positions.get(untouched)).toBe(plainPosition);
  });
});

// ── The desugar table (§5.3) ─────────────────────────────────────────────

describe('the array sugar ([T] and the sized forms, §5.3)', () => {
  it('lifts an inline field-position array to an injected declaration and a bare reference', () => {
    const document = desugarDoc('holder => { xs: [text] }');
    const injected = onlyInjected(document, 'array');
    expect(firstFieldType(document, 'holder')).toBe(injected.name);
    const instance = injected.typeDef as Instance;
    expect(instance.value.typeRef).toBe('array');
    expect(tokenText(requiredField(instance, 'element_type'))).toBe('text');
  });

  it('is the construction itself at declaration position, injecting nothing alongside it', () => {
    const document = desugarDoc('ids => [text]');
    const instance = instanceOf(document, 'ids');
    expect(instance.value.typeRef).toBe('array');
    expect(tokenText(requiredField(instance, 'element_type'))).toBe('text');
    expect(document.body.declarations.size).toBe(1);
  });

  it('binds every size spelling to min_items/max_items directly', () => {
    expect(
      tokenText(requiredField(instanceOf(desugarDoc('a => [text; 1..5]'), 'a'), 'min_items')),
    ).toBe('1');
    expect(
      tokenText(requiredField(instanceOf(desugarDoc('a => [text; 1..5]'), 'a'), 'max_items')),
    ).toBe('5');
    expect(
      optionalField(instanceOf(desugarDoc('a => [text; 2..]'), 'a'), 'max_items'),
    ).toBeUndefined();
    expect(
      optionalField(instanceOf(desugarDoc('a => [text; ..9]'), 'a'), 'min_items'),
    ).toBeUndefined();
    expect(
      tokenText(requiredField(instanceOf(desugarDoc('a => [text; 3]'), 'a'), 'min_items')),
    ).toBe('3');
    expect(
      tokenText(requiredField(instanceOf(desugarDoc('a => [text; 3]'), 'a'), 'max_items')),
    ).toBe('3');
  });

  it('states state: OPTIONAL only for a marked element, letting the default supply REQUIRED', () => {
    expect(tokenText(requiredField(instanceOf(desugarDoc('a => [text?]'), 'a'), 'state'))).toBe(
      'OPTIONAL',
    );
    expect(optionalField(instanceOf(desugarDoc('a => [text]'), 'a'), 'state')).toBeUndefined();
  });

  it('rejects an incoherent size range (min > max), §5.3', () => {
    expect(() => desugarDoc('bad => [text; 5..3]')).toThrow(TsonSchemaValidationError);
    expect(() => desugarDoc('bad => [text; 5..3]')).toThrow(/min <= max/);
  });

  it('rejects a vacuous zero floor rather than desugaring it, since identity is structural (§5.3, §8.2)', () => {
    expect(() => desugarDoc('tags => [text; 0..]')).toThrow(TsonSchemaValidationError);
    expect(() => desugarDoc('tags => [text; 0..]')).toThrow(/\[text; 0\.\.\]/);
  });

  it('still treats a zero floor with a ceiling as a real constraint', () => {
    const instance = instanceOf(desugarDoc('tags => [text; 0..5]'), 'tags');
    expect(tokenText(requiredField(instance, 'min_items'))).toBe('0');
    expect(tokenText(requiredField(instance, 'max_items'))).toBe('5');
  });
});

describe('the map sugar ({K => V}, §5.3)', () => {
  it('lifts an inline field-position map to an injected declaration and a bare reference', () => {
    const document = desugarDoc('holder => { entries: {text => integer} }');
    const injected = onlyInjected(document, 'map');
    expect(firstFieldType(document, 'holder')).toBe(injected.name);
    const instance = injected.typeDef as Instance;
    expect(instance.value.typeRef).toBe('map');
    expect(tokenText(requiredField(instance, 'key_type'))).toBe('text');
    expect(tokenText(requiredField(instance, 'value_type'))).toBe('integer');
  });

  it('is the construction itself at declaration position, injecting nothing alongside it', () => {
    const document = desugarDoc('entries => {text => integer}');
    expect(instanceOf(document, 'entries').value.typeRef).toBe('map');
    expect(document.body.declarations.size).toBe(1);
  });

  it('takes the same size specifier as an array, binding neither side a state', () => {
    const instance = instanceOf(desugarDoc('bounded => {text => integer; 1..5}'), 'bounded');
    expect(tokenText(requiredField(instance, 'min_items'))).toBe('1');
    expect(tokenText(requiredField(instance, 'max_items'))).toBe('5');
    expect(optionalField(instance, 'state')).toBeUndefined();
  });

  it('rejects an incoherent size range the same way an array does', () => {
    expect(() => desugarDoc('bad => {text => integer; 5..3}')).toThrow(/min <= max/);
  });
});

describe('the tuple sugar ([T, U], §5.3)', () => {
  it('is the construction itself at declaration position', () => {
    const document = desugarDoc('pair => [integer, text]');
    const instance = instanceOf(document, 'pair');
    expect(instance.value.typeRef).toBe('tuple');
    expect(requiredField(instance, 'elements').kind).toBe('array');
  });

  it('is hoisted at a field position, exactly as inline [T] is', () => {
    const document = desugarDoc('holder => { p: [integer, text] }');
    const injected = onlyInjected(document, 'tuple');
    expect(firstFieldType(document, 'holder')).toBe(injected.name);
  });

  it("marks only an optional position's state, leaving a required one to the default", () => {
    const instance = instanceOf(desugarDoc('pair => [integer?, text]'), 'pair');
    const elements = requiredField(instance, 'elements');
    const first = elementAt(elements, 0);
    const second = elementAt(elements, 1);
    expect(fieldNames(first)).toEqual(['element_type', 'state']);
    expect(fieldNames(second)).toEqual(['element_type']);
  });
});

describe('the choice sugar ((A | B), §5.4)', () => {
  it('is the construction itself at declaration position', () => {
    const document = desugarDoc('contact => (text | integer)');
    const instance = instanceOf(document, 'contact');
    expect(instance.value.typeRef).toBe('choice');
    const variants = requiredField(instance, 'variants');
    expect(tokenText(elementAt(variants, 0))).toBe('text');
    expect(tokenText(elementAt(variants, 1))).toBe('integer');
  });
});

// ── Nesting: bottom-up, innermost first (§5.3, §12.1) ────────────────────

describe('nested declaration-level forms', () => {
  it('hoists an inner array first and refers to it from the outer map', () => {
    const document = desugarDoc('holder => { m: {text => [integer]} }');
    const inner = onlyInjected(document, 'array');
    const outer = onlyInjected(document, 'map');
    expect(tokenText(requiredField(outer.typeDef as Instance, 'value_type'))).toBe(inner.name);
  });

  it('recurses innermost-first through three levels of array nesting', () => {
    const document = desugarDoc('deep => [[[integer]]]');
    // Exactly two injected arrays (the two inner levels); the outermost is the declaration itself.
    const arrays = [...document.body.declarations.values()].filter((d) =>
      d.name.startsWith('array_'),
    );
    expect(arrays).toHaveLength(2);
    expect(instanceOf(document, 'deep').value.typeRef).toBe('array');
  });

  it('a tuple position holding a nested sized array refers to the injected inner array', () => {
    const document = desugarDoc('grid => [[integer; 2], text]');
    const inner = onlyInjected(document, 'array');
    expect(tokenText(requiredField(inner.typeDef as Instance, 'min_items'))).toBe('2');
  });
});

// ── Identity is the resolved binding record, not the spelling (§8.2) ────

describe('identity and deduplication (§8.2)', () => {
  it('two structurally identical forms share one injected declaration', () => {
    const document = desugarDoc('first => { xs: [text] }\nsecond => { ys: [text] }');
    const injected = onlyInjected(document, 'array');
    expect(firstFieldType(document, 'first')).toBe(injected.name);
    expect(firstFieldType(document, 'second')).toBe(injected.name);
  });

  it('two spellings of one binding record land on the same entry ([T; 3] and [T; 3..3])', () => {
    const document = desugarDoc('sized => [text; 3]\nranged => [text; 3..3]');
    const arrays = [...document.body.declarations.keys()].filter((n) => n.startsWith('array_'));
    expect(arrays).toEqual([]); // both are declaration-position, so nothing is injected
    expect(instanceOf(document, 'sized').value).toEqual(instanceOf(document, 'ranged').value);
  });

  it('derives the same internalName for the same head and fields, deterministically', () => {
    const fields: RecordField[] = [
      {
        name: 'element_type',
        value: {
          value: { annotations: [], coreValue: { kind: 'token', text: 'text', form: 'unquoted' } },
        },
      },
    ];
    expect(internalName('array', fields)).toBe(internalName('array', fields));
  });

  it('lifted() reports exactly the names desugaring added, in a set difference', () => {
    const original = parse('holder => { xs: [text] }');
    const desugared = desugar(original, new Set());
    const names = lifted(original, desugared);
    expect(names.size).toBe(1);
    expect([...names]).toEqual([onlyInjected(desugared, 'array').name]);
  });

  it('does not redeclare a form an import already provides -- it is referenced instead', () => {
    const name = onlyInjected(desugarDoc('holder => { xs: [text] }'), 'array').name;
    const reusing = desugarDoc('holder => { xs: [text] }', new Set([name]));
    expect(firstFieldType(reusing, 'holder')).toBe(name);
    expect([...reusing.body.declarations.keys()].some((n) => n.startsWith('array_'))).toBe(false);
  });
});

// ── §5.2's own rewrite: a bare record body inside a template ─────────────

describe("a template's bare record body (§5.2)", () => {
  it('becomes !record { fields: [...] } only inside a template, not a plain declaration', () => {
    const plain = declarationOf(desugarDoc('point => { x: integer  y: integer }'), 'point');
    expect(plain.typeDef.kind).toBe('structuralTypeDef');

    const template = instanceOf(desugarDoc('box => <T> { v: T }'), 'box');
    expect(template.value.typeRef).toBe('record');
    expect(template.typeParams).toEqual(['T']);
  });

  it("writes state and value only where the author's marks say something the default does not", () => {
    const instance = instanceOf(desugarDoc('box => <T> { v: T  count: integer ~ 0 }'), 'box');
    const fields = requiredField(instance, 'fields');
    expect(fieldNames(elementAt(fields, 0))).toEqual(['name', 'type']);
    expect(fieldNames(elementAt(fields, 1))).toEqual(['name', 'type', 'state', 'value']);
  });

  it('rejects the same field declared twice (§5.11)', () => {
    expect(() => desugarDoc('box => <T> { v: T  v: text }')).toThrow(TsonSchemaValidationError);
  });

  it("rejects a group member repeating a name already in the record's field namespace (§5.11)", () => {
    expect(() => desugarDoc('box => <T> { v: T  (v: text | w: integer) }')).toThrow(
      TsonSchemaValidationError,
    );
  });

  it('folds a field group into ordinary OPTIONAL fields plus a group entry', () => {
    const instance = instanceOf(desugarDoc('box => <T> { (a: T | b: text) }'), 'box');
    expect(arrayElements(requiredField(instance, 'fields'))).toHaveLength(2);
    expect(arrayElements(requiredField(instance, 'groups'))).toHaveLength(1);
  });
});

// ── §5.2's field-state table, exercised through a template body ─────────

describe('field-state validation (§5.2)', () => {
  it('rejects ~ _ (an absent default) on any field', () => {
    expect(() => desugarDoc('box => <T> { v: T ~ _ }')).toThrow(TsonSchemaValidationError);
  });

  it('rejects = _ on a required (non-optional) field', () => {
    expect(() => desugarDoc('box => <T> { v: T = _ }')).toThrow(TsonSchemaValidationError);
  });

  it('rejects a default on an optional field (type? ~ value)', () => {
    expect(() => desugarDoc('box => <T> { v: T? ~ 1 }')).toThrow(TsonSchemaValidationError);
  });

  it('accepts = _ on an optional field, producing OPTIONAL_FIXED with no value member', () => {
    const instance = instanceOf(desugarDoc('box => <T> { v: T? = _ }'), 'box');
    const fields = requiredField(instance, 'fields');
    expect(fieldNames(elementAt(fields, 0))).toEqual(['name', 'type', 'state']);
  });
});

// ── Parameter-bearing forms: open synthetics (§5.10) ─────────────────────

describe('open (parameter-bearing) synthetics', () => {
  it('lifts a form naming a template parameter to an open synthetic, referenced by application', () => {
    const document = desugarDoc('holder => <T> { xs: [T] }');
    const injected = onlyInjected(document, 'array');
    const instance = declarationOf(document, 'holder').typeDef as Instance;
    const xsField = elementAt(requiredField(instance, 'fields'), 0);
    const typeValue = namedField(xsField, 'type');
    if (typeValue === undefined) throw new Error("'xs' field has no type");
    expect(typeValue.kind).toBe('record');
    expect(
      tokenText(namedField(typeValue, 'name') ?? { kind: 'token', text: '', form: 'unquoted' }),
    ).toBe(injected.name);
  });

  it('renames a parameter positionally (p0, p1, ...), so alpha-equivalent forms land on one entry', () => {
    const first = onlyInjected(desugarDoc('a => <T> { xs: [T] }'), 'array').name;
    const second = onlyInjected(desugarDoc('b => <U> { xs: [U] }'), 'array').name;
    expect(first).toBe(second);
  });

  it('a concrete form inside a template still lifts closed, exactly as outside one', () => {
    const document = desugarDoc('holder => <T> { a: T  b: [text] }');
    const injected = onlyInjected(document, 'array');
    expect(injected.name.startsWith('array_text_')).toBe(true);
  });

  it('a declaration-level open sugar body is the instance template itself, not hoisted', () => {
    const document = desugarDoc('vector => <T, N> [T; N]');
    const instance = instanceOf(document, 'vector');
    expect(instance.typeParams).toEqual(['T', 'N']);
    expect(instance.value.typeRef).toBe('array');
    expect(document.body.declarations.size).toBe(1);
  });

  it('a partial application (an alias with leftover parameters) desugars to !reference { target }', () => {
    const document = desugarDoc('uuid_pair => <B> pair<text, B>');
    const instance = instanceOf(document, 'uuid_pair');
    expect(instance.value.typeRef).toBe('reference');
    expect(instance.typeParams).toEqual(['B']);
  });
});

// ── Generic application checking (§5.10, §3.3.1) ─────────────────────────

describe('template application checks', () => {
  it('rejects applying arguments to a local declaration with no type parameters', () => {
    expect(() => desugarDoc('bare => { a: text }\nuse => { f: bare<text> }')).toThrow(
      TsonSchemaValidationError,
    );
  });

  it("leaves an unresolved (unimported, undeclared) head alone -- that is a later phase's verdict", () => {
    const document = desugarDoc('use => { f: unknownHead<text> }');
    const ref = firstFieldTypeRef(document, 'use');
    expect(ref.kind).toBe('genericRef');
    expect(ref.kind === 'genericRef' && ref.name).toBe('unknownHead');
  });

  it('passes a well-formed application to a local template through untouched', () => {
    const document = desugarDoc('box => <T> { v: T }\nuse => { f: box<text> }');
    const ref = firstFieldTypeRef(document, 'use');
    expect(ref.kind).toBe('genericRef');
    expect(ref.kind === 'genericRef' && ref.name).toBe('box');
  });
});

// ── Failure reporting: one declaration's invalid sugar does not sink the document ───────────────

describe('reporter-mode failure handling', () => {
  it('fails fast (throws) with no reporter', () => {
    expect(() => desugarDoc('bad => [text; 5..3]')).toThrow(TsonSchemaValidationError);
  });

  it('reports an invalid declaration and absorbs it into a zero-field record, letting the rest of the document expand', () => {
    const reported: {
      declaration: Declaration;
      error: TsonSchemaValidationError | TsonNotImplementedError;
    }[] = [];
    const document = desugarDoc('bad => [text; 5..3]\ngood => { xs: [text] }', new Set(), {
      reportFailedDeclaration: (declaration, error) => {
        reported.push({ declaration, error });
      },
    });

    expect(reported).toHaveLength(1);
    const first = reported[0];
    expect(first?.declaration.name).toBe('bad');
    expect(first?.error).toBeInstanceOf(TsonSchemaValidationError);

    const bad = declarationOf(document, 'bad');
    expect(bad.typeDef).toEqual({
      kind: 'structuralTypeDef',
      typeParams: [],
      constructor: false,
      body: { kind: 'recordDef', entries: [] },
    });

    // The declaration that had nothing wrong with it still expanded normally.
    const injected = onlyInjected(document, 'array');
    expect(firstFieldType(document, 'good')).toBe(injected.name);
  });

  it("keeps a failed declaration's own type parameters in the absorbing stand-in", () => {
    const reported: Declaration[] = [];
    const document = desugarDoc('bad => <T> [text; 5..3]', new Set(), {
      reportFailedDeclaration: (declaration) => {
        reported.push(declaration);
      },
    });
    expect(reported).toHaveLength(1);
    const bad = declarationOf(document, 'bad');
    expect(bad.typeDef.kind).toBe('structuralTypeDef');
    expect(bad.typeDef.kind === 'structuralTypeDef' && bad.typeDef.typeParams).toEqual(['T']);
  });
});
