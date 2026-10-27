/**
 * [TSON-SCHEMA] §2.2.3's import-level rule: **an import stands at the importer's governing
 * level.** Both schemas on an `!!import` edge name the meta-kernel as their `!!meta`, or neither
 * does. A meta layer (kernel-governed) declares the vocabulary its constructors use itself, and an
 * ordinary schema reaches a meta layer's constructors only through its own `!!meta` (§3.1), so a
 * `meta.tn`-governed schema importing the kernel or a meta layer, and a kernel-governed schema
 * importing `core.tn`, are both refused.
 *
 * Judged per edge, before the import's entries are taken, by both merges -- the resolver's (which
 * builds the namespace a declaration resolves in) and the linker's -- so neither ever holds an
 * entry the rule would refuse.
 *
 * @module
 */

import { TsonSchemaValidationError } from '../core/errors.js';
import { canonicalizeIdentity } from './identity.js';

/** One side of an `!!import` edge: the schema's identity, its `!!meta`, and whether the meta-kernel governs it. */
export interface ImportLevel {
  readonly id: string;
  readonly meta: string;
  readonly kernelGoverned: boolean;
}

/**
 * Refuses the edge `importer` → `imported` unless both stand at one governing level. A side whose
 * level is unknown (a hand-assembled import carrying no level) is not judged.
 */
export function checkImportLevel(
  importer: ImportLevel | undefined,
  imported: ImportLevel | undefined,
): void {
  if (importer === undefined || imported === undefined) return;
  if (importer.kernelGoverned === imported.kernelGoverned) return;
  throw new TsonSchemaValidationError(
    `'${importer.id}' (its !!meta '${canonicalizeIdentity(importer.meta)}') imports '${imported.id}' ` +
      `(its !!meta '${canonicalizeIdentity(imported.meta)}'), but an !!import stands at the importer's ` +
      'governing level, both schemas naming meta-kernel.tn as their !!meta or neither (§2.2.3, §3.1) -- ' +
      (importer.kernelGoverned
        ? 'a meta layer declares the vocabulary its constructors use itself'
        : "an ordinary schema reaches a meta-schema's constructors only through its !!meta"),
  );
}
