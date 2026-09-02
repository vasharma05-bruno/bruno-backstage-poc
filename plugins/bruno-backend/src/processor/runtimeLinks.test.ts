import type { AuthService, DiscoveryService } from '@backstage/backend-plugin-api';
import { createRuntimeLinkReader } from './runtimeLinks';

/** The two services the reader needs, reduced to what it actually calls. */
function services(): { discovery: DiscoveryService; auth: AuthService } {
  return {
    discovery: {
      getBaseUrl: async () => 'http://backstage/api/bruno',
      getExternalBaseUrl: async () => 'http://backstage/api/bruno'
    },
    auth: {
      getOwnServiceCredentials: async () => ({}),
      getPluginRequestToken: async () => ({ token: 'plugin-token' })
    } as unknown as AuthService
  };
}

function response(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    statusText: 'OK',
    json: async () => body
  } as Response;
}

describe('createRuntimeLinkReader', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it('reads the rows out of the envelope', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      response({
        links: [
          {
            collectionRef: 'bruno:default/payments',
            apiRef: 'api:default/orders',
            createdBy: 'user:default/jane',
            createdAt: '2026-01-01T00:00:00.000Z'
          }
        ]
      })
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(createRuntimeLinkReader(services()).list()).resolves.toEqual([
      { collectionRef: 'bruno:default/payments', apiRef: 'api:default/orders' }
    ]);
    // The audit columns are dropped rather than carried: the processor turns
    // rows into relations and has no business holding who made them.
    expect(fetchMock).toHaveBeenCalledWith(
      'http://backstage/api/bruno/links',
      { headers: { Authorization: 'Bearer plugin-token' } }
    );
  });

  it('drops a row that names no relation and keeps the rest', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      response({
        links: [
          { collectionRef: 'bruno:default/a' },
          { apiRef: 'api:default/b' },
          'nonsense',
          { collectionRef: 'bruno:default/c', apiRef: 'api:default/d' }
        ]
      })
    ) as unknown as typeof fetch;

    await expect(createRuntimeLinkReader(services()).list()).resolves.toEqual([
      { collectionRef: 'bruno:default/c', apiRef: 'api:default/d' }
    ]);
  });

  it('throws on a non-OK response, without echoing the request', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      response({}, { ok: false, status: 403 })
    ) as unknown as typeof fetch;

    // Status and status text only. The caller logs this, and a message that
    // echoed the request would put the plugin bearer token in the log.
    await expect(createRuntimeLinkReader(services()).list()).rejects.toThrow(
      'GET /links failed with 403 OK'
    );
  });

  it('throws on a body that is not the route in this repository', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      response([{ collectionRef: 'bruno:default/a', apiRef: 'api:default/b' }])
    ) as unknown as typeof fetch;

    await expect(createRuntimeLinkReader(services()).list()).rejects.toThrow(
      'no `links` array'
    );
  });

  it('shares one request between overlapping callers', async () => {
    let release: (value: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetchMock = jest.fn().mockReturnValue(pending);
    global.fetch = fetchMock as unknown as typeof fetch;

    const reader = createRuntimeLinkReader(services());
    const both = Promise.all([reader.list(), reader.list()]);
    release(response({ links: [] }));
    await both;

    // Concurrency is the only thing deduplicated — there is deliberately no
    // time-based cache, because `POST /links` triggers an immediate reprocess
    // and a cache filled a moment earlier would answer it with the old list.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not pin later callers to a failed read', async () => {
    const fetchMock = jest
      .fn()
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce(response({ links: [] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const reader = createRuntimeLinkReader(services());
    await expect(reader.list()).rejects.toThrow('connection refused');
    await expect(reader.list()).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
