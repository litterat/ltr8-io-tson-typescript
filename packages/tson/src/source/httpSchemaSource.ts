/**
 * A {@link SchemaSource} that fetches a schema document over HTTPS, under a host allow-list and
 * hard caps on size and time — the port of the reference implementation's
 * `TsonHttpSchemaSource` (`tson/src/main/java/io/ltr8/tson/TsonHttpSchemaSource.java`). See that
 * file's own module doc for the exhaustive rationale on why each control exists; this module
 * states only what differs in the port.
 *
 * **The reference is attacker-controlled.** A data document names its own schema
 * (`!!schema:"https://…"`), so in a server the string reaching {@link HttpSchemaSource.fetch}
 * came out of a request body. A source that fetches whatever it is handed is a server-side
 * request forgery primitive: it will read a cloud metadata endpoint, port-scan a private network,
 * or follow a redirect from a permitted host to one that isn't. Hence, every one of these is
 * enforced and **none is optional**:
 *
 * - **Deny by default.** {@link HttpSchemaSourceOptions.allowHosts}/{@link
 *   HttpSchemaSourceOptions.mapHosts} default to empty — nothing is fetched until a host is
 *   named. A host is matched exactly: no suffix or wildcard matching, because a `.example.com`
 *   suffix test also matches `evil-example.com`, which is how this control is usually defeated.
 * - **The reference must be a legal identity** (`reference.ts`'s own {@link permittedReference}),
 *   checked before any connection is opened.
 * - **Redirects are never followed.** `fetch` is called with `redirect: 'manual'`, so a 3xx
 *   response is surfaced as a response this module reads the status of, never followed — the
 *   allow-list check happened on the identity, and a redirect's target is a different URI. A 3xx
 *   is reported as a fetch failure, not silently chased.
 * - **Size is capped against bytes actually delivered.** The response body is read as a stream
 *   (`io/streams.ts`'s own `fromReadableStream`) and the running total is checked after every
 *   chunk, so a response that never ends is aborted the moment it exceeds the cap — never after
 *   buffering the whole thing, and never trusting a `Content-Length` header, which the origin
 *   also controls.
 * - **Time is capped end to end**, headers and body together, via `AbortSignal.timeout` — one
 *   signal covers both the connection and the whole streamed read.
 * - **Policy is checked on every reference, including a cached one.** A cache hit skips the
 *   network, never the allow-list.
 *
 * **Platform-specific by construction.** This module uses the global `fetch`/`URL`/
 * `AbortController` — real Web-platform APIs, not a Node-only surface — but this package's own
 * type configuration carries no `dom` lib (`CLAUDE.md`'s hard constraint), so those names only
 * typecheck under `src/source/tsconfig.json`'s own `types: ["node"]` (Node 24 ships them as
 * globals; `@types/node` is what types them here without pulling in the whole DOM). That is also
 * why this module is reached only through the `@ltr8/tson/source` subpath — never from the
 * package's default entry — so a browser bundle that never imports that subpath never carries an
 * SSRF-capable network client at all, "reachable" or not.
 *
 * **What this does not do**, matching the reference implementation's own scope: it does not
 * verify a fetched document's `?sha256=` pin, and does not cross-check its embedded `!!id` —
 * `reference.ts`'s own top note says why that stays the loader's job.
 */
import { fromReadableStream } from '../io/streams.js';
import { TsonSchemaFetchError } from '../core/errors.js';
import type { SchemaSource } from '../config.js';
import { notPermitted, permittedReference } from './reference.js';

export type { SchemaSource } from '../config.js';

/** A schema document larger than this is refused. Generous for a schema; small enough not to be a memory lever. */
export const DEFAULT_MAX_DOCUMENT_BYTES = 1 << 20;

/** How long one fetch may take, end to end (connection and body together). */
export const DEFAULT_TIMEOUT_MS = 5000;

/** How many schema documents may be held. */
export const DEFAULT_MAX_CACHED_SCHEMAS = 128;

/** [TSON-DATA] §7.1's media type, offered first and not insisted on — a plain file server has no idea of it. */
const ACCEPT = 'application/tson, */*;q=0.1';

export interface HttpSchemaSourceOptions {
  /**
   * Schemas identified by any of these hosts are fetched over `https` from that same host — the
   * short form. The host is matched exactly: allowing `schemas.example.com` permits nothing on a
   * subdomain and nothing on a host that merely ends the same way.
   */
  readonly allowHosts?: readonly string[];
  /**
   * Schemas identified by a key host are fetched from the mapped base instead — a mirror, an
   * internal endpoint, or a test server, and the only way to reach a non-default port, since an
   * identifying URI may not carry one (§2.2.1). A mapped host does not rename anything: the
   * identity stays the key host plus path, and the loader is expected to still cross-check the
   * fetched document's embedded `!!id` against it, so a mirror serving the wrong document fails
   * rather than substituting silently.
   */
  readonly mapHosts?: Readonly<Record<string, string>>;
  /** The largest schema document that will be read. Defaults to {@link DEFAULT_MAX_DOCUMENT_BYTES}. */
  readonly maxDocumentBytes?: number;
  /** How long one fetch may take. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** How many documents may be cached. Defaults to {@link DEFAULT_MAX_CACHED_SCHEMAS}. */
  readonly maxCachedSchemas?: number;
  /**
   * Refuses any reference carrying no `?sha256=` content-hash pin. Off by default, because a
   * self-describing document naming a plain URL is the ordinary case; on, it is the strongest
   * control available against a permitted host that is later compromised, since the loader then
   * verifies every fetched document against a hash the operator already published.
   */
  readonly requireContentHashPin?: boolean;
}

export interface HttpSchemaSource extends SchemaSource {
  /**
   * Fetches each reference now, so a later {@link fetch} finds it already cached. Call during
   * startup, on one thread's worth of sequencing (an `await`ed loop, not concurrent calls) — a
   * misconfigured deployment then fails at startup rather than on its first request.
   */
  preload(references: readonly string[]): Promise<void>;
  /**
   * Whether this identity's document is already held, so resolving it will not touch the
   * network. `false` for anything this source would refuse — a question about the cache is not a
   * request to fetch.
   */
  isCached(reference: string): boolean;
}

interface Target {
  readonly canonical: string;
  readonly location: string; // absolute URL to fetch
}

/** Builds an {@link HttpSchemaSource}. Every default is the safe one; nothing is fetched until a host is allowed. */
export function httpSchemaSource(options: HttpSchemaSourceOptions = {}): HttpSchemaSource {
  const hosts = new Map<string, string>();
  for (const host of options.allowHosts ?? []) {
    hosts.set(host.toLowerCase(), `https://${host.toLowerCase()}`);
  }
  for (const [host, base] of Object.entries(options.mapHosts ?? {})) {
    hosts.set(host.toLowerCase(), validateBase(base));
  }
  const maxDocumentBytes = options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxCachedSchemas = options.maxCachedSchemas ?? DEFAULT_MAX_CACHED_SCHEMAS;
  const requireContentHashPin = options.requireContentHashPin ?? false;

  const cache = new Map<string, Uint8Array>();
  const inFlight = new Map<string, Promise<Uint8Array>>();

  function permitted(reference: string): Target {
    const identity = permittedReference(reference, requireContentHashPin);
    const base = hosts.get(identity.host);
    if (base === undefined) {
      throw notPermitted(
        reference,
        hosts.size === 0
          ? 'no host is allowed by this source'
          : `host '${identity.host}' is not one of ${[...hosts.keys()].join(', ')}`,
      );
    }
    // Concatenate, then VERIFY against the parser that will actually be used. `fetch` re-parses
    // this string with the WHATWG parser, whose notion of a path separator is wider than RFC
    // 3986's — a backslash is one for a special scheme, and it resolves the dot-segments that
    // exposes. canonicalizeIdentity now rejects a raw backslash, so nothing known reaches here,
    // but a source that maps a host into a *sub-path* of an origin is exactly the place where a
    // future parser quirk becomes an SSRF. Checking the parsed result costs one parse per fetch
    // and makes the containment property independent of what the identity check happens to catch.
    const location = base + identity.path;
    const parsed = safeParse(location);
    if (parsed === undefined || !isWithin(parsed, base)) {
      throw notPermitted(
        reference,
        `resolves to '${parsed?.href ?? location}', which is outside the mapped base '${base}'`,
      );
    }
    return { canonical: identity.canonical, location: parsed.href };
  }

  function safeParse(candidate: string): URL | undefined {
    try {
      return new URL(candidate);
    } catch {
      return undefined;
    }
  }

  /**
   * Whether `parsed` still lies under `base` — same origin, and a path that is either `base`'s own
   * or one below it. Compared against `base` re-parsed, so both sides have been through the same
   * normalisation and a trailing-slash difference cannot decide it.
   */
  function isWithin(parsed: URL, base: string): boolean {
    const root = safeParse(base);
    if (root?.origin !== parsed.origin) {
      return false;
    }
    const rootPath = root.pathname.endsWith('/') ? root.pathname : `${root.pathname}/`;
    return parsed.pathname === root.pathname || parsed.pathname.startsWith(rootPath);
  }

  async function get(reference: string, location: string): Promise<Uint8Array> {
    let response: Response;
    try {
      response = await fetch(location, {
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: ACCEPT },
      });
    } catch (error) {
      throw fetchFailed(reference, error, timeoutMs);
    }
    const status = response.status;
    if (status >= 200 && status < 300) {
      // Inside the same classification as the fetch itself. The timeout covers headers AND body,
      // so an abort can land here — and outside this catch it escaped as a raw AbortError rather
      // than as the TsonSchemaFetchError with reason 'timeout' that this module's own doc
      // promises ("time is capped end to end, headers and body together").
      try {
        return await readCapped(reference, response, maxDocumentBytes);
      } catch (error) {
        if (error instanceof TsonSchemaFetchError) throw error;
        throw fetchFailed(reference, error, timeoutMs);
      }
    }
    // Drain the body so the connection can be released back to the pool, whatever the fate.
    await response.body?.cancel().catch(() => undefined);
    if (status >= 300 && status < 400) {
      // Not followed, by design — see this module's own top note. Reported distinctly so the fix
      // (point the reference, or the host mapping, at where the document actually is) is obvious.
      throw new TsonSchemaFetchError(
        reference,
        'transport',
        `cannot fetch schema '${reference}': the host redirected (${String(status)}), and a redirect leaves the allow-list`,
      );
    }
    if (status >= 400 && status < 500) {
      throw new TsonSchemaFetchError(
        reference,
        'not-found',
        `cannot fetch schema '${reference}': the host answered ${String(status)}`,
      );
    }
    throw new TsonSchemaFetchError(
      reference,
      'transport',
      `cannot fetch schema '${reference}': the host answered ${String(status)}`,
    );
  }

  async function fetchOne(reference: string): Promise<Uint8Array> {
    // Policy first and always -- a cache hit skips the network, not the allow-list.
    const target = permitted(reference);
    const cached = cache.get(target.canonical);
    if (cached !== undefined) {
      return cached.slice();
    }
    const running = inFlight.get(target.canonical);
    if (running !== undefined) {
      return (await running).slice();
    }
    const promise = get(reference, target.location);
    inFlight.set(target.canonical, promise);
    try {
      const document = await promise;
      if (cache.size < maxCachedSchemas) {
        cache.set(target.canonical, document);
      }
      return document.slice();
    } finally {
      inFlight.delete(target.canonical);
    }
  }

  return {
    fetch: fetchOne,
    async preload(references: readonly string[]): Promise<void> {
      for (const reference of references) {
        await fetchOne(reference);
      }
    },
    isCached(reference: string): boolean {
      try {
        return cache.has(permitted(reference).canonical);
      } catch {
        return false;
      }
    },
  };
}

/** Reads `response`'s body, aborting (and throwing `'too-large'`) the moment more than `maxDocumentBytes` has been delivered — enforced against bytes actually read, never `Content-Length`. */
async function readCapped(
  reference: string,
  response: Response,
  maxDocumentBytes: number,
): Promise<Uint8Array> {
  const body = response.body;
  if (body === null) {
    return new Uint8Array(0);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of fromReadableStream(body)) {
    total += chunk.length;
    if (total > maxDocumentBytes) {
      await body.cancel().catch(() => undefined);
      throw new TsonSchemaFetchError(
        reference,
        'too-large',
        `cannot fetch schema '${reference}': a schema document may be at most ${String(maxDocumentBytes)} bytes`,
      );
    }
    chunks.push(chunk);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function fetchFailed(reference: string, error: unknown, timeoutMs: number): TsonSchemaFetchError {
  const name = error instanceof Error ? error.name : undefined;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new TsonSchemaFetchError(
      reference,
      'timeout',
      `cannot fetch schema '${reference}': the host did not answer within ${String(timeoutMs)}ms`,
      { cause: error },
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return new TsonSchemaFetchError(
    reference,
    'transport',
    `cannot fetch schema '${reference}': the host could not be reached: ${message}`,
    { cause: error },
  );
}

function validateBase(base: string): string {
  let url: URL;
  try {
    url = new URL(base);
  } catch (error) {
    throw new TypeError(
      `'${base}' is not a URI: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    );
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TypeError(`'${base}' is not an http or https URI`);
  }
  // Trailing slash normalised away so `base + path` (identity.path always starts '/') never
  // doubles one -- mirrors the reference implementation's own `URI#resolve` behaviour for a
  // base with no path at all, without pulling in a general URI-resolution algorithm for what is
  // only ever a plain concatenation here (`identity.path` is already absolute, per §2.2.1).
  const origin = `${url.protocol}//${url.host}`;
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/u, '');
  return origin + path;
}
