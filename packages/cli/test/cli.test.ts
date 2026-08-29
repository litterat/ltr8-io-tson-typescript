/**
 * End-to-end tests for the `tson` CLI, driving `main()` directly (no subprocess) and capturing
 * `process.stdout`/`process.stderr`. Exit codes are the contract this work package's own brief
 * states in full -- **0 valid, 1 invalid, 2 usage, 70 fault** -- so every case below asserts the
 * code, not just that something printed.
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
      valid: boolean;
      files: { content_hash: string }[];
    };
    expect(parsed.valid).toBe(true);
    expect(parsed.files[0]?.content_hash).toBe(
      'c2127732df2dbac80ac4bbb7cb7d35070bfe546472368088a2f76343a8d85830',
    );
  });

  it('--format tson emits a document this same implementation can read back', async () => {
    const io = captureOutput();
    const code = await main(['hash', '--format', 'tson', join(SPEC_M, 'meta.tn')]);
    expect(code).toBe(EXIT.OK);
    expect(io.stdout()).toContain('valid');
    expect(io.stdout()).toContain('content_hash');
  });
});
