/**
 * Bridges `class2/link/` vectors -- [TSON-SCHEMA] §2.2.3's import closure, §5.4's derived
 * disjointness, §8.2's `subtypes` index -- to this implementation's real `Tson.resolveSchema`.
 *
 * Unlike `schema.ts`'s `class2/schema/` layer, this one states individual facts about the linked
 * namespace rather than comparing a whole resolved document: `link-sidecar.tn`'s own doc explains
 * why (a vector exercising one of §2.2.3/§5.4/§8.2 should not have to restate every entry of
 * `core.tn` to do it).
 */
import { expect } from 'vitest';

import type { LinkedSchema } from '../../packages/tson/src/link/link.js';
import type { TypeDefinition } from '../../packages/tson/src/schema/meta/typedef.js';

import { newClass2Tson } from './class2Tson.js';
import { assertSchemaOrLinkLoadFailed } from './schema.js';
import { normalizeSyntheticName } from './synthetic.js';
import type { LinkSidecar, LinkValid } from './sidecar.js';
import type { Class2Layer, Vector } from './vectors.js';

function definitionOf(
  vector: Vector<Class2Layer>,
  entries: LinkedSchema['entries'],
  name: string,
): TypeDefinition {
  const definition = entries.get(name);
  if (definition === undefined) {
    throw new Error(
      `${vector.name}: the linked namespace binds no entry '${name}' (has: ${[...entries.keys()].join(', ')})`,
    );
  }
  return definition;
}

/**
 * What linking makes of a schema that has already resolved: §2.2.3's import closure (`binds`),
 * §5.4's derived, two-valued disjointness (`disjoint`), and §8.2's resolver-managed `subtypes`
 * index. Each is optional in the sidecar -- a vector states only what it is about.
 */
function assertLinkedNamespaceMatches(
  vector: Vector<Class2Layer>,
  expected: LinkValid,
  linked: LinkedSchema,
): void {
  const entries = linked.entries;

  if (expected.binds !== undefined) {
    // Names normalised on both sides: a materialised entry's trailing content hash is not
    // normative (§8.2, RUNNER.md rule 6), and a vector that stated one would be testing a hash
    // function.
    const bound = new Set([...entries.keys()].map((name) => normalizeSyntheticName(name)));
    for (const name of expected.binds) {
      if (!bound.has(normalizeSyntheticName(name))) {
        throw new Error(
          `${vector.name}: the linked namespace does not bind '${name}'; it binds ${[...bound].join(', ')}`,
        );
      }
    }
  }

  if (expected.disjoint !== undefined) {
    for (const claim of expected.disjoint) {
      const definition = definitionOf(vector, entries, claim.name);
      if (definition.disjoint === undefined) {
        throw new Error(
          `${vector.name}: '${claim.name}' has no derived disjointness at all (§5.4)`,
        );
      }
      expect(definition.disjoint).toBe(claim.value);
    }
  }

  if (expected.subtypes !== undefined) {
    for (const claim of expected.subtypes) {
      const definition = definitionOf(vector, entries, claim.name);
      const actual = new Set(definition.subtypes.map((name) => normalizeSyntheticName(name)));
      const wanted = new Set(claim.subtypes.map((name) => normalizeSyntheticName(name)));
      expect(actual).toEqual(wanted);
    }
  }
}

export function checkLinkVector(
  vector: Vector<Class2Layer>,
  subject: Uint8Array,
  sidecar: LinkSidecar,
): void {
  const tson = newClass2Tson();
  switch (sidecar.outcome) {
    case 'valid': {
      const linked = tson.resolveSchema(subject);
      if (sidecar.valid === undefined) {
        throw new Error(
          `${vector.name}: a 'valid' class2/link vector must state what it claims about the linked namespace`,
        );
      }
      assertLinkedNamespaceMatches(vector, sidecar.valid, linked);
      return;
    }
    case 'error': {
      let thrown: unknown;
      try {
        tson.resolveSchema(subject);
      } catch (error) {
        thrown = error;
      }
      if (thrown === undefined) {
        throw new Error(
          `${vector.name}: expected the schema to fail to load, but it resolved cleanly`,
        );
      }
      assertSchemaOrLinkLoadFailed(vector, sidecar.category, thrown);
      return;
    }
  }
}
