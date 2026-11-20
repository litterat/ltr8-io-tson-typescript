import { describe, expect, it } from 'vitest';

import {
  TsonNotImplementedError,
  TsonParseError,
  TsonSchemaValidationError,
} from '../src/core/errors.js';
import { fromString, runSync } from '../src/io/bytes.js';
import { position, type Position } from '../src/core/position.js';
import { parseSchemaDocument } from '../src/compiler/schemaParser.js';
import { desugar, type DesugarFailureReporter } from '../src/compiler/desugar.js';
import type { Declaration, SchemaDocument } from '../src/ast/schema/document.js';
import type { Instance } from '../src/ast/schema/fields.js';
import type { FieldTypeExpr } from '../src/ast/schema/typeref.js';
import type { CoreValue, DataValue, RecordField } from '../src/ast/value.js';

/**
 * [TSON-SCHEMA] §5.3's sugar, written in place (§4.2): at a declaration's body a form is the construction it denotes,
 * an instance; at a field's type it is that construction held where it is written, and nested inside another
 * construction it is the `{ of: !C { … } }` the type slot holds. Nothing is lifted to an entry and nothing is named.
 */

/** Parses `!schema { ${declarations} }` as a complete schema document body. */
function parse(declarations: string): SchemaDocument {
  return runSync(parseSchemaDocument(fromString(`!schema { ${declarations} }`)));
}

function desugarDoc(declarations: string, reporter?: DesugarFailureReporter): SchemaDocument {
  return desugar(parse(declarations), reporter === undefined ? {} : { reporter });
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

/** The type-ref of `declaration`'s first record field -- the use site every fixture here reads back. */
function firstFieldTypeRef(document: SchemaDocument, declaration: string): FieldTypeExpr {
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

/** The construction `declaration`'s first field holds in place. */
function firstFieldConstruction(document: SchemaDocument, declaration: string): DataValue {
  const ref = firstFieldTypeRef(document, declaration);
  if (ref.kind !== 'inlineConstruction') {
    throw new Error(`'${declaration}' field type is no construction in place, got ${ref.kind}`);
  }
  return ref.value;
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
  return recordFields(value).find((field) => field.name === name)?.value.coreValue;
}

/** One named field's data value out of a record core value, or throws. */
function namedValue(value: CoreValue, name: string): DataValue {
  const found = recordFields(value).find((field) => field.name === name)?.value;
  if (found === undefined) throw new Error(`no field '${name}'`);
  return found;
}

/** The value of the field map entry at `index` (`record.fields` is a map keyed by name, §5.2), or throws. */
function fieldAt(value: CoreValue, index: number): CoreValue {
  if (value.kind !== 'map') throw new Error(`expected a field map, got '${value.kind}'`);
  const entry = value.entries[index];
  if (entry === undefined) throw new Error(`no field at index ${String(index)}`);
  return entry.value.coreValue;
}

/** The entries of a field map core value, or throws. */
function fieldEntries(value: CoreValue) {
  if (value.kind !== 'map') throw new Error(`expected a field map, got '${value.kind}'`);
  return value.entries;
}

/** The core value at `index` of an array core value, or throws. */
function elementAt(value: CoreValue, index: number): CoreValue {
  const elements = arrayElements(value);
  const element = elements[index];
  if (element === undefined) throw new Error(`no element at index ${String(index)}`);
  return element.coreValue;
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

/** The construction a type slot holds in place, `{ of: !C { … } }` (§4.2), or throws. */
function inPlace(value: CoreValue): DataValue {
  return namedValue(value, 'of');
}

// ── Structural sharing (§5.3, §8.2) ─────────────────────────────────────

describe('structural sharing', () => {
  it('returns the exact same document when nothing needs expanding', () => {
    const document = parse('plain => { a: text  b: integer? }');
    expect(desugar(document)).toBe(document);
  });

  it('leaves a sugar-free declaration as the same object, and rebuilds only the one that changed', () => {
    const document = parse('plain => { a: text }\nsugared => { tags: [text] }');
    const desugared = desugar(document);
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

    const desugared = desugar(document, { positions });

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
  it('holds a field-position array in place as the construction it denotes, adding no declaration', () => {
    const document = desugarDoc('holder => { xs: [text] }');
    const construction = firstFieldConstruction(document, 'holder');
    expect(construction.typeRef).toBe('meta.array');
    expect(tokenText(namedValue(construction.coreValue, 'element_type').coreValue)).toBe('text');
    expect(document.body.declarations.size).toBe(1);
  });

  it('is the construction itself at declaration position, injecting nothing alongside it', () => {
    const document = desugarDoc('ids => [text]');
    const instance = instanceOf(document, 'ids');
    expect(instance.value.typeRef).toBe('meta.array');
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

  it('states voidable: true only for a marked element, letting the default supply false (§5.3)', () => {
    expect(tokenText(requiredField(instanceOf(desugarDoc('a => [text?]'), 'a'), 'voidable'))).toBe(
      'true',
    );
    expect(optionalField(instanceOf(desugarDoc('a => [text]'), 'a'), 'voidable')).toBeUndefined();
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
  it('holds a field-position map in place as the construction it denotes', () => {
    const document = desugarDoc('holder => { entries: {text => integer} }');
    const construction = firstFieldConstruction(document, 'holder');
    expect(construction.typeRef).toBe('meta.map');
    expect(tokenText(namedValue(construction.coreValue, 'key_type').coreValue)).toBe('text');
    expect(tokenText(namedValue(construction.coreValue, 'value_type').coreValue)).toBe('integer');
    expect(document.body.declarations.size).toBe(1);
  });

  it('is the construction itself at declaration position, injecting nothing alongside it', () => {
    const document = desugarDoc('entries => {text => integer}');
    expect(instanceOf(document, 'entries').value.typeRef).toBe('meta.map');
    expect(document.body.declarations.size).toBe(1);
  });

  it('takes the same size specifier as an array, binding neither side voidable', () => {
    const instance = instanceOf(desugarDoc('bounded => {text => integer; 1..5}'), 'bounded');
    expect(tokenText(requiredField(instance, 'min_items'))).toBe('1');
    expect(tokenText(requiredField(instance, 'max_items'))).toBe('5');
    expect(optionalField(instance, 'voidable')).toBeUndefined();
  });
});

describe('the tuple sugar ([T, U], §5.3)', () => {
  it('is the construction itself at declaration position', () => {
    const document = desugarDoc('pair => [integer, text]');
    const instance = instanceOf(document, 'pair');
    expect(instance.value.typeRef).toBe('meta.tuple');
    expect(requiredField(instance, 'elements').kind).toBe('array');
  });

  it('is held in place at a field position, exactly as [T] is', () => {
    const document = desugarDoc('holder => { p: [integer, text] }');
    expect(firstFieldConstruction(document, 'holder').typeRef).toBe('meta.tuple');
    expect(document.body.declarations.size).toBe(1);
  });

  it('marks only a voidable position as voidable, leaving the other to the default (§5.3)', () => {
    const instance = instanceOf(desugarDoc('pair => [integer?, text]'), 'pair');
    const elements = requiredField(instance, 'elements');
    const first = elementAt(elements, 0);
    const second = elementAt(elements, 1);
    expect(fieldNames(first)).toEqual(['element_type', 'voidable']);
    expect(fieldNames(second)).toEqual(['element_type']);
  });
});

describe('the choice sugar ((A | B), §5.4)', () => {
  it('is the construction itself at declaration position', () => {
    const document = desugarDoc('contact => (text | integer)');
    const instance = instanceOf(document, 'contact');
    expect(instance.value.typeRef).toBe('meta.choice');
    const variants = requiredField(instance, 'variants');
    expect(tokenText(elementAt(variants, 0))).toBe('text');
    expect(tokenText(elementAt(variants, 1))).toBe('integer');
  });
});

// ── Nesting: a form inside a construction is the type slot's `{ of: … }` (§4.2) ────────────────

describe('nested forms', () => {
  it('an inner array stands in place at the outer map’s value slot', () => {
    const document = desugarDoc('holder => { m: {text => [integer]} }');
    const outer = firstFieldConstruction(document, 'holder');
    expect(outer.typeRef).toBe('meta.map');
    const inner = inPlace(namedValue(outer.coreValue, 'value_type').coreValue);
    expect(inner.typeRef).toBe('meta.array');
    expect(tokenText(namedValue(inner.coreValue, 'element_type').coreValue)).toBe('integer');
  });

  it('nests through three levels of arrays, each level in place at the one around it', () => {
    const document = desugarDoc('deep => [[[integer]]]');
    expect(document.body.declarations.size).toBe(1);
    const outer = instanceOf(document, 'deep');
    expect(outer.value.typeRef).toBe('meta.array');
    const middle = inPlace(requiredField(outer, 'element_type'));
    const innermost = inPlace(namedValue(middle.coreValue, 'element_type').coreValue);
    expect(innermost.typeRef).toBe('meta.array');
    expect(tokenText(namedValue(innermost.coreValue, 'element_type').coreValue)).toBe('integer');
  });

  it('a tuple position holding a sized array holds the array in place', () => {
    const document = desugarDoc('grid => [[integer; 2], text]');
    const first = elementAt(requiredField(instanceOf(document, 'grid'), 'elements'), 0);
    const inner = inPlace(namedValue(first, 'element_type').coreValue);
    expect(tokenText(namedValue(inner.coreValue, 'min_items').coreValue)).toBe('2');
  });
});

// ── Identity is the construction, not the spelling (§8.2) ────────────────────────────────────

describe('identity (§8.2)', () => {
  it('two spellings of one size build one construction ([T; 3] and [T; 3..3])', () => {
    const exact = instanceOf(desugarDoc('a => [text; 3]'), 'a');
    const range = instanceOf(desugarDoc('a => [text; 3..3]'), 'a');
    expect(exact.value).toEqual(range.value);
  });
});

// ── A record written in place (§5.2, §5.11) ───────────────────────────────────────────────────

describe('a record written in place (§4.2, §5.2)', () => {
  it('is a !meta.record construction at a field’s type; a declaration’s own record body stays braces', () => {
    const plain = declarationOf(desugarDoc('point => { x: integer  y: integer }'), 'point');
    expect(plain.typeDef.kind).toBe('structuralTypeDef');
    const construction = firstFieldConstruction(desugarDoc('w => { r: { a: int32 } }'), 'w');
    expect(construction.typeRef).toBe('meta.record');
  });

  it("writes optional/voidable/role/value only where the author's marks say something the default does not", () => {
    const record = firstFieldConstruction(
      desugarDoc('w => { r: { v: text  count?: integer ~ 0 } }'),
      'w',
    );
    const fields = namedValue(record.coreValue, 'fields').coreValue;
    expect(fieldNames(fieldAt(fields, 0))).toEqual(['type']);
    expect(fieldNames(fieldAt(fields, 1))).toEqual(['type', 'optional', 'role', 'value']);
  });

  it('rejects the same field declared twice (§5.11)', () => {
    expect(() => desugarDoc('w => { r: { v: text  v: int32 } }')).toThrow(
      TsonSchemaValidationError,
    );
  });

  it("rejects a group member repeating a name already in the record's field namespace (§5.11)", () => {
    expect(() => desugarDoc('w => { r: { v: text  (v: text | x: integer) } }')).toThrow(
      TsonSchemaValidationError,
    );
  });

  it('folds a field group into ordinary optional fields plus a group entry (§5.11)', () => {
    const record = firstFieldConstruction(desugarDoc('w => { r: { (a: text | b: int32) } }'), 'w');
    expect(fieldEntries(namedValue(record.coreValue, 'fields').coreValue)).toHaveLength(2);
    expect(arrayElements(namedValue(record.coreValue, 'groups').coreValue)).toHaveLength(1);
  });

  /** The `index`th group of the record written in place at `w`'s first field. */
  function groupOf(source: string, index = 0): CoreValue {
    const record = firstFieldConstruction(desugarDoc(`w => { r: ${source} }`), 'w');
    return elementAt(namedValue(record.coreValue, 'groups').coreValue, index);
  }

  function present(value: CoreValue | undefined): CoreValue {
    if (value === undefined) throw new Error('expected the field to be present');
    return value;
  }

  /** The tokens of an array-of-names core value, as text. */
  function names(value: CoreValue | undefined): string[] {
    if (value === undefined) throw new Error('expected a list of names');
    return arrayElements(value).map((element) => tokenText(element.coreValue));
  }

  it('writes a group as its options, the members marked optional within them, and its own mark (§5.11)', () => {
    const plain = groupOf('{ (a: text  b?: text | c: text) }');
    expect(fieldNames(plain)).toEqual(['members', 'optional_members']);
    const options = namedField(plain, 'members');
    expect(options === undefined ? [] : arrayElements(options)).toHaveLength(2);
    expect(names(namedField(plain, 'optional_members'))).toEqual(['b']);

    const optional = groupOf('{ (a: text | b: text)? }');
    expect(fieldNames(optional)).toEqual(['members', 'optional']);
    expect(tokenText(present(namedField(optional, 'optional')))).toBe('true');
  });

  it('lowers "+" to one option holding every member, each marked optional, on a group that is not optional (§5.11)', () => {
    const group = groupOf('{ (a: text | b: text)+ }');
    const options = namedField(group, 'members');
    expect(options === undefined ? [] : arrayElements(options)).toHaveLength(1);
    expect(names(elementAt(present(options), 0))).toEqual(['a', 'b']);
    expect(names(namedField(group, 'optional_members'))).toEqual(['a', 'b']);
    expect(namedField(group, 'optional')).toBeUndefined();
  });
});

// ── A dependent type is written in place (§5.2) ───────────────────────────────────────────────

describe('a dependent type (§4.2, §5.2)', () => {
  it("'kind!' at a field's type is the construction !meta.dependent { on: kind } in place", () => {
    const document = desugarDoc('w => { v: kind!  kind: meta.type_ref }');
    const construction = firstFieldConstruction(document, 'w');
    expect(construction.typeRef).toBe('meta.dependent');
    expect(tokenText(namedValue(construction.coreValue, 'on').coreValue)).toBe('kind');
  });
});

// ── §5.2's field-state table, exercised through a template body ─────────

describe('field-marks validation (§5.2)', () => {
  it("the void sentinel '_' is no modifier value: '~ _' and '= _' are parse errors, not resolver errors", () => {
    expect(() => desugarDoc('w => { r: { v?: text ~ _ } }')).toThrow(TsonParseError);
    expect(() => desugarDoc('w => { r: { v: text = _ } }')).toThrow(TsonParseError);
  });

  it('rejects a default on an unmarked name (name: type ~ value)', () => {
    expect(() => desugarDoc('w => { r: { v: text ~ 1 } }')).toThrow(TsonSchemaValidationError);
  });

  it('rejects a pin on a voidable type (name?: type? = value)', () => {
    expect(() => desugarDoc('w => { r: { v?: text? = "x" } }')).toThrow(TsonSchemaValidationError);
  });

  it('`v?: void?` writes optional and voidable and no value member', () => {
    const record = firstFieldConstruction(desugarDoc('w => { r: { v?: void? } }'), 'w');
    const fields = namedValue(record.coreValue, 'fields').coreValue;
    expect(fieldNames(fieldAt(fields, 0))).toEqual(['type', 'optional', 'voidable']);
  });

  it("the selector '=?' on an unmarked, non-voidable name writes no facet beyond its type (it stays FREE, unpinned)", () => {
    const record = firstFieldConstruction(
      desugarDoc('w => { r: { v: text  kind: text =? } }'),
      'w',
    );
    const fields = namedValue(record.coreValue, 'fields').coreValue;
    expect(fieldNames(fieldAt(fields, 1))).toEqual(['type']);
  });
});

// ── Parametric records (§5.10) ───────────────────────────────────────────────────────────────

describe('parametric records (§5.10)', () => {
  it('a form naming a parameter stays in place in the parametric record, the parameter as written', () => {
    const document = desugarDoc('holder => <T> { xs: [T] }');
    const construction = firstFieldConstruction(document, 'holder');
    expect(tokenText(namedValue(construction.coreValue, 'element_type').coreValue)).toBe('T');
    expect(document.body.declarations.size).toBe(1);
  });

  it('a parametric record’s body is a record body: a parameter list before an array is refused', () => {
    expect(() => desugarDoc('vector => <T> [T; 3]')).toThrow(
      /a parametric record's body is a record body/,
    );
  });

  it('a partial application -- a parameter list before a reference -- is refused: there are no parametric aliases', () => {
    expect(() => desugarDoc('pair => <A B> { a: A  b: B }\nuuid_pair => <B> pair<text B>')).toThrow(
      TsonSchemaValidationError,
    );
  });

  it('rejects applying arguments to a local declaration with no type parameters', () => {
    expect(() => desugarDoc('bare => { a: text }\nuse => { f: bare<text> }')).toThrow(
      /declares no type parameters/,
    );
  });

  it("leaves an unresolved (unimported, undeclared) head alone -- that is a later phase's verdict", () => {
    const ref = firstFieldTypeRef(desugarDoc('use => { f: unknownHead<text> }'), 'use');
    expect(ref.kind === 'applicationRef' && ref.name).toBe('unknownHead');
  });

  it('passes a well-formed application of a local parametric record through untouched', () => {
    const ref = firstFieldTypeRef(
      desugarDoc('box => <T> { v: T }\nuse => { f: box<text> }'),
      'use',
    );
    expect(ref.kind === 'applicationRef' && ref.name).toBe('box');
  });
});

// ── Failure reporting: one declaration's invalid sugar does not sink the document ───────────────

describe('reporter-mode failure handling', () => {
  it('fails fast (throws) with no reporter', () => {
    expect(() => desugarDoc('bad => [text; 0..]')).toThrow(TsonSchemaValidationError);
  });

  it('reports an invalid declaration and absorbs it into a zero-field record, letting the rest of the document expand', () => {
    const reported: {
      declaration: Declaration;
      error: TsonSchemaValidationError | TsonNotImplementedError;
    }[] = [];
    const document = desugarDoc('bad => [text; 0..]\ngood => { xs: [text] }', {
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
      body: { kind: 'recordDef', entries: [] },
    });

    // The declaration that had nothing wrong with it still expanded normally.
    expect(firstFieldConstruction(document, 'good').typeRef).toBe('meta.array');
  });

  it("keeps a failed declaration's own type parameters in the absorbing stand-in", () => {
    const reported: Declaration[] = [];
    const document = desugarDoc('bad => <T> { v: [T; 0..] }', {
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
