/**
 * End-to-end tests for the `tson` CLI, driving `main()` directly (no subprocess) and capturing
 * `process.stdout`/`process.stderr`. Exit codes are the contract `exit.ts` states in full -- **0
 * checked and nothing to report, 1 checked and rejected, 2 usage error, 69/75 a schema not
 * obtained (permanently/temporarily), 78 a type with no registered binding, 70 a library gap or
 * fault** -- so every case below asserts the code, not just that something printed.
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { EXIT } from '../src/exit.js';
import { runInitExample } from '../src/commands/initExample.js';

const SPEC_M = join(import.meta.dirname, '../../../spec/m');

function captureOutput(): { stdout: () => string; stderr: () => string } {
  let out = '';
  let err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
    out += chunk.toString();
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
    err += chunk.toString();
    return true;
  });
  return { stdout: () => out, stderr: () => err };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tson-cli-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('top-level dispatch', () => {
  it('no command: usage to stderr, exit 2', async () => {
    const io = captureOutput();
    const code = await main([]);
    expect(code).toBe(EXIT.USAGE);
    expect(io.stderr()).toContain('Usage:');
    expect(io.stdout()).toBe('');
  });

  it('--help: usage to stdout, exit 0', async () => {
    const io = captureOutput();
    const code = await main(['--help']);
    expect(code).toBe(EXIT.OK);
    expect(io.stdout()).toContain('Usage:');
  });

  it('unknown command: usage to stderr, exit 2', async () => {
    const io = captureOutput();
    const code = await main(['bogus']);
    expect(code).toBe(EXIT.USAGE);
    expect(io.stderr()).toContain("unknown command 'bogus'");
  });
});

describe('validate (schemaless)', () => {
  it('Part 1 §9.1, §8.1: a document past the nesting-depth limit is refused -- REJECTED, exit 1', async () => {
    const file = join(dir, 'deep.tn');
    await writeFile(file, '['.repeat(200) + ']'.repeat(200) + '\n', 'utf8');
    const text = captureOutput();
    const code = await main(['validate', file]);
    expect(code).toBe(EXIT.INVALID);
    expect(text.stdout()).toContain('LIMIT_REFUSED');
    expect(text.stdout().split('\n')).toContain('rejected');
    expect(text.stdout().split('\n')).not.toContain('undetermined');
    const json = captureOutput();
    await main(['validate', '--format', 'json', file]);
    expect((JSON.parse(json.stdout()) as { outcome: string }).outcome).toBe('REJECTED');
  });

  it('a well-formed document is valid, exit 0', async () => {
    const file = join(dir, 'ok.tn');
    await writeFile(file, '{ a: 1  b: "two" }\n', 'utf8');
    const io = captureOutput();
    const code = await main(['validate', file]);
    expect(code).toBe(EXIT.OK);
    expect(io.stdout()).toContain('accepted');
  });

  it('a malformed document is invalid, exit 1 -- via the base-syntax classifyReadError path', async () => {
    const file = join(dir, 'bad.tn');
    await writeFile(file, '{ a: 1\n', 'utf8'); // unclosed record
    const io = captureOutput();
    const code = await main(['validate', file]);
    expect(code).toBe(EXIT.INVALID);
    expect(io.stdout()).toContain('rejected');
  });

  it('an unreadable file is a fault, exit 70', async () => {
    const io = captureOutput();
    const code = await main(['validate', join(dir, 'does-not-exist.tn')]);
    expect(code).toBe(EXIT.FAULT);
    expect(io.stderr()).toContain('internal error');
  });

  it('no files: usage error, exit 2', async () => {
    const code = await main(['validate']);
    expect(code).toBe(EXIT.USAGE);
  });

  it('--schema without --root: usage error, exit 2', async () => {
    const file = join(dir, 'ok.tn');
    await writeFile(file, '{}\n', 'utf8');
    const code = await main(['validate', '--schema', file, file]);
    expect(code).toBe(EXIT.USAGE);
  });

  it("'-' given twice is a usage error before any file is opened", async () => {
    const code = await main(['validate', '-', '-']);
    expect(code).toBe(EXIT.USAGE);
  });
});

describe('an unrecognized option is a usage error, not a file name', () => {
  // A mistyped flag used to be pushed onto the file list, opened, and reported as ENOENT -- exit
  // 70, a library fault. That tells a CI pipeline the tool broke when in fact the invocation was
  // wrong, and it never says which word was the problem.

  it.each([
    ['validate', '--schemas'],
    ['validate', '-x'],
    ['compile', '--formt'],
    ['hash', '--pin'],
    ['init-example', '--force'],
  ])('%s %s: exit 2, naming the option', async (command, flag) => {
    const io = captureOutput();
    const code = await main([command, flag, join(dir, 'anything.tn')]);
    expect(code).toBe(EXIT.USAGE);
    expect(io.stderr()).toContain(`unrecognized option '${flag}'`);
  });

  it("does not mistake validate's own '-' stdin token for a flag", async () => {
    // The one argument that begins with '-' and is not an option. It reaches the file list, and
    // the failure below is stdin being empty, not the argument being rejected.
    const io = captureOutput();
    const code = await main(['validate', '-', '-']);
    expect(code).toBe(EXIT.USAGE);
    expect(io.stderr()).not.toContain('unrecognized option');
  });

  it("'--' ends option parsing, so a file named like a flag stays reachable", async () => {
    const file = join(dir, '--odd-name.tn');
    await writeFile(file, '{ a: 1 }\n', 'utf8');
    const io = captureOutput();
    const code = await main(['validate', '--', file]);
    expect(code).toBe(EXIT.OK);
    expect(io.stdout()).toContain('accepted');
  });
});

describe('init-example + schema-governed validate, end to end', () => {
  it('writes a schema and data file that then validate against the bundled standard library', async () => {
    const io = captureOutput();
    const initCode = await main(['init-example', dir]);
    expect(initCode).toBe(EXIT.OK);
    expect(io.stdout()).toContain('person.tn');

    const schemaFile = join(dir, 'person.tn');
    const dataFile = join(dir, 'person-data.tn');
    const validateCode = await main([
      'validate',
      '--schema',
      schemaFile,
      '--root',
      'person',
      dataFile,
    ]);
    expect(validateCode).toBe(EXIT.OK);
  });

  it('the same pair fails when the root name is wrong: usage error, exit 2, before any file opens', async () => {
    await runInitExample(dir);
    const io = captureOutput();
    const code = await main([
      'validate',
      '--schema',
      join(dir, 'person.tn'),
      '--root',
      'no_such_type',
      join(dir, 'person-data.tn'),
    ]);
    expect(code).toBe(EXIT.USAGE);
    expect(io.stderr()).toContain('no_such_type');
  });
});

describe('validate: a data document is read under its own !!import ([TSON-DATA] §2.2)', () => {
  const CORE = '!!import:"https://tson.io/2026/40/m/core.tn"';
  const ABSENT = '!!import:"https://example.test/not-provided.tn"\n!claim { id: 1 }\n';

  it('a header naming the bundled library validates, the root type taken from its root tag', async () => {
    const file = join(dir, 'age.tn');
    await writeFile(file, `${CORE}\n!uint8 42\n`, 'utf8');
    const io = captureOutput();
    expect(await main(['validate', file])).toBe(EXIT.OK);
    expect(io.stdout()).toContain('accepted');
  });

  it('a value the imported type refuses is rejected, exit 1', async () => {
    const file = join(dir, 'age.tn');
    await writeFile(file, `${CORE}\n!uint8 300\n`, 'utf8');
    const io = captureOutput();
    expect(await main(['validate', file])).toBe(EXIT.INVALID);
    expect(io.stdout()).toContain('rejected');
  });

  it('a schema the run was not given is unavailable rather than a verdict, exit 69, and never fetched', async () => {
    const file = join(dir, 'claim.tn');
    await writeFile(file, ABSENT, 'utf8');
    const io = captureOutput();
    expect(await main(['validate', file])).toBe(69);
    expect(io.stdout()).toContain('SCHEMA_NOT_PERMITTED');
    expect(io.stdout()).toContain('not-provided.tn');
    expect(io.stdout().split('\n')).not.toContain('accepted');
    expect(io.stderr()).toContain('could not be checked');
  });

  it('a non-verdict costs its own document a verdict and nothing else, in either order', async () => {
    const claim = join(dir, 'claim.tn');
    await writeFile(claim, ABSENT, 'utf8');
    const invalid = join(dir, 'age.tn');
    await writeFile(invalid, `${CORE}\n!uint8 300\n`, 'utf8');
    for (const files of [
      [claim, invalid],
      [invalid, claim],
    ]) {
      vi.restoreAllMocks();
      const io = captureOutput();
      expect(await main(['validate', '--format', 'json', ...files])).toBe(69);
      const report = JSON.parse(io.stdout()) as {
        files: { file: string; diagnostics: { code: string }[] }[];
      };
      // Each document keeps its own verdict: the refused schema is a refusal (§8.1), not an error
      // category, and the other document is still judged and found invalid.
      expect(
        Object.fromEntries(report.files.map((f) => [f.file, f.diagnostics.map((d) => d.code)])),
      ).toEqual({
        [claim]: ['SCHEMA_NOT_PERMITTED'],
        [invalid]: ['ATOM_CONSTRAINT_VIOLATION'],
      });
    }
  });
});

describe('--max-depth and --max-wait-depth', () => {
  it('Part 1 §9.1: a lowered --max-depth refuses a document the default admits, exit 1', async () => {
    const file = join(dir, 'nest.tn');
    await writeFile(file, '[[[[]]]]\n', 'utf8');
    const ok = captureOutput();
    expect(await main(['validate', file])).toBe(EXIT.OK);
    expect(ok.stdout()).toContain('accepted');
    vi.restoreAllMocks();
    const io = captureOutput();
    expect(await main(['validate', '--max-depth', '2', file])).toBe(EXIT.INVALID);
    expect(io.stdout()).toContain('LIMIT_REFUSED');
  });

  it('Part 2 §11.5: a chain of three waits compiles at the default and is refused under a limit of two', async () => {
    const schema = join(dir, 'chain.tn');
    await writeFile(
      schema,
      [
        '!!id:"https://example.test/chain.tn"',
        '!!import:"https://tson.io/2026/40/m/core.tn"',
        '!schema {',
        '  w0 => w1 & { a: text }',
        '  w1 => w2 & { b: text }',
        '  w2 => w3 & { c: text }',
        '  w3 => { d: text }',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    const ok = captureOutput();
    expect(await main(['compile', schema])).toBe(EXIT.OK);
    expect(ok.stdout()).toContain('compiles');
    vi.restoreAllMocks();

    const io = captureOutput();
    expect(await main(['compile', '--format', 'json', '--max-wait-depth', '2', schema])).toBe(
      EXIT.INVALID,
    );
    const report = JSON.parse(io.stdout()) as {
      outcome: string;
      policy: { limits: { max_wait_depth: number } };
    };
    expect(report.outcome).toBe('REJECTED');
    expect(report.policy.limits.max_wait_depth).toBe(2);
  });

  it('a limit below one is a usage error, exit 2', async () => {
    const io = captureOutput();
    expect(await main(['policy', '--max-wait-depth', '0'])).toBe(EXIT.USAGE);
    expect(io.stderr()).toContain('--max-wait-depth must be at least 1');
    vi.restoreAllMocks();
    const depth = captureOutput();
    expect(await main(['policy', '--max-depth', '0'])).toBe(EXIT.USAGE);
    expect(depth.stderr()).toContain('--max-depth must be at least 1');
  });

  it('every command that takes policy flags documents both', async () => {
    for (const command of ['validate', 'compile', 'policy']) {
      vi.restoreAllMocks();
      const io = captureOutput();
      await main([command, '--help']);
      expect(io.stdout()).toContain('--max-depth <n>');
      expect(io.stdout()).toContain('--max-wait-depth <n>');
    }
  });
});

describe('compile', () => {
  it('a schema that resolves and links against the bundled standard library compiles, exit 0', async () => {
    await runInitExample(dir);
    const io = captureOutput();
    const code = await main(['compile', join(dir, 'person.tn')]);
    expect(code).toBe(EXIT.OK);
    expect(io.stdout()).toContain('compiles');
  });

  it('a schema importing an unregistered schema does not compile, exit 1', async () => {
    const file = join(dir, 'bad.tn');
    await writeFile(
      file,
      '!!id:"https://example.com/bad.tn"\n!!import:"https://nonexistent.example/meta.tn"\n!schema { foo => bar }\n',
      'utf8',
    );
    const io = captureOutput();
    const code = await main(['compile', file]);
    expect(code).toBe(EXIT.INVALID);
    expect(io.stdout()).toContain('rejected');
  });

  describe('a schema whose externs name schemas the library does not bundle ([TSON-SCHEMA] §7.8)', () => {
    const CORE = '!!import:"https://tson.io/2026/40/m/core.tn"';
    async function externSchemas(): Promise<{ one: string; shipping: string }> {
      const one = join(dir, 'order-1.tn');
      const shipping = join(dir, 'shipping.tn');
      await writeFile(
        one,
        `!!id:"https://example.test/cli-order-1.tn"\n${CORE}\n!schema { order => { id: text  payment: card }  card => { number: text } }\n`,
        'utf8',
      );
      await writeFile(
        shipping,
        `!!id:"https://example.test/cli-shipping.tn"\n${CORE}\n!schema {\n  order_v1 => !meta.extern { schema: "https://example.test/cli-order-1.tn"  type: order }\n  envelope => { id: text  body: order_v1 }\n}\n`,
        'utf8',
      );
      return { one, shipping };
    }

    it('compile loads it when the file declaring the extern target is given too, exit 0', async () => {
      const { one, shipping } = await externSchemas();
      const io = captureOutput();
      expect(await main(['compile', shipping, one])).toBe(EXIT.OK);
      expect(io.stdout()).toContain('compiles');
    });

    it('compile rejects it when no file declares the extern target, exit 1, fetching nothing', async () => {
      const { shipping } = await externSchemas();
      const io = captureOutput();
      expect(await main(['compile', shipping])).toBe(EXIT.INVALID);
      expect(io.stdout()).toContain('rejected');
      expect(io.stdout()).toContain('cli-order-1.tn');
    });

    it('validate --schema serves each further --schema by its !!id, and reads a foreign value under its own schema', async () => {
      const { one, shipping } = await externSchemas();
      const good = join(dir, 'good.tn');
      const bad = join(dir, 'bad.tn');
      await writeFile(
        good,
        '{ id: e  body: !order_v1 { id: A  payment: !card { number: "1" } } }',
        'utf8',
      );
      await writeFile(bad, '{ id: e  body: !order_v1 { id: A  payment: { count: "1" } } }', 'utf8');
      const binding = ['validate', '--schema', shipping, '--schema', one, '--root', 'envelope'];
      const ok = captureOutput();
      expect(await main([...binding, good])).toBe(EXIT.OK);
      expect(ok.stdout()).toContain('valid');
      vi.restoreAllMocks();
      const rejected = captureOutput();
      expect(await main([...binding, bad])).toBe(EXIT.INVALID);
      expect(rejected.stdout()).toContain('/body/payment');
    });

    it('validate --schema without the further --schema is an unobtainable schema, exit 69', async () => {
      const { shipping } = await externSchemas();
      const good = join(dir, 'good.tn');
      await writeFile(good, '{ id: e  body: !order_v1 { id: A } }', 'utf8');
      captureOutput();
      expect(await main(['validate', '--schema', shipping, '--root', 'envelope', good])).toBe(
        EXIT.SCHEMA_UNAVAILABLE,
      );
    });
  });

  it('no files: usage error, exit 2', async () => {
    const code = await main(['compile']);
    expect(code).toBe(EXIT.USAGE);
  });
});

describe('hash', () => {
  /**
   * `core.tn`'s own published pin, read out of the file rather than copied into this test. That is
   * the whole claim being made -- `hash` reproduces the digest the document states about itself
   * ([TSON-DATA] §2.2.1) -- and a copy here would instead pin whichever revision of `spec/m/` was
   * vendored when the test was written, failing on every re-vendoring for a reason that has
   * nothing to do with the hasher.
   */
  function publishedPin(file: string): string {
    const id = readFileSync(join(SPEC_M, file), 'utf8').split('\n', 1)[0] ?? '';
    const pin = /sha256=([0-9a-f]{64})/u.exec(id)?.[1];
    if (pin === undefined) throw new Error(`no sha256 pin in ${file}'s own !!id`);
    return pin;
  }

  it('reproduces core.tn’s own published content-hash pin', async () => {
    const io = captureOutput();
    const code = await main(['hash', join(SPEC_M, 'core.tn')]);
    expect(code).toBe(EXIT.OK);
    expect(io.stdout()).toContain(`sha256:${publishedPin('core.tn')}`);
  });

  it('--format json emits a parseable report with the same hash', async () => {
    const io = captureOutput();
    const code = await main(['hash', '--format', 'json', join(SPEC_M, 'core.tn')]);
    expect(code).toBe(EXIT.OK);
    const parsed = JSON.parse(io.stdout()) as {
      outcome: string;
      files: { content_hash: string }[];
    };
    expect(parsed.outcome).toBe('ACCEPTED');
    expect(parsed.files[0]?.content_hash).toBe(publishedPin('core.tn'));
  });

  it('--format tson emits a document this same implementation can read back', async () => {
    const io = captureOutput();
    const code = await main(['hash', '--format', 'tson', join(SPEC_M, 'meta.tn')]);
    expect(code).toBe(EXIT.OK);
    expect(io.stdout()).toContain('outcome: "ACCEPTED"');
    expect(io.stdout()).toContain('content_hash');
  });
});

describe('two-level help', () => {
  it('tson --help lists the commands and nothing more', async () => {
    const io = captureOutput();
    const code = await main(['--help']);
    expect(code).toBe(EXIT.OK);
    expect(io.stdout()).toContain('validate');
    expect(io.stdout()).toContain('compile');
    expect(io.stdout()).toContain('policy');
    expect(io.stdout()).toContain('hash');
    expect(io.stdout()).toContain('init-example');
    // The command list, not each command's own flags -- that lives behind `tson <command> --help`.
    expect(io.stdout()).not.toContain('--identifier-policy');
  });

  it.each([
    ['validate', /--schema/],
    ['compile', /resolves and links/i],
    ['policy', /--identifier-policy/],
    ['hash', /content hash/i],
    ['init-example', /person\.tn/],
  ])("tson %s --help prints that command's own detailed help, exit 0", async (command, detail) => {
    const io = captureOutput();
    const code = await main([command, '--help']);
    expect(code).toBe(EXIT.OK);
    expect(io.stdout()).toMatch(detail);
    expect(io.stderr()).toBe('');
  });

  it('validate --help documents --input', async () => {
    const io = captureOutput();
    await main(['validate', '--help']);
    expect(io.stdout()).toContain('--input tson|json');
  });

  it.each(['validate', 'compile', 'policy'])(
    '%s --help documents the shared policy-options block',
    async (command) => {
      const io = captureOutput();
      await main([command, '--help']);
      expect(io.stdout()).toContain('--identifier-policy');
      expect(io.stdout()).toContain('--identifier-per-segment');
      expect(io.stdout()).toContain('--token-policy');
    },
  );

  it.each([
    ['validate', /69|75|78/],
    ['compile', /69|75|78/],
  ])('%s --help states the 69/75/78 exit codes', async (command, expected) => {
    const io = captureOutput();
    await main([command, '--help']);
    expect(io.stdout()).toMatch(expected);
  });

  it('a usage error still prints the short one-liner plus the top-level command list, not the manual page', async () => {
    const io = captureOutput();
    const code = await main(['validate', '--bogus-flag']);
    expect(code).toBe(EXIT.USAGE);
    expect(io.stderr()).toContain('usage: tson validate');
    expect(io.stderr()).toContain('Usage:'); // the top-level command list
    // The detailed help's own policy-options walkthrough does not belong on an error path.
    expect(io.stderr()).not.toContain('--identifier-per-segment');
  });

  it('--help anywhere in the arguments wins over a bad policy value', async () => {
    const io = captureOutput();
    const code = await main(['validate', '--identifier-policy', 'bogus-level', '--help']);
    expect(code).toBe(EXIT.OK);
    expect(io.stdout()).toContain('usage: tson validate');
  });
});

describe('policy command', () => {
  it('always exits 0, even with no document to judge', async () => {
    const io = captureOutput();
    const code = await main(['policy']);
    expect(code).toBe(EXIT.OK);
    expect(io.stdout()).toContain('HIGHLY_RESTRICTIVE');
  });

  it('--format text prints identifier/token/unicode-data lines', async () => {
    const io = captureOutput();
    await main(['policy']);
    const out = io.stdout();
    expect(out).toContain('identifier policy:');
    expect(out).toContain('token policy:');
    expect(out).toContain('unicode data:');
    expect(out).toContain('UNRESTRICTED'); // the default token policy
  });

  it('--format json prints the full policy shape, snake_case, no document envelope', async () => {
    const io = captureOutput();
    const code = await main(['policy', '--format', 'json']);
    expect(code).toBe(EXIT.OK);
    const parsed = JSON.parse(io.stdout()) as {
      identifier_policy: { level: string; per_segment: boolean; permitting: string[][] };
      token_policy: { level: string; per_segment: boolean; permitting: string[][] };
      unicode_data_version: string;
    };
    expect(parsed.identifier_policy.level).toBe('HIGHLY_RESTRICTIVE');
    expect(parsed.identifier_policy.per_segment).toBe(false);
    expect(parsed.identifier_policy.permitting).toEqual([]);
    expect(parsed.token_policy.level).toBe('UNRESTRICTED');
    expect(typeof parsed.unicode_data_version).toBe('string');
    // No `outcome`/`files` -- this is a policy on its own, never a verdict on a document.
    expect(parsed).not.toHaveProperty('outcome');
    expect(parsed).not.toHaveProperty('files');
  });

  it('--format tson emits a document this same implementation can read back', async () => {
    const io = captureOutput();
    const code = await main(['policy', '--format', 'tson']);
    expect(code).toBe(EXIT.OK);
    expect(io.stdout()).toContain('identifier_policy');
    expect(io.stdout()).toContain('unicode_data_version');
  });

  it("--format json states policy.tn's `limits` (§9.1) and skeleton_distinctness, with no document in hand", async () => {
    const io = captureOutput();
    const code = await main(['policy', '--format', 'json']);
    expect(code).toBe(EXIT.OK);
    const parsed = JSON.parse(io.stdout()) as {
      identifier_policy: { skeleton_distinctness: boolean };
      limits: Record<string, number>;
    };
    // The whole of `policy.limits` (§9.1, [TSON-SCHEMA] §11.5), every member at its default.
    expect(Object.keys(parsed.limits)).toHaveLength(16);
    expect(parsed.limits.max_depth).toBe(64);
    expect(parsed.limits.max_wait_depth).toBe(64);
    expect(parsed.limits.max_alias_chain).toBe(64);
    expect(parsed.limits).not.toHaveProperty('max_reference_chain');
    expect(parsed.identifier_policy.skeleton_distinctness).toBe(true);
    expect(parsed).not.toHaveProperty('limits_policy');
  });

  it('--format tson and --format text both carry the depth limit too', async () => {
    const tson = captureOutput();
    await main(['policy', '--format', 'tson']);
    expect(tson.stdout()).toContain('limits');
    expect(tson.stdout()).toContain('max_depth');

    const text = captureOutput();
    await main(['policy']);
    expect(text.stdout()).toContain('max depth:                  64');
    expect(text.stdout()).toContain('max wait depth:             64');
  });

  it('policy prints the processor policy this build applies, aligned, and a stated bound', async () => {
    const io = captureOutput();
    expect(await main(['policy', '--max-depth', '8'])).toBe(EXIT.OK);
    expect(io.stdout()).toContain('identifier policy:          HIGHLY_RESTRICTIVE');
    expect(io.stdout()).toContain('token policy:               UNRESTRICTED');
    expect(io.stdout()).toContain('max depth:                  8');
  });

  it('--identifier-allow-look-alikes turns skeleton distinctness off, and the text says so', async () => {
    const json = captureOutput();
    await main(['policy', '--identifier-allow-look-alikes', '--format', 'json']);
    const parsed = JSON.parse(json.stdout()) as {
      identifier_policy: { skeleton_distinctness: boolean };
    };
    expect(parsed.identifier_policy.skeleton_distinctness).toBe(false);

    vi.restoreAllMocks();
    const text = captureOutput();
    await main(['policy', '--identifier-allow-look-alikes']);
    expect(text.stdout()).toContain('HIGHLY_RESTRICTIVE without skeleton distinctness');
  });

  it('reflects --identifier-policy/--identifier-per-segment/--token-policy in all three formats', async () => {
    const io = captureOutput();
    const code = await main([
      'policy',
      '--identifier-policy',
      'ascii-only',
      '--identifier-per-segment',
      '--token-policy',
      'single-script',
      '--format',
      'json',
    ]);
    expect(code).toBe(EXIT.OK);
    const parsed = JSON.parse(io.stdout()) as {
      identifier_policy: { level: string; per_segment: boolean };
      token_policy: { level: string };
    };
    expect(parsed.identifier_policy.level).toBe('ASCII_ONLY');
    expect(parsed.identifier_policy.per_segment).toBe(true);
    expect(parsed.token_policy.level).toBe('SINGLE_SCRIPT');
  });

  it('a positional argument is a usage error -- policy takes no document', async () => {
    const code = await main(['policy', 'somefile.tn']);
    expect(code).toBe(EXIT.USAGE);
  });

  it('an unrecognized flag is a usage error', async () => {
    const io = captureOutput();
    const code = await main(['policy', '--bogus']);
    expect(code).toBe(EXIT.USAGE);
    expect(io.stderr()).not.toBe('');
  });
});

describe('policy flags reach validate/compile', () => {
  it('validate: --identifier-per-segment paired with --identifier-policy unrestricted is a usage error', async () => {
    const file = join(dir, 'ok.tn');
    await writeFile(file, '{ a: 1 }\n', 'utf8');
    const io = captureOutput();
    const code = await main([
      'validate',
      '--identifier-policy',
      'unrestricted',
      '--identifier-per-segment',
      file,
    ]);
    expect(code).toBe(EXIT.USAGE);
    expect(io.stderr()).toMatch(/scans no scripts/);
  });

  it('validate: --identifier-scripts admits a named combination rather than being refused', async () => {
    const file = join(dir, 'ok.tn');
    await writeFile(file, '{ a: 1 }\n', 'utf8');
    const code = await main(['validate', '--identifier-scripts', 'Latin+Cyrillic', file]);
    expect(code).toBe(EXIT.OK);
  });

  it('validate: an unknown script name in --identifier-scripts is a usage error naming it', async () => {
    const file = join(dir, 'ok.tn');
    await writeFile(file, '{ a: 1 }\n', 'utf8');
    const io = captureOutput();
    const code = await main(['validate', '--identifier-scripts', 'Latin+Bogus', file]);
    expect(code).toBe(EXIT.USAGE);
    expect(io.stderr()).toContain("unknown script 'Bogus'");
  });

  it("validate carries the run's policy in its --format json report", async () => {
    const file = join(dir, 'ok.tn');
    await writeFile(file, '{ a: 1 }\n', 'utf8');
    const io = captureOutput();
    const code = await main(['validate', '--format', 'json', file]);
    expect(code).toBe(EXIT.OK);
    const parsed = JSON.parse(io.stdout()) as {
      outcome: string;
      policy: { identifier_policy: { level: string }; limits: { max_depth: number } };
      files: { outcome: string }[];
    };
    expect(parsed.outcome).toBe('ACCEPTED');
    expect(parsed.policy.identifier_policy.level).toBe('HIGHLY_RESTRICTIVE');
    // §9.1's depth limit rides inside the policy, as policy.tn's `limits`.
    expect(parsed.policy.limits.max_depth).toBe(64);
    expect(parsed.files[0]?.outcome).toBe('ACCEPTED');
  });

  it('compile: --token-scripts admits a named combination and raises the implied level to single-script', async () => {
    await runInitExample(dir);
    const io = captureOutput();
    const code = await main([
      'compile',
      '--format',
      'json',
      '--token-scripts',
      'Latin+Cyrillic',
      join(dir, 'person.tn'),
    ]);
    expect(code).toBe(EXIT.OK);
    const parsed = JSON.parse(io.stdout()) as {
      policy: { token_policy: { level: string } };
    };
    expect(parsed.policy.token_policy.level).toBe('SINGLE_SCRIPT');
  });

  it('compile: an unknown script name in --token-scripts is a usage error naming it', async () => {
    await runInitExample(dir);
    const code = await main(['compile', '--token-scripts', 'Bogus', join(dir, 'person.tn')]);
    expect(code).toBe(EXIT.USAGE);
  });

  it("compile carries the run's policy in its --format json report", async () => {
    await runInitExample(dir);
    const io = captureOutput();
    const code = await main(['compile', '--format', 'json', join(dir, 'person.tn')]);
    expect(code).toBe(EXIT.OK);
    const parsed = JSON.parse(io.stdout()) as {
      outcome: string;
      policy: { token_policy: { level: string } };
    };
    expect(parsed.outcome).toBe('ACCEPTED');
    expect(parsed.policy.token_policy.level).toBe('UNRESTRICTED');
  });
});

describe('validate: .json inputs ([TSON-JSON])', () => {
  async function withStdin<T>(text: string, run: () => Promise<T>): Promise<T> {
    const original = process.stdin;
    Object.defineProperty(process, 'stdin', {
      value: Readable.from([Buffer.from(text, 'utf8')]),
      configurable: true,
    });
    try {
      return await run();
    } finally {
      Object.defineProperty(process, 'stdin', { value: original, configurable: true });
    }
  }

  it('a conforming .json file validates against --schema/--root, exit 0', async () => {
    await runInitExample(dir);
    const jsonFile = join(dir, 'person-data.json');
    await writeFile(
      jsonFile,
      JSON.stringify({ name: 'Ada Lovelace', age: 36, active: true }),
      'utf8',
    );
    const io = captureOutput();
    const code = await main([
      'validate',
      '--schema',
      join(dir, 'person.tn'),
      '--root',
      'person',
      jsonFile,
    ]);
    expect(code).toBe(EXIT.OK);
    expect(io.stdout()).toContain('accepted');
  });

  it('.JSON (any case) is classified the same way', async () => {
    await runInitExample(dir);
    const jsonFile = join(dir, 'person-data.JSON');
    await writeFile(
      jsonFile,
      JSON.stringify({ name: 'Ada Lovelace', age: 36, active: true }),
      'utf8',
    );
    const code = await main([
      'validate',
      '--schema',
      join(dir, 'person.tn'),
      '--root',
      'person',
      jsonFile,
    ]);
    expect(code).toBe(EXIT.OK);
  });

  it('a non-conforming .json file is reported rejected, exit 1', async () => {
    await runInitExample(dir);
    const jsonFile = join(dir, 'person-data.json');
    await writeFile(jsonFile, JSON.stringify({ age: 36, active: true }), 'utf8');
    const io = captureOutput();
    const code = await main([
      'validate',
      '--schema',
      join(dir, 'person.tn'),
      '--root',
      'person',
      jsonFile,
    ]);
    expect(code).toBe(EXIT.INVALID);
    expect(io.stdout()).toContain('FIELD_REQUIRED');
  });

  it('a .json input with no binding is a usage error, exit 2, before any file opens', async () => {
    const jsonFile = join(dir, 'orphan.json');
    await writeFile(jsonFile, '{}', 'utf8');
    const io = captureOutput();
    const code = await main(['validate', jsonFile]);
    expect(code).toBe(EXIT.USAGE);
    expect(io.stderr()).toContain('.json');
  });

  it('a binding with only .tn inputs is unaffected -- --schema/--root already govern schema-checked .tn data', async () => {
    // init-example's own schema+data pair, no .json input in sight -- the same invocation the
    // 'init-example + schema-governed validate, end to end' describe block above already covers,
    // restated here as the guard for this module's own "not a usage error" note.
    await runInitExample(dir);
    const code = await main([
      'validate',
      '--schema',
      join(dir, 'person.tn'),
      '--root',
      'person',
      join(dir, 'person-data.tn'),
    ]);
    expect(code).toBe(EXIT.OK);
  });

  // WP4E: standard input is TSON text by default, whatever binding is given -- a deliberate
  // divergence from the reference CLI (`commands/validate.ts`'s own top note, `STATUS.md`). An
  // earlier revision of this CLI inferred JSON for stdin from a binding alone, which would
  // silently break `cat data.tn | tson validate --schema s.tn --root person -` for anyone
  // already running that invocation. `--input json` makes the JSON reading explicit instead.
  it('standard input is TSON text by default, even with a binding given', async () => {
    await runInitExample(dir);
    const io = captureOutput();
    const code = await withStdin('{ name: "Ada Lovelace"  age: 36  active: true }\n', () =>
      main(['validate', '--schema', join(dir, 'person.tn'), '--root', 'person', '-']),
    );
    expect(code).toBe(EXIT.OK);
    expect(io.stdout()).toContain('accepted');
  });

  it('standard input is TSON text with no binding either', async () => {
    const io = captureOutput();
    const code = await withStdin('{ a: 1 }\n', () => main(['validate', '-']));
    expect(code).toBe(EXIT.OK);
    expect(io.stdout()).toContain('accepted');
  });

  it('--input json forces standard input to be read as JSON', async () => {
    await runInitExample(dir);
    const io = captureOutput();
    const code = await withStdin(
      JSON.stringify({ name: 'Ada Lovelace', age: 36, active: true }),
      () =>
        main([
          'validate',
          '--schema',
          join(dir, 'person.tn'),
          '--root',
          'person',
          '--input',
          'json',
          '-',
        ]),
    );
    expect(code).toBe(EXIT.OK);
    expect(io.stdout()).toContain('accepted');
  });

  it('--input json on unbound standard input is a usage error, exit 2, before any file opens', async () => {
    const io = captureOutput();
    const code = await withStdin('{}', () => main(['validate', '--input', 'json', '-']));
    expect(code).toBe(EXIT.USAGE);
    expect(io.stderr()).toContain('JSON');
  });

  it('--input tson forces a .json-named file to be read as TSON text, ignoring its extension', async () => {
    const jsonNamedTson = join(dir, 'looks-like-json.json');
    await writeFile(jsonNamedTson, '{ a: 1 }\n', 'utf8');
    const io = captureOutput();
    const code = await main(['validate', '--input', 'tson', jsonNamedTson]);
    expect(code).toBe(EXIT.OK);
    expect(io.stdout()).toContain('accepted');
  });

  it('--input json forces a non-.json file to be read as JSON, ignoring its extension', async () => {
    await runInitExample(dir);
    const jsonInDisguise = join(dir, 'person-data.tn');
    await writeFile(
      jsonInDisguise,
      JSON.stringify({ name: 'Ada Lovelace', age: 36, active: true }),
      'utf8',
    );
    const code = await main([
      'validate',
      '--schema',
      join(dir, 'person.tn'),
      '--root',
      'person',
      '--input',
      'json',
      jsonInDisguise,
    ]);
    expect(code).toBe(EXIT.OK);
  });

  it('an unrecognized --input value is a usage error, exit 2', async () => {
    const io = captureOutput();
    const code = await main(['validate', '--input', 'yaml', join(dir, 'x.tn')]);
    expect(code).toBe(EXIT.USAGE);
    expect(io.stderr()).toContain('--input');
  });

  it('a schema and a mixed .tn/.json run share one compiled schema per encoding', async () => {
    await runInitExample(dir);
    const jsonFile = join(dir, 'person-data.json');
    await writeFile(
      jsonFile,
      JSON.stringify({ name: 'Ada Lovelace', age: 36, active: true }),
      'utf8',
    );
    const code = await main([
      'validate',
      '--schema',
      join(dir, 'person.tn'),
      '--root',
      'person',
      join(dir, 'person-data.tn'),
      jsonFile,
    ]);
    expect(code).toBe(EXIT.OK);
  });

  // [TSON-JSON] §9.4: the identifier policy reaches a JSON member name matching no declared field
  // -- unlike the text encoding's own schema-governed read, which consults no per-call policy at
  // all (this module's own top note).
  describe('--identifier-policy reaches a .json input too ([TSON-JSON] §9.4)', () => {
    // U+0430 CYRILLIC SMALL LETTER A in place of the ASCII 'a' in 'age' -- a look-alike for a
    // declared field of person.tn, matching none of its declared fields.
    async function lookAlikeJsonFile(): Promise<string> {
      await runInitExample(dir);
      const jsonFile = join(dir, 'person-data.json');
      await writeFile(
        jsonFile,
        JSON.stringify({ name: 'Ada Lovelace', аge: 36, active: true }),
        'utf8',
      );
      return jsonFile;
    }

    it('the default policy (Highly Restrictive) refuses the look-alike name, RESTRICTED_SCRIPT', async () => {
      const jsonFile = await lookAlikeJsonFile();
      const io = captureOutput();
      const code = await main([
        'validate',
        '--schema',
        join(dir, 'person.tn'),
        '--root',
        'person',
        jsonFile,
      ]);
      // §8.1's refused outcome: not a verdict, yet a rejection here -- REJECTED, exit 1.
      expect(code).toBe(EXIT.INVALID);
      expect(io.stdout()).toContain('RESTRICTED_SCRIPT');
      expect(io.stdout()).not.toContain('UNRECOGNIZED_FIELD');
      // The text report states the real outcome: a refusal rejects the document here.
      expect(io.stdout().split('\n')).toContain('rejected');
      expect(io.stdout().split('\n')).not.toContain('undetermined');
      const json = captureOutput();
      await main([
        'validate',
        '--format',
        'json',
        '--schema',
        join(dir, 'person.tn'),
        '--root',
        'person',
        jsonFile,
      ]);
      const report = JSON.parse(json.stdout()) as { outcome: string };
      expect(report.outcome).toBe('REJECTED');
    });

    it('--identifier-policy unrestricted admits the name, which then reports UNRECOGNIZED_FIELD instead', async () => {
      const jsonFile = await lookAlikeJsonFile();
      const io = captureOutput();
      const code = await main([
        'validate',
        '--schema',
        join(dir, 'person.tn'),
        '--root',
        'person',
        '--identifier-policy',
        'unrestricted',
        jsonFile,
      ]);
      expect(code).toBe(EXIT.INVALID);
      expect(io.stdout()).not.toContain('RESTRICTED_SCRIPT');
      expect(io.stdout()).toContain('UNRECOGNIZED_FIELD');
    });
  });
});

describe('strip', () => {
  const SCHEMA = [
    '!!id:"https://example.test/thing-1.tn"',
    '!!import:"https://tson.io/2026/40/m/core.tn"',
    '!schema {',
    '  @doc:"A thing."',
    '  thing => int32',
    '}',
    '',
  ].join('\n');

  it('prints the reading form and leaves the file alone, exit 0', async () => {
    const file = join(dir, 'thing.tn');
    await writeFile(file, SCHEMA, 'utf8');
    const io = captureOutput();
    const code = await main(['strip', file]);
    expect(code).toBe(EXIT.OK);
    expect(io.stdout()).toBe('!!import:"40/core"\n!schema {\nthing => int32\n}\n');
    expect(readFileSync(file, 'utf8')).toBe(SCHEMA);
  });

  it('--keep-docs keeps the documentation', async () => {
    const file = join(dir, 'thing.tn');
    await writeFile(file, SCHEMA, 'utf8');
    const io = captureOutput();
    const code = await main(['strip', '--keep-docs', file]);
    expect(code).toBe(EXIT.OK);
    expect(io.stdout()).toBe('!!import:"40/core"\n!schema {\n@doc:"A thing." thing => int32\n}\n');
  });

  it('an unknown option, a missing file argument and a second file are usage errors, exit 2', async () => {
    const file = join(dir, 'thing.tn');
    await writeFile(file, SCHEMA, 'utf8');
    for (const args of [['strip', '--keep-doc', file], ['strip'], ['strip', file, file]]) {
      vi.restoreAllMocks();
      const io = captureOutput();
      expect(await main(args)).toBe(EXIT.USAGE);
      expect(io.stderr()).toContain('usage: tson strip');
    }
  });

  it('a malformed schema is rejected where it breaks, as file:line:col: message, exit 1', async () => {
    const file = join(dir, 'broken.tn');
    await writeFile(
      file,
      '!!import:"https://tson.io/2026/40/m/core.tn"\n!schema { thing => }\n',
      'utf8',
    );
    const io = captureOutput();
    const code = await main(['strip', file]);
    expect(code).toBe(EXIT.INVALID);
    expect(io.stderr().startsWith(`${file}:2:`)).toBe(true);
    expect(io.stdout()).toBe('');
  });

  it('a data document is not a schema document, exit 1', async () => {
    const file = join(dir, 'data.tn');
    await writeFile(file, '{ a: 1 }\n', 'utf8');
    const io = captureOutput();
    expect(await main(['strip', file])).toBe(EXIT.INVALID);
    expect(io.stderr()).toContain(`${file}:`);
  });

  it('a file that cannot be read is exit 2, "cannot read"', async () => {
    const io = captureOutput();
    const code = await main(['strip', join(dir, 'missing.tn')]);
    expect(code).toBe(EXIT.USAGE);
    expect(io.stderr().startsWith('cannot read')).toBe(true);
  });

  it('--help describes the command, and the unknown-command message lists strip', async () => {
    const help = captureOutput();
    expect(await main(['strip', '--help'])).toBe(EXIT.OK);
    expect(help.stdout()).toContain('usage: tson strip');
    vi.restoreAllMocks();
    const unknown = captureOutput();
    expect(await main(['stripp'])).toBe(EXIT.USAGE);
    expect(unknown.stderr()).toContain('strip');
  });
});
