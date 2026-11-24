/**
 * The source speaks Revision 40's vocabulary ([TSON-SCHEMA] change log §4.3, §4.11): no comment, message or
 * identifier names a kernel entry Revision 40 removed, nor a module that held a concept it removed. A stale name
 * in a diagnostic sends an author looking for a construct that no longer exists, and a stale one in a comment
 * tells the next reader the code does something it does not.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

/** The removed kernel entries (change log §4.3) and the deleted modules that held the removed concepts. */
const REMOVED = [
  'meta.template',
  'meta.template_param',
  'meta.record_template',
  'record_template_field',
  'meta.tuple1',
  'voidable_tuple1',
  'meta.synthetic',
  '@synthetic',
  'meta.field_type_ref',
  'field_type_ref',
  'meta.reference_type',
  'allow_sibling',
  'meta.field_name',
  "kernel's `field_name`",
  'heldBody',
  'templateSubstitution',
  'syntheticMerge',
  'internalName',
  'mintedNames',
  'derivedName',
  'importedSynthetics',
  'numericIdentity',
  'refined-def',
];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.ts') ? [path] : [];
  });
}

describe('change log §4.3: the source names no removed kernel entry or concept', () => {
  const files = sources(SRC);

  it('walks the whole source tree', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it.each(REMOVED)('%s appears nowhere in src/', (removed) => {
    const hits = files.filter((file) => {
      const text = readFileSync(file, 'utf8');
      // `meta.template` is a prefix of nothing live, but `meta.template_param` is listed on its own.
      return removed === 'meta.template'
        ? /meta\.template(?![_a-z])/u.test(text)
        : text.includes(removed);
    });
    expect(hits.map((file) => file.slice(SRC.length))).toEqual([]);
  });
});
