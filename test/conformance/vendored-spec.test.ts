import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `spec/` holds verbatim copies of the reference implementation's spec snapshots and bundled
 * schemas. This checks they have not drifted from the pinned checkout.
 *
 * Drift matters in two different ways. An edited `m/*.tn` invalidates the `*-resolved.tn`
 * fixtures it was resolved into, since those carry content digests — the Wave 3 gate would then
 * be measuring the port against a target that no longer exists upstream. An edited spec snapshot
 * is quieter and worse: every `§` citation in the source would refer to a document that says
 * something the reference implementation never agreed to.
 *
 * This is a copy-integrity check, not a version check. Moving the pin is expected to change
 * these files; doing it without re-copying is what this catches.
 */

const VENDORED_ROOT = fileURLToPath(new URL('../../spec', import.meta.url));
const REFERENCE_ROOT = fileURLToPath(
  new URL('../../.references/ltr8-io-tson-java/spec', import.meta.url),
);

/** Files authored here rather than copied, and so exempt from the comparison. */
const LOCAL_ONLY = new Set(['PROVENANCE.md']);

function referenceAvailable(): boolean {
  return existsSync(REFERENCE_ROOT);
}

/** Every vendored file, as a path relative to `spec/`. */
function vendoredFiles(): string[] {
  const out: string[] = [];
  const walk = (relative: string): void => {
    const absolute = relative === '' ? VENDORED_ROOT : join(VENDORED_ROOT, relative);
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (!LOCAL_ONLY.has(child)) out.push(child);
    }
  };
  walk('');
  return out.sort();
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe.skipIf(!referenceAvailable())('vendored spec files', () => {
  const files = vendoredFiles();

  it('vendors the two spec parts and all six bundled schemas', () => {
    expect(files).toEqual([
      'm/core-resolved.tn',
      'm/core.tn',
      'm/meta-kernel-resolved.tn',
      'm/meta-kernel.tn',
      'm/meta-resolved.tn',
      'm/meta.tn',
      'tson-part1-data.md',
      'tson-part2-schema.md',
    ]);
  });

  it.each(files)('%s is byte-identical to the pinned checkout', (relative) => {
    const reference = join(REFERENCE_ROOT, relative);
    expect(existsSync(reference), `${relative} is missing from the pinned checkout`).toBe(true);
    expect(sha256(join(VENDORED_ROOT, relative))).toBe(sha256(reference));
  });
});

describe('vendored spec files, without the reference checkout', () => {
  // These hold whether or not `.references/` is present: the point of vendoring is that the
  // spec and the bundled schemas are readable from a bare clone.

  it('are present in the repository', () => {
    expect(existsSync(join(VENDORED_ROOT, 'tson-part1-data.md'))).toBe(true);
    expect(existsSync(join(VENDORED_ROOT, 'm/meta-kernel.tn'))).toBe(true);
  });

  it('record the spec revision the port is written against', () => {
    const part1 = readFileSync(join(VENDORED_ROOT, 'tson-part1-data.md'), 'utf8');
    const part2 = readFileSync(join(VENDORED_ROOT, 'tson-part2-schema.md'), 'utf8');
    expect(part1).toContain('2026 Revision 34');
    expect(part2).toContain('2026 Revision 34');
  });
});
