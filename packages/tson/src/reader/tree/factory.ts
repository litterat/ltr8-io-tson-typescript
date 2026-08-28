/**
 * Wires the four structural tree readers up to the frozen {@link ValueReaderFactory} contract
 * (`reader/contracts.ts`) against `schema/meta`'s concrete {@link TypeDefinition} -- a starting point
 * for Wave 5's compiler, which builds the real per-schema {@link TreeReaderContext} (a whole-schema
 * `name -> reader` table, wired for the recursive/cyclic case) and instantiates the frozen generic
 * `Def`/`Context` parameters this way.
 *
 * **Deliberately narrow.** `atomTreeReader`/`absentTreeReader` (`atom.ts`, `absent.ts`) have no factory
 * here: choosing the right `AtomType` for a resolved atom body means walking the whole built-in
 * vocabulary table (§5, ~30 constructors) plus a schema's own atom refinements, which is compiler work,
 * not tree-reader work -- see this package's own work-package report.
 */
import type { SchemaLocation } from '../../core/diagnostic.js';
import type { TypeDefinition, Top } from '../../schema/meta/typedef.js';
import type { ArrayBody, MapBody, RecordBody, TupleBody } from '../../schema/meta/bodies.js';
import type { ValueReaderFactory } from '../contracts.js';
import { recordTreeReader } from './record.js';
import { mapTreeReader } from './map.js';
import { arrayTreeReader } from './array.js';
import { tupleTreeReader } from './tuple.js';
import type { TreeTypeResolver } from './support.js';

/**
 * The tree-mode compilation environment a {@link ValueReaderFactory} needs: the whole-schema
 * `name -> reader` table (built once, ahead of any individual reader, so a cyclic schema resolves) and
 * where a named entry's own declaration sits, for {@link SchemaLocation}-anchored diagnostics.
 */
export interface TreeReaderContext {
  readonly resolve: TreeTypeResolver;
  readonly locationOf: (name: string, definition: TypeDefinition) => SchemaLocation;
}

/** A body's own constructor name for an error message -- `Top`'s one member with none, `TemplateBody`, renders as a fixed label instead. */
function bodyKindLabel(body: Top): string {
  return 'kind' in body ? body.kind : 'an open template body';
}

function isRecordBody(body: Top): body is RecordBody {
  return 'kind' in body && body.kind === 'record';
}

function isMapBody(body: Top): body is MapBody {
  return 'kind' in body && body.kind === 'map';
}

function isArrayBody(body: Top): body is ArrayBody {
  return 'kind' in body && body.kind === 'array';
}

function isTupleBody(body: Top): body is TupleBody {
  return 'kind' in body && body.kind === 'tuple';
}

/** Builds the tree reader for one `record`-shaped resolved entry. */
export const recordReaderFactory: ValueReaderFactory<TypeDefinition, TreeReaderContext> = {
  create(name, definition, context) {
    if (!isRecordBody(definition.body)) {
      throw new Error(`'${name}' is not record-shaped: '${bodyKindLabel(definition.body)}'`);
    }
    return recordTreeReader(
      name,
      name,
      definition.body,
      (field) => context.resolve(field.type.name),
      context.locationOf(name, definition),
    );
  },
};

/** Builds the tree reader for one `map`-shaped resolved entry. */
export const mapReaderFactory: ValueReaderFactory<TypeDefinition, TreeReaderContext> = {
  create(name, definition, context) {
    if (!isMapBody(definition.body)) {
      throw new Error(`'${name}' is not map-shaped: '${bodyKindLabel(definition.body)}'`);
    }
    return mapTreeReader(
      name,
      name,
      definition.body,
      context.resolve,
      context.locationOf(name, definition),
    );
  },
};

/** Builds the tree reader for one `array`-shaped resolved entry. */
export const arrayReaderFactory: ValueReaderFactory<TypeDefinition, TreeReaderContext> = {
  create(name, definition, context) {
    if (!isArrayBody(definition.body)) {
      throw new Error(`'${name}' is not array-shaped: '${bodyKindLabel(definition.body)}'`);
    }
    return arrayTreeReader(
      name,
      name,
      definition.body,
      context.resolve,
      context.locationOf(name, definition),
    );
  },
};

/** Builds the tree reader for one `tuple`-shaped resolved entry. */
export const tupleReaderFactory: ValueReaderFactory<TypeDefinition, TreeReaderContext> = {
  create(name, definition, context) {
    if (!isTupleBody(definition.body)) {
      throw new Error(`'${name}' is not tuple-shaped: '${bodyKindLabel(definition.body)}'`);
    }
    return tupleTreeReader(
      name,
      name,
      definition.body,
      context.resolve,
      context.locationOf(name, definition),
    );
  },
};
