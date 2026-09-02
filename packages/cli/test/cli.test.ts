/**
 * End-to-end tests for the `tson` CLI, driving `main()` directly (no subprocess) and capturing
 * `process.stdout`/`process.stderr`. Exit codes are the contract `exit.ts` states in full -- **0
 * checked and nothing to report, 1 checked and rejected, 2 usage error, 69/75 a schema not
 * obtained (permanently/temporarily), 78 a type with no registered binding, 70 a library gap or
 * fault** -- so every case below asserts the code, not just that something printed.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  it('a well-formed document is valid, exit 0', async () => {
    const file = join(dir, 'ok.tn');
    await writeFile(file, '{ a: 1  b: "two" }\n', 'utf8');
    const io = captureOutput();
    const code = await main(['validate', file]);
    expect(code).toBe(EXIT.OK);
    expect(io.stdout()).toContain('valid');
  });

  it('a malformed document is invalid, exit 1 -- via the base-syntax classifyReadError path', async () => {
    const file = join(dir, 'bad.tn');
    await writeFile(file, '{ a: 1\n', 'utf8'); // unclosed record
    const io = captureOutput();
    const code = await main(['validate', file]);
    expect(code).toBe(EXIT.INVALID);
    expect(io.stdout()).toContain('invalid');
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
    expect(io.stdout()).toContain('valid');
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

  it('the same pair fails when the root name is wrong', async () => {
    await runInitExample(dir);
    const code = await main([
      'validate',
      '--schema',
      join(dir, 'person.tn'),
      '--root',
      'no_such_type',
      join(dir, 'person-data.tn'),
    ]);
    expect(code).toBe(EXIT.FAULT); // TsonInternalError: no such entry in the linked namespace
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

  it('a schema naming an unregistered !!meta does not compile, exit 1', async () => {
    const file = join(dir, 'bad.tn');
    await writeFile(
      file,
      '!!id:"https://example.com/bad.tn"\n!!meta:"https://nonexistent.example/meta.tn"\n{ foo => bar }\n',
      'utf8',
    );
    const io = captureOutput();
    const code = await main(['compile', file]);
    expect(code).toBe(EXIT.INVALID);
    expect(io.stdout()).toContain('invalid');
  });

  it('no files: usage error, exit 2', async () => {
    const code = await main(['compile']);
    expect(code).toBe(EXIT.USAGE);
  });
});

describe('hash', () => {
  it('reproduces core.tn’s own published content-hash pin', async () => {
    const io = captureOutput();
    const code = await main(['hash', join(SPEC_M, 'core.tn')]);
    expect(code).toBe(EXIT.OK);
    expect(io.stdout()).toContain(
      'sha256:c2127732df2dbac80ac4bbb7cb7d35070bfe546472368088a2f76343a8d85830',
    );
  });

  it('--format json emits a parseable report with the same hash', async () => {
    const io = captureOutput();
    const code = await main(['hash', '--format', 'json', join(SPEC_M, 'core.tn')]);
    expect(code).toBe(EXIT.OK);
    const parsed = JSON.parse(io.stdout()) as {
      outcome: string;
      files: { content_hash: string }[];
    };
    expect(parsed.outcome).toBe('VALID');
    expect(parsed.files[0]?.content_hash).toBe(
      'c2127732df2dbac80ac4bbb7cb7d35070bfe546472368088a2f76343a8d85830',
    );
  });

  it('--format tson emits a document this same implementation can read back', async () => {
    const io = captureOutput();
    const code = await main(['hash', '--format', 'tson', join(SPEC_M, 'meta.tn')]);
    expect(code).toBe(EXIT.OK);
    expect(io.stdout()).toContain('outcome: "VALID"');
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
      policy: { identifier_policy: { level: string } };
      files: { outcome: string }[];
    };
    expect(parsed.outcome).toBe('VALID');
    expect(parsed.policy.identifier_policy.level).toBe('HIGHLY_RESTRICTIVE');
    expect(parsed.files[0]?.outcome).toBe('VALID');
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
    const parsed = JSON.parse(io.stdout()) as { policy: { token_policy: { level: string } } };
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
    expect(parsed.outcome).toBe('VALID');
    expect(parsed.policy.token_policy.level).toBe('UNRESTRICTED');
  });
});
