/**
 * `policyNode.ts` -- rendering a {@link ProcessorPolicy} for `tson policy`'s three formats, with
 * particular attention to the `permitting` field: empty at the §8.2 defaults, and carrying every
 * admitted script combination back as names once `--identifier-scripts`/`--token-scripts` name
 * one (`policyOptions.test.ts` covers the flag parsing that produces the `ScriptId`s this module
 * renders back).
 */
import { describe, expect, it } from 'vitest';
import { consumePolicyOptions, processorPolicyOf } from '../src/policyOptions.js';
import {
  isDefaultPolicy,
  policyJson,
  policyNode,
  policySummary,
  policyText,
} from '../src/policyNode.js';

function policyFor(args: readonly string[]) {
  return processorPolicyOf(consumePolicyOptions(args).policy);
}

describe('policyJson: permitting', () => {
  it('is empty at the §8.2 defaults', () => {
    const json = policyJson(policyFor([]));
    expect(json.identifier_policy.permitting).toEqual([]);
    expect(json.token_policy.permitting).toEqual([]);
  });

  it('carries an admitted combination back as script names, snake_case field names throughout', () => {
    const json = policyJson(policyFor(['--identifier-scripts', 'Latin+Cyrillic']));
    expect(json.identifier_policy.permitting).toEqual([['Latin', 'Cyrillic']]);
    expect(json.identifier_policy.level).toBe('HIGHLY_RESTRICTIVE');
  });

  it('accumulates repeated --identifier-scripts occurrences in order', () => {
    const json = policyJson(
      policyFor(['--identifier-scripts', 'Latin+Cyrillic', '--identifier-scripts', 'Latin+Greek']),
    );
    expect(json.identifier_policy.permitting).toEqual([
      ['Latin', 'Cyrillic'],
      ['Latin', 'Greek'],
    ]);
  });

  it('renders the token surface independently of the identifier surface', () => {
    const json = policyJson(policyFor(['--token-scripts', 'Latin+Cyrillic']));
    expect(json.token_policy.permitting).toEqual([['Latin', 'Cyrillic']]);
    expect(json.token_policy.level).toBe('SINGLE_SCRIPT'); // --token-scripts alone implies this
    expect(json.identifier_policy.permitting).toEqual([]);
  });
});

describe('policyNode: permitting', () => {
  it('renders as a nested array-of-arrays TSON value', () => {
    const node = policyNode(policyFor(['--identifier-scripts', 'Latin+Cyrillic']));
    expect(node.kind).toBe('record');
    if (node.kind !== 'record') throw new Error('unreachable');
    const identifierPolicy = node.fields.get('identifier_policy');
    expect(identifierPolicy?.kind).toBe('record');
    if (identifierPolicy?.kind !== 'record') throw new Error('unreachable');
    const permitting = identifierPolicy.fields.get('permitting');
    expect(permitting?.kind).toBe('array');
    if (permitting?.kind !== 'array') throw new Error('unreachable');
    expect(permitting.elements).toHaveLength(1);
    const combination = permitting.elements[0];
    expect(combination?.kind).toBe('array');
    if (combination?.kind !== 'array') throw new Error('unreachable');
    expect(combination.elements.map((e) => (e.kind === 'atom' ? e.value : undefined))).toEqual([
      'Latin',
      'Cyrillic',
    ]);
  });

  it('is an empty array at the defaults', () => {
    const node = policyNode(policyFor([]));
    if (node.kind !== 'record') throw new Error('unreachable');
    const identifierPolicy = node.fields.get('identifier_policy');
    if (identifierPolicy?.kind !== 'record') throw new Error('unreachable');
    const permitting = identifierPolicy.fields.get('permitting');
    if (permitting?.kind !== 'array') throw new Error('unreachable');
    expect(permitting.elements).toEqual([]);
  });
});

describe('policyText / policySummary: permitting', () => {
  it('says nothing about permitting at the defaults', () => {
    expect(policyText(policyFor([]))).not.toContain('permitting');
    expect(policySummary(policyFor([]))).not.toContain('permitting');
  });

  it('states the combination as it would be typed back on the command line', () => {
    const text = policyText(policyFor(['--identifier-scripts', 'Latin+Cyrillic']));
    expect(text).toContain('permitting Latin+Cyrillic');
  });

  it('joins several combinations with a comma', () => {
    const text = policyText(
      policyFor(['--identifier-scripts', 'Latin+Cyrillic', '--identifier-scripts', 'Latin+Greek']),
    );
    expect(text).toContain('permitting Latin+Cyrillic, Latin+Greek');
  });
});

describe('isDefaultPolicy: permittedScripts', () => {
  it('is no longer the default once a combination is admitted, even at the default level', () => {
    expect(isDefaultPolicy(policyFor([]))).toBe(true);
    expect(isDefaultPolicy(policyFor(['--identifier-scripts', 'Latin+Cyrillic']))).toBe(false);
  });
});
