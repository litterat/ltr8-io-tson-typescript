import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * A conformance-suite processing layer: `lexer`, `parser`, `reader`, `resolver`, `vocabulary`.
 * Also the directory name under `tests/<class>/` (see {@link discoverVectors}). This is a
 * *pipeline stage*, not one of §8.1's four error categories — RUNNER.md rule 3 is explicit that
 * the two do not coincide (the vocabulary layer raises `resolver` and `validation` errors and
 * never a "vocabulary" one), and `sidecar.ts`'s `Category` type is the other vocabulary.
 */
export type Layer = 'lexer' | 'parser' | 'reader' | 'resolver' | 'vocabulary';

/**
 * Every layer the suite defines, in the order the runner reports them — matching the reference
 * implementation's own `@TestFactory` declaration order in `ConformanceSuiteTest`.
 */
export const LAYERS: readonly Layer[] = ['lexer', 'parser', 'reader', 'resolver', 'vocabulary'];

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
  /**
   * The vector's own display name: `<layer>/<bucket>/<slug>` under `class1/`, or
   * `proposed/<layer>/<bucket>/<slug>` under `proposed/` — see {@link proposed}.
   */
  readonly name: string;
  /**
   * Whether this vector lives under `proposed/` rather than `class1/`. RUNNER.md: a runner
   * SHOULD execute these but MUST report them separately, and "never count toward a conformance
   * claim" — {@link name}'s own `proposed/` prefix is what keeps them visibly apart in test
   * output, and `runner.test.ts` registers them in their own top-level `describe` block besides.
   */
  readonly proposed: boolean;
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
 * `.references/` is gitignored and populated by `scripts/fetch-references.sh`, which CI runs and
 * a cloud session's SessionStart hook runs. It is `false` in a bare clone where neither has. The
 * conformance project skips entirely rather than failing when it is — see `runner.test.ts`'s
 * top-level `describe.skipIf`.
 */
export function suiteAvailable(): boolean {
  return existsSync(SUITE_TESTS_ROOT);
}

const EXPECTED_SUFFIX = '-expected.tn';

/**
 * Walks `<root>/<bucket>/` for one layer directory and returns every subject/sidecar pair found
 * there, sorted by bucket then slug for a stable test order.
 *
 * A `*.tn` file is a subject unless its name ends `-expected.tn`, in which case it is a sidecar
 * and is paired with the subject sharing its slug. Buckets are whichever subdirectories exist
 * under `root` (`valid`, `invalid`, and — `parser` only — `schema-document`); a layer directory
 * that does not exist yields no vectors rather than throwing.
 */
function walkLayerRoot(
  root: string,
  layer: Layer,
  namePrefix: string,
  proposed: boolean,
): Vector[] {
  if (!existsSync(root)) {
    return [];
  }

  const buckets = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const vectors: Vector[] = [];
  for (const bucket of buckets) {
    const bucketDir = `${root}/${bucket}`;
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
        name: `${namePrefix}/${bucket}/${slug}`,
        proposed,
      });
    }
  }
  return vectors;
}

/**
 * Every vector for one layer under `tests/class1/<layer>/`.
 *
 * `class2/` is deliberately never walked here: RUNNER.md's second legitimate skip ground — "a
 * `class2/` vector under a Class 1 processor" — is "declared by conformance class, not per
 * vector", and this project claims only [TSON-DATA]'s Class 1 (see `CLAUDE.md`: "the data-format
 * processor"). There is nothing to enumerate or skip one vector at a time; the declaration is
 * this function's own signature never looking there.
 */
export function discoverVectors(layer: Layer): Vector[] {
  return walkLayerRoot(`${SUITE_TESTS_ROOT}/class1/${layer}`, layer, layer, false);
}

/**
 * Every vector for one layer under `tests/proposed/<layer>/` — RUNNER.md's `proposed/`, for spec
 * questions the current revision leaves open. Executed like any other vector (`runner.test.ts`
 * registers them in their own `describe` block, per {@link Vector.proposed}'s own doc), but never
 * counted toward a conformance claim: "failing one is not a defect... it means an implementation
 * made the other reasonable choice."
 */
export function discoverProposedVectors(layer: Layer): Vector[] {
  return walkLayerRoot(`${SUITE_TESTS_ROOT}/proposed/${layer}`, layer, `proposed/${layer}`, true);
}

/** {@link discoverVectors} over every layer in {@link LAYERS}, concatenated in layer order. */
export function discoverAllVectors(): Vector[] {
  return LAYERS.flatMap((layer) => discoverVectors(layer));
}
