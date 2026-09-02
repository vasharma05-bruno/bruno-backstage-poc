/**
 * Covers the two-tier revalidation contract, and specifically the invariant that
 * is invisible to a typecheck: an identity learned by tier 1 must be persisted
 * even when tier 2 then reports the tree unchanged. Get that wrong and the free
 * path is never reached — every cycle re-seeds and every cycle pays.
 */
import type { LoggerService, UrlReaderService } from '@backstage/backend-plugin-api';
import { ConfigReader } from '@backstage/config';
import { NotModifiedError } from '@backstage/errors';
import { createManifestProbe } from './manifestProbe';

const URL_UNDER_TEST
  = 'https://github.com/acme/collections/tree/main/checkout';

function stubLogger(): LoggerService {
  const logger: LoggerService = {
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
    child: () => logger
  };
  return logger;
}

/** A tree with the smallest thing `detectManifest` will accept. */
function treeFiles(): Array<{ path: string; content: () => Promise<Buffer> }> {
  return [
    {
      path: 'bruno.json',
      content: async () =>
        Buffer.from(JSON.stringify({ name: 'Checkout', version: '2' }))
    }
  ];
}

/**
 * A reader that hands out `etag` and, once `notModifiedFrom` is set, throws
 * `NotModifiedError` for exactly that etag — the real reader's behaviour.
 */
function fakeReader(etag: string) {
  const readTree = jest.fn(
    async (_url: string, options?: { etag?: string }) => {
      if (options?.etag === etag) {
        throw new NotModifiedError();
      }
      return { files: async () => treeFiles(), etag };
    }
  );
  return { reader: { readTree } as unknown as UrlReaderService, readTree };
}

function makeProbe(reader: UrlReaderService) {
  return createManifestProbe({
    config: new ConfigReader({
      integrations: { github: [{ host: 'github.com', token: 'test-token' }] }
    }),
    reader,
    logger: stubLogger(),
    definition: { maxBytes: 1048576 },
    // Every call is past the TTL, so each one exercises a revalidation rather
    // than the in-memory short circuit.
    ttlMs: 0
  });
}

/** The `fetch` calls the GitHub identity check made, in order. */
type Recorded = { url: string; ifNoneMatch?: string };

function stubFetch(
  responses: Array<{ status: number; etag?: string; sha?: string }>
): { calls: Recorded[] } {
  const calls: Recorded[] = [];
  let index = 0;
  global.fetch = jest.fn(async (input: unknown, init?: unknown) => {
    const headers = ((init as { headers?: Record<string, string> })?.headers
      ?? {}) as Record<string, string>;
    calls.push({
      url: String(input),
      ifNoneMatch: headers['if-none-match']
    });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next.status === 304) {
      return {
        status: 304,
        ok: false,
        headers: new Headers(),
        json: async () => undefined
      } as unknown as Response;
    }
    return {
      status: 200,
      ok: true,
      headers: new Headers(next.etag ? { etag: next.etag } : {}),
      json: async () => [{ sha: next.sha ?? 'sha-1' }]
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('createManifestProbe revalidation tiers', () => {
  it('makes no identity call on a cold read, and reads the tree', async () => {
    const { reader, readTree } = fakeReader('commit-a');
    const { calls } = stubFetch([{ status: 200, etag: 'W/"e1"' }]);
    const probe = makeProbe(reader);

    const snapshot = await probe.probe(URL_UNDER_TEST);

    expect(snapshot?.manifestPath).toBe('bruno.json');
    expect(snapshot?.name).toBe('Checkout');
    // Nothing cached means the check could only answer `changed`, so it is a
    // pure extra call and must be skipped.
    expect(calls).toHaveLength(0);
    expect(readTree).toHaveBeenCalledTimes(1);
  });

  it('seeds the identity ONCE, then revalidates for free on every later cycle', async () => {
    const { reader, readTree } = fakeReader('commit-a');
    const { calls } = stubFetch([
      // Cycle 2: no stored etag to send, so GitHub answers 200 and this is the
      // one call that seeds the identity.
      { status: 200, etag: 'W/"e1"', sha: 'sha-1' },
      // Every cycle after: the replayed If-None-Match matches.
      { status: 304 }
    ]);
    const probe = makeProbe(reader);

    await probe.probe(URL_UNDER_TEST);
    expect(readTree).toHaveBeenCalledTimes(1);

    // Cycle 2 — tier 1 reports `changed` (nothing to compare), tier 2 then
    // reports NotModified. The snapshot survives and the identity is stored.
    const second = await probe.probe(URL_UNDER_TEST);
    expect(second?.manifestPath).toBe('bruno.json');
    expect(calls).toHaveLength(1);
    expect(calls[0].ifNoneMatch).toBeUndefined();
    expect(readTree).toHaveBeenCalledTimes(2);

    // Cycles 3 and 4 — THE INVARIANT. The etag learned in cycle 2 is replayed,
    // the host answers 304, and the reader is never touched again.
    const third = await probe.probe(URL_UNDER_TEST);
    const fourth = await probe.probe(URL_UNDER_TEST);

    expect(third?.manifestPath).toBe('bruno.json');
    expect(fourth?.manifestPath).toBe('bruno.json');
    expect(calls).toHaveLength(3);
    expect(calls[1].ifNoneMatch).toBe('W/"e1"');
    expect(calls[2].ifNoneMatch).toBe('W/"e1"');
    expect(readTree).toHaveBeenCalledTimes(2);
  });

  it('scopes the identity call to the collection subpath and ref', async () => {
    const { reader } = fakeReader('commit-a');
    const { calls } = stubFetch([
      { status: 200, etag: 'W/"e1"' },
      { status: 304 }
    ]);
    const probe = makeProbe(reader);

    await probe.probe(URL_UNDER_TEST);
    await probe.probe(URL_UNDER_TEST);

    const called = new URL(calls[0].url);
    expect(called.pathname).toBe('/repos/acme/collections/commits');
    expect(called.searchParams.get('sha')).toBe('main');
    expect(called.searchParams.get('path')).toBe('checkout');
    expect(called.searchParams.get('per_page')).toBe('1');
  });

  it('falls through to a full read when the identity call fails', async () => {
    const { reader, readTree } = fakeReader('commit-a');
    // A 500 is `failed` -> `unknown`, which must not fail the probe.
    stubFetch([{ status: 500 }]);
    const probe = makeProbe(reader);

    await probe.probe(URL_UNDER_TEST);
    const second = await probe.probe(URL_UNDER_TEST);

    // Tier 2 still short-circuits on its own etag, so the snapshot survives.
    expect(second?.manifestPath).toBe('bruno.json');
    expect(readTree).toHaveBeenCalledTimes(2);
  });

  it('re-reads the tree when the identity moved', async () => {
    const { reader, readTree } = fakeReader('commit-a');
    stubFetch([
      { status: 200, etag: 'W/"e1"', sha: 'sha-1' },
      { status: 200, etag: 'W/"e2"', sha: 'sha-2' }
    ]);
    const probe = makeProbe(reader);

    await probe.probe(URL_UNDER_TEST);
    await probe.probe(URL_UNDER_TEST);
    await probe.probe(URL_UNDER_TEST);

    // A `changed` verdict never skips the read; the reader's own etag decides
    // whether the download happens.
    expect(readTree).toHaveBeenCalledTimes(3);
  });
});
