import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * A conformance-suite layer, mirroring the spec's own §8.1 error categories: `lexer`,
 * `parser`, `resolver`, `vocabulary`. Also the top-level directory name under
 * `.references/ltr8-io-tson-test-suite/tests/`.
 */
export type Layer = 'lexer' | 'parser' | 'resolver' | 'vocabulary';

/** Every layer the suite defines, in the order the runner reports them. */
export const LAYERS: readonly Layer[] = ['lexer', 'parser', 'resolver', 'vocabulary'];

/**
 * One conformance vector: a subject `.tn` file paired with its sidecar.
 *
 * Discovered purely by directory walk and naming convention — there is no manifest. See
 * {@link discoverVectors}.
 */
export interface Vector {
  /** The conformance layer this vector belongs to. */
  readonly layer: Layer;
  /** The bucket directory name (`valid`, `invalid`, or `schema-document` under `parser`). */
  readonly bucket: string;
  /** The vector's stable slug, e.g. `escape-basic`. */
  readonly slug: string;
  /** Absolute path to the subject `.tn` file. */
  readonly subjectPath: string;
  /** Absolute path to the sidecar `<slug>-expected.tn` file. */
  readonly sidecarPath: string;
  /** `<layer>/<bucket>/<slug>`, the vector's own display name. */
  readonly name: string;
}

/**
 * Absolute path to the suite's `tests/` root, as populated by `scripts/fetch-references.sh`
 * into the gitignored `.references/` directory.
 */
export const SUITE_TESTS_ROOT: string = fileURLToPath(
  new URL('../../.references/ltr8-io-tson-test-suite/tests', import.meta.url),
);

/**
 * Whether the shared test-suite checkout is present.
 *
 * `.references/` is gitignored and populated by `scripts/fetch-references.sh`; CI does not
 * run that script, so this is `false` there. The conformance project skips entirely rather
 * than failing when it is — see `runner.test.ts`'s top-level `describe.skipIf`.
 */
export function suiteAvailable(): boolean {
  return existsSync(SUITE_TESTS_ROOT);
}

const EXPECTED_SUFFIX = '-expected.tn';

/**
 * Walks `.references/ltr8-io-tson-test-suite/tests/<layer>/<bucket>/` for one layer and
 * returns every subject/sidecar pair found there, sorted by bucket then slug for a stable
 * test order.
 *
 * A `*.tn` file is a subject unless its name ends `-expected.tn`, in which case it is a
 * sidecar and is paired with the subject sharing its slug. Buckets are whichever
 * subdirectories exist under the layer (`valid`, `invalid`, and — `parser` only —
 * `schema-document`); a layer directory that does not exist yields no vectors rather than
 * throwing, so a caller can check {@link suiteAvailable} once and call this per layer.
 */
export function discoverVectors(layer: Layer): Vector[] {
  const layerRoot = `${SUITE_TESTS_ROOT}/${layer}`;
  if (!existsSync(layerRoot)) {
    return [];
  }

  const buckets = readdirSync(layerRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const vectors: Vector[] = [];
  for (const bucket of buckets) {
    const bucketDir = `${layerRoot}/${bucket}`;
    const subjects = readdirSync(bucketDir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() && entry.name.endsWith('.tn') && !entry.name.endsWith(EXPECTED_SUFFIX),
      )
      .map((entry) => entry.name)
      .sort();

    for (const fileName of subjects) {
      const slug = fileName.slice(0, -'.tn'.length);
      vectors.push({
        layer,
        bucket,
        slug,
        subjectPath: `${bucketDir}/${fileName}`,
        sidecarPath: `${bucketDir}/${slug}${EXPECTED_SUFFIX}`,
        name: `${layer}/${bucket}/${slug}`,
      });
    }
  }
  return vectors;
}

/** {@link discoverVectors} over every layer in {@link LAYERS}, concatenated in layer order. */
export function discoverAllVectors(): Vector[] {
  return LAYERS.flatMap((layer) => discoverVectors(layer));
}
