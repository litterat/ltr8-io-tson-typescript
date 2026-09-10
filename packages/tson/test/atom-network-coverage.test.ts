import { describe, expect, it } from 'vitest';
import { admitsSomeValue, parseNetworkBlock } from '../src/atom/network/cidrParsing.js';
import { parseIpv4Octets } from '../src/atom/network/ipv4.js';

function b(text: string) {
  const block = parseNetworkBlock(text, parseIpv4Octets);
  if (block === undefined) throw new Error(`not a block: ${text}`);
  return block;
}

describe('§5.5 within/excluding admits a value', () => {
  it('a disjoint exclusion does not empty a single-address within', () => {
    expect(admitsSomeValue([b('203.0.113.5/32')], [b('203.0.113.6/32')], 32, 32, 32)).toBe(true);
  });
  it('an exclusion equal to the only within block empties it', () => {
    expect(admitsSomeValue([b('10.0.0.0/8')], [b('10.0.0.0/8')], 0, 32, 32)).toBe(false);
  });
  it('a tiling pair of exclusions covers the within block -- the case a pairwise check misses', () => {
    expect(
      admitsSomeValue([b('10.0.0.0/8')], [b('10.0.0.0/9'), b('10.128.0.0/9')], 0, 32, 32),
    ).toBe(false);
  });
  it('a hole inside a within block still leaves the other half', () => {
    expect(admitsSomeValue([b('10.0.0.0/8')], [b('10.0.0.0/9')], 0, 32, 32)).toBe(true);
  });
  it('max_prefix caps a block whose only uncovered part is narrower', () => {
    expect(admitsSomeValue([b('10.0.0.0/24')], [b('10.0.0.5/32')], 0, 24, 32)).toBe(false);
  });
});
