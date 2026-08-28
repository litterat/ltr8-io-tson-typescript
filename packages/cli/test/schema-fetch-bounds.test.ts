import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { main } from '../src/cli.js';
import { vi } from 'vitest';

/**
 * The CLI fetches a `--schema` URL itself rather than through the library's hardened source, so
 * the two protections that source carries had to be repeated here and were not: the body was
 * buffered with `arrayBuffer()` under no cap at all, and the 30 s signal stopped bounding anything
 * once the response headers arrived. A server that answered 200 and then wrote forever grew the
 * process to ~13 GB and never let it exit.
 */
describe('a fetched schema is bounded in size and in time', () => {
  beforeEach(() => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function serving(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{
    url: string;
    close: () => Promise<void>;
  }> {
    const server: Server = createServer(handler);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${String(port)}/schema.tn`,
      close: async () => {
        server.closeAllConnections();
        server.close();
        await once(server, 'close');
      },
    };
  }

  it('stops an endless response instead of buffering it', async () => {
    let written = 0;
    const { url, close } = await serving((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      const pump = (): void => {
        if (res.writableEnded) return;
        written += 1;
        // 1 MiB per chunk: the cap is 8 MiB, so this must stop in single digits.
        if (res.write('x'.repeat(1024 * 1024))) setImmediate(pump);
        else res.once('drain', pump);
      };
      pump();
    });
    try {
      const code = await main(['validate', '--schema', url, '--root', 'x', 'nonexistent.tn']);
      // A usage-shaped failure, not a hang and not a crash.
      expect(code).toBe(2);
      // The cap tripped early rather than after the server ran out of patience.
      expect(written).toBeLessThan(64);
    } finally {
      await close();
    }
  }, 30_000);
});

describe('the --schema/--root guard is both ways', () => {
  // `--root` alone used to be accepted and then discarded, so a run whose `--schema` was dropped
  // or mistyped silently fell back to schemaless Class-1 checking and reported "valid" for data
  // no one had checked against a schema.
  it('rejects --root without --schema as a usage error', async () => {
    const code = await main(['validate', '--root', 'person', 'nonexistent.tn']);
    expect(code).toBe(2);
  });

  it('still rejects --schema without --root', async () => {
    const code = await main(['validate', '--schema', 'nonexistent-schema.tn', 'nonexistent.tn']);
    expect(code).toBe(2);
  });
});
