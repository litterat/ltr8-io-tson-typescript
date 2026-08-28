/**
 * A {@link SchemaSource} that reads a schema document from a directory on disk, under a host
 * allow-list and a hard cap on size — the port of the reference implementation's
 * `TsonFileSchemaSource` (`tson/src/main/java/io/ltr8/tson/TsonFileSchemaSource.java`). See that
 * file's own module doc for the exhaustive rationale; this module states only what differs in
 * the port. {@link httpSchemaSource} is its remote sibling; both share `reference.ts`'s own
 * {@link permittedReference} for what a reference is allowed to be, so an identity means the
 * same thing whichever of them serves it.
 *
 * **[TSON-DATA] §2.2.1 makes a reference's identity its host plus path**, independent of where it
 * is stored — so a schema named `https://schemas.example.com/order-1.tn` may legitimately live in
 * a directory, and this module is that policy. {@link FileSchemaSourceOptions.mapHosts} is the
 * whole configuration: the identity's host selects a directory, its path is resolved beneath it.
 *
 * **The reference is attacker-controlled**, the same warning `httpSchemaSource.ts` carries,
 * against a different primitive: a source that resolves whatever path it is handed is an
 * arbitrary-file-read primitive rather than an SSRF one. Hence, every one of these is enforced
 * and **none is optional**:
 *
 * - **Deny by default.** No mapped host means nothing is read, and a host is compared exactly.
 * - **The resolved file must be inside its directory, checked AFTER the path is made real.**
 *   `node:fs/promises`'s `realpath` resolves `..` and follows every symlink, so one check
 *   (`real === root || real.startsWith(root + path.sep)`) covers traversal and symlink escape
 *   together. Checking the unresolved path instead would pass a symlink that points anywhere,
 *   which is the usual way this control is defeated — the ordering is the control, not merely a
 *   detail of it.
 * - **Only a regular file is read.** A directory, device or socket is refused rather than opened.
 * - **Size is capped**, against bytes actually read (`capped.ts`'s own `readCapped`, streamed).
 * - **Policy is checked on every reference, including a cached one.**
 *
 * The traversal check is what `..` costs, and it costs nothing legitimate: §2.2.1's identities
 * are absolute URIs whose paths do not contain `..` in the first place (`link/identity.ts`'s own
 * `canonicalizeIdentity` already rejects one).
 *
 * **Caching relies on [TSON-SCHEMA] §10's immutability rule, not on the filesystem**: a file
 * edited in place after it has been read is not seen, and under §10 editing it was already the
 * mistake. There is no staleness check, deliberately — a source that re-stat'd every reference
 * would make identity mean "whatever is there now" rather than what §10 promises.
 *
 * **Node-only, and reached only through the `@ltr8/tson/source` subpath** — never from the
 * package's default entry — for the same reason `httpSchemaSource.ts` states: a browser bundle
 * that never imports that subpath never carries a filesystem-reading primitive at all.
 */
import { createReadStream, statSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

import { TsonSchemaFetchError } from '../core/errors.js';
import type { SchemaSource } from '../config.js';
import { notPermitted, permittedReference } from './reference.js';
import { readCapped } from './capped.js';

/** A schema document larger than this is refused. */
export const DEFAULT_MAX_DOCUMENT_BYTES = 1 << 20;

/** How many schema documents may be held. */
export const DEFAULT_MAX_CACHED_SCHEMAS = 128;

export interface FileSchemaSourceOptions {
  /**
   * Schemas identified by a key host are read from the mapped directory, the identity's path
   * resolved beneath it. The host is matched exactly, and nothing outside the directory is ever
   * read, symlinks included.
   *
   * There is no `allowHosts` counterpart, unlike {@link httpSchemaSource}: a host name says
   * where to fetch from over HTTPS, and says nothing at all about where a file lives.
   */
  readonly mapHosts?: Readonly<Record<string, string>>;
  /** The largest schema document that will be read. Defaults to {@link DEFAULT_MAX_DOCUMENT_BYTES}. */
  readonly maxDocumentBytes?: number;
  /** How many documents may be cached. Defaults to {@link DEFAULT_MAX_CACHED_SCHEMAS}. */
  readonly maxCachedSchemas?: number;
  /**
   * Refuses any reference carrying no `?sha256=` content-hash pin. Off by default. It buys less
   * here than it does over HTTPS -- a local directory is not a compromised origin -- but it is
   * the same control, and a deployment that pins everywhere should be able to say so uniformly.
   */
  readonly requireContentHashPin?: boolean;
}

export interface FileSchemaSource extends SchemaSource {
  /** Reads each reference now, so a later {@link fetch} finds it already cached. Call during startup, on one thread's worth of sequencing. */
  preload(references: readonly string[]): Promise<void>;
  /** Whether this identity's document is already held. `false` for anything this source would refuse -- a question about the cache is not a request to read. */
  isCached(reference: string): boolean;
}

interface Permitted {
  readonly canonical: string;
  readonly directory: string;
  readonly relative: string;
}

/** Builds a {@link FileSchemaSource}. Every default is the safe one; nothing is read until a host is mapped. */
export function fileSchemaSource(options: FileSchemaSourceOptions = {}): FileSchemaSource {
  const hosts = new Map<string, string>();
  for (const [host, directory] of Object.entries(options.mapHosts ?? {})) {
    if (host.trim() === '' || host.includes('/')) {
      throw new TypeError(`'${host}' is not a bare host name`);
    }
    if (!isExistingDirectory(directory)) {
      throw new TypeError(`'${directory}' is not an existing directory`);
    }
    hosts.set(host.toLowerCase(), directory);
  }
  const maxDocumentBytes = options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES;
  const maxCachedSchemas = options.maxCachedSchemas ?? DEFAULT_MAX_CACHED_SCHEMAS;
  const requireContentHashPin = options.requireContentHashPin ?? false;

  const cache = new Map<string, Uint8Array>();

  function policy(reference: string): Permitted {
    const identity = permittedReference(reference, requireContentHashPin);
    const directory = hosts.get(identity.host);
    if (directory === undefined) {
      throw notPermitted(
        reference,
        hosts.size === 0
          ? 'no host is mapped to a directory by this source'
          : `host '${identity.host}' is not one of ${[...hosts.keys()].join(', ')}`,
      );
    }
    const relative = identity.path.startsWith('/') ? identity.path.slice(1) : identity.path;
    if (relative === '') {
      throw notPermitted(reference, `names no path under '${directory}'`);
    }
    return { canonical: identity.canonical, directory, relative };
  }

  /**
   * The real file behind `permitted`. Containment is checked on the *real* path, and that
   * ordering is the control -- see this module's own top note.
   */
  async function locate(reference: string, permitted: Permitted): Promise<string> {
    let root: string;
    let real: string;
    try {
      root = await realpath(permitted.directory);
      real = await realpath(resolve(root, permitted.relative));
    } catch (error) {
      if (isNoEntry(error)) {
        throw new TsonSchemaFetchError(
          reference,
          'not-found',
          `cannot fetch schema '${reference}': no file backs it under '${permitted.directory}'`,
          { cause: error },
        );
      }
      throw new TsonSchemaFetchError(
        reference,
        'transport',
        `cannot fetch schema '${reference}': could not be resolved under '${permitted.directory}': ${String(error)}`,
        { cause: error },
      );
    }
    if (real !== root && !real.startsWith(root + sep)) {
      throw notPermitted(
        reference,
        `resolves to '${real}', which is outside '${root}' -- a schema path may not escape the ` +
          'directory its host is mapped to',
      );
    }
    if (!isRegularFile(real)) {
      throw notPermitted(reference, `resolves to '${real}', which is not a regular file`);
    }
    return real;
  }

  async function fetchOne(reference: string): Promise<Uint8Array> {
    // Policy first and always -- a cache hit skips the disk, not the allow-list.
    const permitted = policy(reference);
    const cached = cache.get(permitted.canonical);
    if (cached !== undefined) {
      return cached.slice();
    }
    const file = await locate(reference, permitted);
    let document: Uint8Array;
    try {
      document = await readCapped(reference, createReadStream(file), maxDocumentBytes);
    } catch (error) {
      if (isNoEntry(error)) {
        // Between the containment check and the open -- rare, and still "not here" rather than a
        // fault.
        throw new TsonSchemaFetchError(
          reference,
          'not-found',
          `cannot fetch schema '${reference}': no file backs it at '${file}'`,
          { cause: error },
        );
      }
      throw error;
    }
    if (cache.size < maxCachedSchemas) {
      cache.set(permitted.canonical, document);
    }
    return document.slice();
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
        return cache.has(policy(reference).canonical);
      } catch {
        return false;
      }
    },
  };
}

function isExistingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isNoEntry(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
