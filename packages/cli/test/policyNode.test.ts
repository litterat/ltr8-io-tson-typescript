/**
 * `policyNode.ts` -- rendering a {@link ProcessorPolicy} for `tson policy`'s three formats, with
 * particular attention to the `permitting` field: empty at the §8.2 defaults, and carrying every
 * admitted script combination back as names once `--identifier-scripts`/`--token-scripts` name
 * one (`policyOptions.test.ts` covers the flag parsing that produces the `ScriptId`s this module
 * renders back).
 */
import { describe, expect, it } from 'vitest';
import { renderPolicy } from '../src/render.js';
import { stdlibTson } from '../src/stdlib.js';
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

describe('policyText: the whole of policy.limits', () => {
  it('states every limit, in policy.limits order, its value aligned under the surfaces', () => {
    expect(policyText(policyFor([]))).toBe(
      [
        `identifier policy:          HIGHLY_RESTRICTIVE`,
        `token policy:               UNRESTRICTED`,
        `unicode data:               ${policyFor([]).unicodeDataVersion}`,
        'max depth:                  64',
        'max token length:           1048576',
        'max text length:            1048576',
        'max numeric literal length: 4096',
        'max binary size:            16777216',
        'max document size:          16777216',
        'max elements:               1048576',
        'max entries:                1048576',
        'max fields:                 65536',
        'max annotations:            64',
        'max values:                 16777216',
        'max import closure:         64',
        'max schema entries:         65536',
        'max alias chain:            64',
        'max supertype chain:        64',
        'max materialisation depth:  64',
        'max wait depth:             64',
      ].join('\n'),
    );
  });

  it('a stated depth is stated in the text, the summary and the machine form', () => {
    const policy = policyFor(['--max-depth', '8', '--max-wait-depth', '2']);
    expect(policyText(policy)).toContain('max depth:                  8');
    expect(policyText(policy)).toContain('max wait depth:             2');
    expect(policySummary(policy)).toContain('max depth 8');
    expect(policySummary(policy)).toContain('max wait depth 2');
    expect(policyJson(policy).limits.max_wait_depth).toBe(2);
    expect(isDefaultPolicy(policy)).toBe(false);
  });

  it('a report states a limit past int32, each a policy.limit int64, and it reads back as written', () => {
    const tson = stdlibTson();
    const linked = tson.schemas.get('tson.io/2026/39/m/policy.tn');
    if (linked === undefined) throw new Error('policy.tn is not registered');
    const rendered = renderPolicy(policyFor([]), 'tson')
      .replace(/max_depth: *64/u, 'max_depth: 3000000000')
      .replace(/max_wait_depth: *64/u, 'max_wait_depth: 9007199254740991');
    expect(rendered).toContain('3000000000');
    const result = tson.validate(new TextEncoder().encode(rendered), {
      schema: tson.compile(linked),
      root: 'policy.processor',
    });
    expect(result.diagnostics).toEqual([]);
  });
});

describe('isDefaultPolicy: permittedScripts', () => {
  it('is no longer the default once a combination is admitted, even at the default level', () => {
    expect(isDefaultPolicy(policyFor([]))).toBe(true);
    expect(isDefaultPolicy(policyFor(['--identifier-scripts', 'Latin+Cyrillic']))).toBe(false);
  });
});

// ── The report is `policy.tn`'s `policy.processor` type (spec/m/policy.tn) ─────────────────────────────────

describe('policy report shape', () => {
  it('json: identifier_policy has four members, token_policy two, and limits is the whole of policy.limits', () => {
    const json = policyJson(policyFor([]));
    expect(Object.keys(json.identifier_policy)).toEqual([
      'level',
      'per_segment',
      'skeleton_distinctness',
      'permitting',
    ]);
    expect(Object.keys(json.token_policy)).toEqual(['level', 'permitting']);
    expect(json.limits).toEqual({
      max_depth: 64,
      max_token_length: 1048576,
      max_text_length: 1048576,
      max_numeric_literal_length: 4096,
      max_binary_size: 16777216,
      max_document_size: 16777216,
      max_elements: 1048576,
      max_entries: 1048576,
      max_fields: 65536,
      max_annotations: 64,
      max_values: 16777216,
      max_import_closure: 64,
      max_schema_entries: 65536,
      max_alias_chain: 64,
      max_supertype_chain: 64,
      max_materialisation_depth: 64,
      max_wait_depth: 64,
    });
    expect(json).not.toHaveProperty('limits_policy');
  });

  it('names scripts by their UAX #24 property value alias', () => {
    const json = policyJson(
      policyFor(['--identifier-scripts', 'Latin+Old_Italic+SignWriting+Nko']),
    );
    expect(json.identifier_policy.permitting).toEqual([
      ['Latin', 'Old_Italic', 'SignWriting', 'Nko'],
    ]);
  });

  it('text: says without skeleton distinctness only when it is off', () => {
    expect(policyText(policyFor([]))).not.toContain('skeleton');
    expect(policySummary(policyFor(['--identifier-allow-look-alikes']))).toContain(
      'HIGHLY_RESTRICTIVE without skeleton distinctness',
    );
    expect(isDefaultPolicy(policyFor(['--identifier-allow-look-alikes']))).toBe(false);
  });

  it.each([
    ['the defaults', []],
    ['look-alikes allowed', ['--identifier-allow-look-alikes']],
    [
      'per segment, scripts and a token level',
      [
        '--identifier-policy',
        'moderately-restrictive',
        '--identifier-per-segment',
        '--identifier-scripts',
        'Latin+Cyrillic',
        '--identifier-scripts',
        'Latin+Greek',
        '--token-scripts',
        'Latin+Cyrillic',
      ],
    ],
  ])('a rendered report is a policy.processor under policy.tn: %s', (_name, flags) => {
    const tson = stdlibTson();
    const linked = tson.schemas.get('tson.io/2026/39/m/policy.tn');
    if (linked === undefined)
      throw new Error('policy.tn is not registered in the standard library');
    const compiled = tson.compile(linked);
    const policy = policyFor(flags);

    for (const format of ['tson', 'json'] as const) {
      const rendered = renderPolicy(policy, format);
      // JSON text is not TSON, but policy.tn's shape is what `tson` output states; the JSON form
      // is compared structurally against the same members below.
      if (format === 'json') {
        expect(Object.keys(JSON.parse(rendered) as object).sort()).toEqual([
          'identifier_policy',
          'limits',
          'token_policy',
          'unicode_data_version',
        ]);
        continue;
      }
      const result = tson.validate(new TextEncoder().encode(rendered), {
        schema: compiled,
        root: 'policy.processor',
      });
      expect(result.diagnostics).toEqual([]);
    }
  });

  it('policy.tn does reject a report missing `limits` (the check above is not vacuous)', () => {
    const tson = stdlibTson();
    const linked = tson.schemas.get('tson.io/2026/39/m/policy.tn');
    if (linked === undefined) throw new Error('policy.tn is not registered');
    const full = renderPolicy(policyFor([]), 'tson');
    // `limits` is the last member of the written record: cut it, close the record.
    const rendered = `${full.slice(0, full.indexOf('limits'))}}`;
    const result = tson.validate(new TextEncoder().encode(rendered), {
      schema: tson.compile(linked),
      root: 'policy.processor',
    });
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });
});
