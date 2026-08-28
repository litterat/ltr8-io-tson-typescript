import { describe, expect, it } from 'vitest';
import { runSync } from '../src/io/bytes.js';
import { schemalessTreeReader } from '../src/reader/schemaless/tree.js';
import { collectingContextOver } from './reader-tree-helpers.js';

/**
 * Properties the unit suites did not cover, both surfaced by the Wave 4 verify stage.
 */
describe('schemaless map duplicate-key detection scales (§2.6)', () => {
  // A flat list with a deep comparison per candidate is quadratic in the entry count, and a map's
  // size is chosen by whoever wrote the document — measured at n=16000 it cost 5.1 s against the
  // record path's 0.45 s, tripling per doubling where the record path doubled. The check is now
  // bucketed by a structural digest; this pins that the cost stays close to linear.
  function read(text: string): number {
    const { ctx } = collectingContextOver(text);
    const started = Date.now();
    runSync(schemalessTreeReader().read(ctx));
    return Date.now() - started;
  }

  function mapSource(n: number): string {
    const entries: string[] = [];
    for (let i = 0; i < n; i++) entries.push(`"k${String(i)}" => ${String(i)}`);
    return `{ ${entries.join('  ')} }`;
  }

  it('reads a large distinct-key map without quadratic blowup', () => {
    read(mapSource(500)); // warm
    const small = Math.max(read(mapSource(2000)), 1);
    const large = Math.max(read(mapSource(8000)), 1);
    // Four times the entries. Quadratic would be roughly 16x.
    expect(large / small).toBeLessThan(8);
  });

  it('still reports a genuine duplicate key', () => {
    const { ctx, diagnostics } = collectingContextOver('{ "a" => 1  "a" => 2 }');
    runSync(schemalessTreeReader().read(ctx));
    expect(diagnostics.diagnostics.map((d) => d.code)).toContain('DUPLICATE_MAP_KEY');
  });

  it('still reports a duplicate compound key, where the digest must agree', () => {
    const { ctx, diagnostics } = collectingContextOver('{ [1 2] => "x"  [1 2] => "y" }');
    runSync(schemalessTreeReader().read(ctx));
    expect(diagnostics.diagnostics.map((d) => d.code)).toContain('DUPLICATE_MAP_KEY');
  });

  it('does not confuse a string key with a numeric one of the same spelling', () => {
    const { ctx, diagnostics } = collectingContextOver('{ "1" => "a"  1 => "b" }');
    runSync(schemalessTreeReader().read(ctx));
    expect(diagnostics.diagnostics.map((d) => d.code)).not.toContain('DUPLICATE_MAP_KEY');
  });
});
