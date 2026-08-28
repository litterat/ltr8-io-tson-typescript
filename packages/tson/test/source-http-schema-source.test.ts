/**
 * `httpSchemaSource` -- deny-by-default allow-list, no redirects ever, a size cap enforced while
 * streaming, a timeout, and the `TsonSchemaFetchError` reason each refusal carries.
 *
 * The global `fetch` is replaced per test with a small mock that inspects the request and
 * returns a real `Response` (Node 24's own `Response`, streamed the same way a live one would
 * be) -- this suite is testing this module's own policy, not the network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { httpSchemaSource } from '../src/source/httpSchemaSource.js';
import { TsonSchemaFetchError } from '../src/core/errors.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): void {
  globalThis.fetch = vi.fn((input: string, init?: RequestInit) =>
    Promise.resolve(handler(input, init ?? {})),
  ) as unknown as typeof fetch;
}

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TsonSchemaFetchError) return error.reason;
    throw error;
  }
  throw new Error('expected a rejection');
}

describe('httpSchemaSource: deny by default', () => {
  it('refuses every reference when no host is allowed', async () => {
    const source = httpSchemaSource();
    expect(await reasonOf(source.fetch('https://example.com/a.tn'))).toBe('not-permitted');
  });

  it('refuses a host not on the allow-list, matching exactly (no subdomain/suffix match)', async () => {
    const source = httpSchemaSource({ allowHosts: ['schemas.example.com'] });
    expect(await reasonOf(source.fetch('https://evil-schemas.example.com/a.tn'))).toBe(
      'not-permitted',
    );
    expect(await reasonOf(source.fetch('https://sub.schemas.example.com/a.tn'))).toBe(
      'not-permitted',
    );
  });

  it('never opens a connection for a refused reference', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;
    const source = httpSchemaSource();
    await expect(source.fetch('https://example.com/a.tn')).rejects.toThrow(TsonSchemaFetchError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('httpSchemaSource: an allowed host', () => {
  it('fetches successfully, returning the exact bytes', async () => {
    mockFetch(() => new Response('!!id:"x"\n{}\n', { status: 200 }));
    const source = httpSchemaSource({ allowHosts: ['example.com'] });
    const bytes = await source.fetch('https://example.com/a.tn');
    expect(new TextDecoder().decode(bytes)).toBe('!!id:"x"\n{}\n');
  });

  it('sends the request with redirect: manual', async () => {
    let seenInit: RequestInit | undefined;
    mockFetch((_url, init) => {
      seenInit = init;
      return new Response('ok', { status: 200 });
    });
    const source = httpSchemaSource({ allowHosts: ['example.com'] });
    await source.fetch('https://example.com/a.tn');
    expect(seenInit?.redirect).toBe('manual');
  });

  it('refuses a 3xx redirect response as transport, never following it', async () => {
    mockFetch(
      () => new Response(null, { status: 302, headers: { Location: 'https://evil.com/x' } }),
    );
    const source = httpSchemaSource({ allowHosts: ['example.com'] });
    expect(await reasonOf(source.fetch('https://example.com/a.tn'))).toBe('transport');
  });

  it('maps a 404 to not-found', async () => {
    mockFetch(() => new Response('nope', { status: 404 }));
    const source = httpSchemaSource({ allowHosts: ['example.com'] });
    expect(await reasonOf(source.fetch('https://example.com/a.tn'))).toBe('not-found');
  });

  it('maps a 500 to transport', async () => {
    mockFetch(() => new Response('boom', { status: 500 }));
    const source = httpSchemaSource({ allowHosts: ['example.com'] });
    expect(await reasonOf(source.fetch('https://example.com/a.tn'))).toBe('transport');
  });

  it('maps a network failure to transport', async () => {
    mockFetch(() => {
      throw new TypeError('fetch failed');
    });
    const source = httpSchemaSource({ allowHosts: ['example.com'] });
    expect(await reasonOf(source.fetch('https://example.com/a.tn'))).toBe('transport');
  });
});

describe('httpSchemaSource: size cap enforced while streaming', () => {
  it('refuses a body larger than maxDocumentBytes as too-large, without buffering it all first', async () => {
    let delivered = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        delivered += 1;
        controller.enqueue(new Uint8Array(10)); // far larger, in total, than the cap below
        if (delivered > 1000) controller.close(); // safety net; the cap should stop this long before
      },
    });
    mockFetch(() => new Response(body, { status: 200 }));
    const source = httpSchemaSource({ allowHosts: ['example.com'], maxDocumentBytes: 25 });
    expect(await reasonOf(source.fetch('https://example.com/a.tn'))).toBe('too-large');
    // The stream was aborted well short of the safety net -- proof the cap was enforced while
    // streaming, not after buffering everything.
    expect(delivered).toBeLessThan(10);
  });

  it('accepts a body exactly at the cap', async () => {
    mockFetch(() => new Response('x'.repeat(10), { status: 200 }));
    const source = httpSchemaSource({ allowHosts: ['example.com'], maxDocumentBytes: 10 });
    const bytes = await source.fetch('https://example.com/a.tn');
    expect(bytes.length).toBe(10);
  });
});

describe('httpSchemaSource: timeout', () => {
  it('reports a request that never answers as timeout', async () => {
    mockFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted', 'TimeoutError'));
          });
        }),
    );
    const source = httpSchemaSource({ allowHosts: ['example.com'], timeoutMs: 5 });
    expect(await reasonOf(source.fetch('https://example.com/a.tn'))).toBe('timeout');
  });
});

describe('httpSchemaSource: caching', () => {
  it('a cache hit skips the network but not the allow-list', async () => {
    const fetchSpy = vi.fn(() => Promise.resolve(new Response('!!id:"x"\n{}\n', { status: 200 })));
    globalThis.fetch = fetchSpy;
    const source = httpSchemaSource({ allowHosts: ['example.com'] });
    await source.fetch('https://example.com/a.tn');
    await source.fetch('https://example.com/a.tn');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(source.isCached('https://example.com/a.tn')).toBe(true);
    expect(source.isCached('https://example.com/b.tn')).toBe(false);
    // isCached never touches the network even for a reference this source would refuse.
    expect(source.isCached('https://not-allowed.com/a.tn')).toBe(false);
  });

  it('preload fetches every reference so a later fetch finds it cached', async () => {
    const fetchSpy = vi.fn(() => Promise.resolve(new Response('!!id:"x"\n{}\n', { status: 200 })));
    globalThis.fetch = fetchSpy;
    const source = httpSchemaSource({ allowHosts: ['example.com'] });
    await source.preload(['https://example.com/a.tn', 'https://example.com/b.tn']);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(source.isCached('https://example.com/a.tn')).toBe(true);
    expect(source.isCached('https://example.com/b.tn')).toBe(true);
  });
});

describe('httpSchemaSource: requireContentHashPin', () => {
  it('refuses a reference with no ?sha256= pin when required', async () => {
    const source = httpSchemaSource({ allowHosts: ['example.com'], requireContentHashPin: true });
    expect(await reasonOf(source.fetch('https://example.com/a.tn'))).toBe('not-permitted');
  });
});

describe('httpSchemaSource: mapHost', () => {
  it('fetches from the mapped base rather than the identity host, without renaming the identity', async () => {
    let seenUrl: string | undefined;
    mockFetch((url) => {
      seenUrl = url;
      return new Response('!!id:"x"\n{}\n', { status: 200 });
    });
    const source = httpSchemaSource({
      mapHosts: { 'schemas.example.com': 'https://internal.local:9443/mirror' },
    });
    await source.fetch('https://schemas.example.com/a.tn');
    expect(seenUrl).toBe('https://internal.local:9443/mirror/a.tn');
  });
});
