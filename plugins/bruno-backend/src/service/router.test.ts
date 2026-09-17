import type { UrlReaderServiceReadTreeResponse } from '@backstage/backend-plugin-api';
import {
  TestDatabases,
  mockCredentials,
  mockServices,
  startTestBackend
} from '@backstage/backend-test-utils';
import type { Entity } from '@backstage/catalog-model';
import { catalogServiceMock } from '@backstage/plugin-catalog-node/testUtils';
import request from 'supertest';
import { brunoPlugin } from '../plugin';

/**
 * The whole point of driving the plugin through `startTestBackend` rather than
 * mounting `createRouter` on a bare Express app: `mockServices.httpRouter` is
 * the REAL `httpRouterServiceFactory`, so the plugin is mounted at
 * `/api/bruno` behind the real credentials barrier and the `addAuthPolicy`
 * calls in `plugin.ts` are genuinely enforced. A hand-rolled app would exercise
 * the route handlers' own `httpAuth.credentials` calls and nothing else, and
 * every assertion about `/health` being open or the docs route accepting a
 * cookie would be about a barrier that was not there.
 *
 * Two things would quietly make this whole file vacuous, and both are avoided
 * deliberately:
 *
 *  - `mockServices.httpAuth` DEFAULTS a request with no credentials to the mock
 *    USER. Left alone, every "answers 401" case below would pass while proving
 *    only that the mock is generous. `defaultCredentials` is pinned to `none`.
 *  - `backend.auth.dangerouslyDisableDefaultAuthPolicy` replaces the barrier
 *    with a pass-through. It is never set in the config here, and must not be.
 */
const USER = mockCredentials.user.header();
const SERVICE = mockCredentials.service.header();
const NONE = mockCredentials.none.header();

const COLLECTION_URL = 'https://github.com/acme/payments/tree/main/collection';

/** What `bruno.allowedSources` has to say for `COLLECTION_URL` to be readable.
 *  Every test below runs with this unless it is testing the absent-key case. */
const ALLOWED_SOURCES = [{ host: 'github.com', pathPrefixes: ['/acme'] }];

/** A `kind: Bruno` entity carrying a stored definition, so the docs route has
 *  something to render, plus the API the link routes point at. */
const CATALOG_ENTITIES: Entity[] = [
  {
    apiVersion: 'usebruno.com/v1alpha1',
    kind: 'Bruno',
    metadata: { name: 'payments', namespace: 'default', title: 'Payments' },
    spec: { definition: 'name: Payments\nversion: 1.0.0\n' }
  },
  {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'API',
    metadata: { name: 'orders', namespace: 'default' },
    spec: {
      type: 'openapi',
      lifecycle: 'production',
      owner: 'group:default/team',
      definition: 'openapi: 3.0.0\n'
    }
  }
];

/** A one-file collection tree, enough for `detectManifest` to answer `bru`. */
function treeResponse(): UrlReaderServiceReadTreeResponse {
  return {
    etag: 'commit-sha',
    files: async () => [
      {
        path: 'bruno.json',
        content: async () =>
          Buffer.from('{"name":"Payments","version":"1.0.0"}', 'utf8')
      }
    ],
    archive: () => Promise.reject(new Error('not used by these tests')),
    dir: () => Promise.reject(new Error('not used by these tests'))
  };
}

const databases = TestDatabases.create({ ids: ['SQLITE_3'] });

describe('bruno router', () => {
  let knex: Awaited<ReturnType<typeof databases.init>>;
  let running: Array<Awaited<ReturnType<typeof startTestBackend>>>;

  beforeEach(async () => {
    knex = await databases.init('SQLITE_3');
    running = [];
  });

  afterEach(async () => {
    await Promise.all(running.map((backend) => backend.stop()));
  });

  /**
   * Starts the plugin against one shared `knex`, so a test can hand a row
   * written by a backend with `allowRuntimeWrites` ON to a second backend with
   * it OFF — which is the only way to exercise what the flag does and does not
   * retract.
   */
  async function startBruno(options?: {
    allowRuntimeWrites?: boolean;
    /** `null` omits the key entirely — the fail-closed default an adopter who
     *  has configured nothing is in. */
    allowedSources?: typeof ALLOWED_SOURCES | null;
  }) {
    const reader = mockServices.urlReader.mock();
    reader.readTree.mockResolvedValue(treeResponse());
    const logger = mockServices.logger.mock();
    const backend = await startTestBackend({
      features: [
        brunoPlugin,
        mockServices.rootConfig.factory({
          data: {
            app: { baseUrl: 'http://localhost:3000' },
            backend: { baseUrl: 'http://localhost:7007' },
            bruno: {
              allowRuntimeWrites: options?.allowRuntimeWrites ?? false,
              schedule: { frequencySeconds: 30 },
              ...(options?.allowedSources === null
                ? {}
                : {
                    allowedSources:
                      options?.allowedSources ?? ALLOWED_SOURCES
                  })
            }
          }
        }),
        mockServices.httpAuth.factory({
          defaultCredentials: mockCredentials.none()
        }),
        mockServices.database.factory({ knex }),
        logger.factory,
        catalogServiceMock.factory({ entities: CATALOG_ENTITIES }),
        reader.factory
      ]
    });
    running.push(backend);
    return { server: backend.server, reader, logger };
  }

  describe('GET /health', () => {
    it('is reachable with no credentials at all', async () => {
      const { server } = await startBruno();
      await expect(
        request(server).get('/api/bruno/health').expect(200)
      ).resolves.toMatchObject({ body: { status: 'ok' } });
      await request(server)
        .get('/api/bruno/health')
        .set('Authorization', NONE)
        .expect(200);
    });
  });

  describe('POST /collections/probe', () => {
    it('refuses an unauthenticated caller before reading anything', async () => {
      const { server, reader } = await startBruno();
      await request(server)
        .post('/api/bruno/collections/probe')
        .set('Authorization', NONE)
        .send({ url: COLLECTION_URL })
        .expect(401);
      expect(reader.readTree).not.toHaveBeenCalled();
    });

    it('refuses a service principal', async () => {
      const { server, reader } = await startBruno();
      await request(server)
        .post('/api/bruno/collections/probe')
        .set('Authorization', SERVICE)
        .send({ url: COLLECTION_URL })
        .expect(403);
      expect(reader.readTree).not.toHaveBeenCalled();
    });

    it('logs a failed scan with the URL as structured metadata', async () => {
      const { server, logger } = await startBruno();
      // A URL no provider can parse, carrying a newline and something that
      // reads like a second log line.
      const url = 'not-a-url\nlevel=info msg="forged log line"';
      await request(server)
        .post('/api/bruno/collections/probe')
        .set('Authorization', USER)
        .send({ url })
        .expect(400);

      expect(logger.info).toHaveBeenCalledWith(
        'Bruno collection probe failed.',
        expect.objectContaining({ url })
      );
      // Nothing from the request body reaches a log MESSAGE. The value is the
      // request body's verbatim, unvalidated, un-normalised string at this
      // point, so interpolating it would let any authenticated caller write
      // whole lines into the log.
      for (const [message] of logger.info.mock.calls) {
        expect(message).not.toContain('forged log line');
      }
    });

    it('scans as a user, reading the tree exactly once', async () => {
      const { server, reader } = await startBruno();
      const res = await request(server)
        .post('/api/bruno/collections/probe')
        .set('Authorization', USER)
        .send({ url: COLLECTION_URL })
        .expect(200);
      expect(res.body).toMatchObject({ found: true, format: 'bru' });
      expect(reader.readTree).toHaveBeenCalledTimes(1);
    });
  });

  describe('POST /collections', () => {
    const body = { url: COLLECTION_URL, name: 'payments-ui' };

    it('refuses an unauthenticated caller', async () => {
      const { server, reader } = await startBruno({
        allowRuntimeWrites: true
      });
      await request(server)
        .post('/api/bruno/collections')
        .set('Authorization', NONE)
        .send(body)
        .expect(401);
      expect(reader.readTree).not.toHaveBeenCalled();
    });

    it('refuses a service principal', async () => {
      const { server } = await startBruno({ allowRuntimeWrites: true });
      await request(server)
        .post('/api/bruno/collections')
        .set('Authorization', SERVICE)
        .send(body)
        .expect(403);
    });

    it('refuses a user when allowRuntimeWrites is off, naming the key', async () => {
      const { server, reader } = await startBruno();
      const res = await request(server)
        .post('/api/bruno/collections')
        .set('Authorization', USER)
        .send(body)
        .expect(403);
      expect(res.body.error.message).toContain('bruno.allowRuntimeWrites');
      // The gate is checked before anything is read, so a refused create costs
      // no SCM call at all.
      expect(reader.readTree).not.toHaveBeenCalled();
    });

    it('creates as a user when the gate is open', async () => {
      const { server } = await startBruno({ allowRuntimeWrites: true });
      const res = await request(server)
        .post('/api/bruno/collections')
        .set('Authorization', USER)
        .send({ ...body, partOf: ['api:default/orders'] })
        .expect(201);
      expect(res.body).toMatchObject({
        name: 'payments-ui',
        entityRef: 'bruno:default/payments-ui',
        refreshSeconds: 30
      });
    });

    it('caps the partOf list', async () => {
      const { server } = await startBruno({ allowRuntimeWrites: true });
      const partOf = Array.from(
        { length: 101 },
        (_v, i) => `api:default/api-${i}`
      );
      const res = await request(server)
        .post('/api/bruno/collections')
        .set('Authorization', USER)
        .send({ ...body, partOf })
        .expect(400);
      expect(res.body.error.message).toContain('at most 100');
    });

    it('refuses a body over the JSON size cap', async () => {
      const { server } = await startBruno({ allowRuntimeWrites: true });
      await request(server)
        .post('/api/bruno/collections')
        .set('Authorization', USER)
        .send({ ...body, title: 'x'.repeat(70 * 1024) })
        .expect(413);
    });
  });

  /**
   * `bruno.allowedSources`, run against BOTH routes that take a URL from a
   * request body. One guard on one route would be no guard at all: the create
   * route performs the same read, so a caller refused at `/collections/probe`
   * would simply post to `/collections` instead.
   *
   * THE LOAD-BEARING ASSERTION IS THE CALL COUNT. A test that only checked for
   * a 403 would pass just as happily if the fetch had already happened and the
   * refusal came afterwards, which is precisely the bug this guard exists to
   * prevent — the quota is spent and the existence question is answered the
   * moment `readTree` runs, whatever status code follows.
   */
  describe('bruno.allowedSources', () => {
    const REFUSED: Array<[string, string]> = [
      ['the cloud metadata endpoint', 'https://169.254.169.254/latest/meta-data/'],
      ['loopback pointing at this backend', 'http://127.0.0.1:7007/api/bruno/collections'],
      ['a file: URL', 'file:///etc/passwd'],
      ['an IPv6 literal', 'https://[::1]/acme/payments'],
      ['http:// without allowInsecure', 'http://github.com/acme/payments'],
      ['an allowed host with a disallowed owner', 'https://github.com/evil/secrets'],
      ['a prefix match that is not a whole segment', 'https://github.com/acme-legacy/x']
    ];

    it.each(REFUSED)('refuses %s on both routes, before any read', async (_what, url) => {
      const { server, reader } = await startBruno({ allowRuntimeWrites: true });
      await request(server)
        .post('/api/bruno/collections/probe')
        .set('Authorization', USER)
        .send({ url })
        .expect(403);
      await request(server)
        .post('/api/bruno/collections')
        .set('Authorization', USER)
        .send({ url, name: 'payments-ui' })
        .expect(403);
      expect(reader.readTree).not.toHaveBeenCalled();
    });

    it('refuses every URL when the key is absent, naming it, on both routes', async () => {
      const { server, reader } = await startBruno({
        allowRuntimeWrites: true,
        allowedSources: null
      });
      const probed = await request(server)
        .post('/api/bruno/collections/probe')
        .set('Authorization', USER)
        .send({ url: COLLECTION_URL })
        .expect(403);
      expect(probed.body.error.message).toContain('bruno.allowedSources');

      const created = await request(server)
        .post('/api/bruno/collections')
        .set('Authorization', USER)
        .send({ url: COLLECTION_URL, name: 'payments-ui' })
        .expect(403);
      expect(created.body.error.message).toContain('bruno.allowedSources');
      expect(reader.readTree).not.toHaveBeenCalled();
    });

    it('reads an allowed URL exactly once, normalised', async () => {
      const { server, reader } = await startBruno({ allowRuntimeWrites: true });
      await request(server)
        .post('/api/bruno/collections/probe')
        .set('Authorization', USER)
        // Trailing slash and a fragment: what the gate returns is what is read.
        .send({ url: `${COLLECTION_URL}/#readme` })
        .expect(200);
      expect(reader.readTree).toHaveBeenCalledTimes(1);
      expect(reader.readTree).toHaveBeenCalledWith(COLLECTION_URL, undefined);
    });

    it('sits behind allowRuntimeWrites on the create route', async () => {
      // Pinned because the order is a disclosure decision, not an accident: an
      // instance that has turned writes off answers with THAT and never says
      // whether the URL would have been accepted.
      const { server, reader } = await startBruno({ allowRuntimeWrites: false });
      const res = await request(server)
        .post('/api/bruno/collections')
        .set('Authorization', USER)
        .send({ url: 'https://github.com/evil/secrets', name: 'x' })
        .expect(403);
      expect(res.body.error.message).toContain('bruno.allowRuntimeWrites');
      expect(reader.readTree).not.toHaveBeenCalled();
    });
  });

  describe('POST /collections/probe rate limit', () => {
    it('answers 429 with a Retry-After once a user spends the window', async () => {
      const { server } = await startBruno();
      const scan = () =>
        request(server)
          .post('/api/bruno/collections/probe')
          .set('Authorization', USER)
          .send({ url: COLLECTION_URL });

      // 30 per minute, from `createProbeRateLimiter`'s defaults.
      for (let i = 0; i < 30; i++) {
        await scan().expect(200);
      }
      const res = await scan().expect(429);
      expect(res.headers['retry-after']).toBeDefined();
      expect(res.body.reason).toBe('rate-limited');
    });
  });

  describe('GET /collections', () => {
    it('refuses an unauthenticated caller', async () => {
      const { server } = await startBruno();
      await request(server)
        .get('/api/bruno/collections')
        .set('Authorization', NONE)
        .expect(401);
    });

    it('omits createdBy for a user and keeps it for a service', async () => {
      const { server } = await startBruno({ allowRuntimeWrites: true });
      await request(server)
        .post('/api/bruno/collections')
        .set('Authorization', USER)
        .send({ url: COLLECTION_URL, name: 'payments-ui' })
        .expect(201);

      const asUser = await request(server)
        .get('/api/bruno/collections')
        .set('Authorization', USER)
        .expect(200);
      expect(asUser.body.collections).toHaveLength(1);
      expect(asUser.body.collections[0]).not.toHaveProperty('createdBy');

      const asService = await request(server)
        .get('/api/bruno/collections')
        .set('Authorization', SERVICE)
        .expect(200);
      expect(asService.body.collections[0].createdBy).toBe('user:default/mock');
    });
  });

  describe('DELETE /collections/:name', () => {
    it('refuses an unauthenticated caller and a service principal', async () => {
      const { server } = await startBruno();
      await request(server)
        .delete('/api/bruno/collections/payments-ui')
        .set('Authorization', NONE)
        .expect(401);
      await request(server)
        .delete('/api/bruno/collections/payments-ui')
        .set('Authorization', SERVICE)
        .expect(403);
    });

    it('folds case the same way getByName does', async () => {
      // A row stored as `Payments` has to be removable as `payments`: an entity
      // ref is lower-cased when it is stringified, so the two spellings are one
      // entity. With the two comparisons disagreeing this is a 404 today, and
      // the moment an ownership check reads the row before deleting it, the
      // check and the write are about different rows.
      const { server } = await startBruno({ allowRuntimeWrites: true });
      await request(server)
        .post('/api/bruno/collections')
        .set('Authorization', USER)
        .send({ url: COLLECTION_URL, name: 'Payments' })
        .expect(201);
      await request(server)
        .delete('/api/bruno/collections/payments')
        .set('Authorization', USER)
        .expect(200);
    });

    it('is NOT gated on allowRuntimeWrites, unlike the create', async () => {
      // Pinned deliberately. Turning the key off does not retract rows that
      // already exist — the provider keeps materialising them — so a delete has
      // to outlive the permission that created the row. See
      // `requireRuntimeWrites` in router.ts.
      const open = await startBruno({ allowRuntimeWrites: true });
      await request(open.server)
        .post('/api/bruno/collections')
        .set('Authorization', USER)
        .send({ url: COLLECTION_URL, name: 'payments-ui' })
        .expect(201);

      const closed = await startBruno({ allowRuntimeWrites: false });
      await request(closed.server)
        .delete('/api/bruno/collections/payments-ui')
        .set('Authorization', USER)
        .expect(200);
    });
  });

  describe('GET /links', () => {
    it('is service-only', async () => {
      const { server } = await startBruno();
      await request(server)
        .get('/api/bruno/links')
        .set('Authorization', NONE)
        .expect(401);
      await request(server)
        .get('/api/bruno/links')
        .set('Authorization', USER)
        .expect(403);
      const res = await request(server)
        .get('/api/bruno/links')
        .set('Authorization', SERVICE)
        .expect(200);
      expect(res.body).toEqual({ links: [] });
    });
  });

  describe('POST /links', () => {
    const body = {
      collectionRef: 'bruno:default/payments',
      apiRefs: ['api:default/orders']
    };

    it('refuses an unauthenticated caller and a service principal', async () => {
      const { server } = await startBruno({ allowRuntimeWrites: true });
      await request(server)
        .post('/api/bruno/links')
        .set('Authorization', NONE)
        .send(body)
        .expect(401);
      await request(server)
        .post('/api/bruno/links')
        .set('Authorization', SERVICE)
        .send(body)
        .expect(403);
    });

    it('refuses a user when allowRuntimeWrites is off', async () => {
      const { server } = await startBruno();
      const res = await request(server)
        .post('/api/bruno/links')
        .set('Authorization', USER)
        .send(body)
        .expect(403);
      expect(res.body.error.message).toContain('bruno.allowRuntimeWrites');
    });

    it('links as a user when the gate is open', async () => {
      const { server } = await startBruno({ allowRuntimeWrites: true });
      const res = await request(server)
        .post('/api/bruno/links')
        .set('Authorization', USER)
        .send(body)
        .expect(201);
      expect(res.body).toMatchObject({
        linked: true,
        collectionRef: 'bruno:default/payments',
        apiRefs: ['api:default/orders']
      });
    });

    it('caps the apiRefs list', async () => {
      const { server } = await startBruno({ allowRuntimeWrites: true });
      const apiRefs = Array.from(
        { length: 101 },
        (_v, i) => `api:default/api-${i}`
      );
      const res = await request(server)
        .post('/api/bruno/links')
        .set('Authorization', USER)
        .send({ ...body, apiRefs })
        .expect(400);
      expect(res.body.error.message).toContain('At most 100');
    });
  });

  describe('DELETE /links', () => {
    const query
      = '?collection=bruno:default/payments&api=api:default/orders';

    it('refuses an unauthenticated caller', async () => {
      const { server } = await startBruno();
      await request(server)
        .delete(`/api/bruno/links${query}`)
        .set('Authorization', NONE)
        .expect(401);
    });

    it('is not gated on allowRuntimeWrites either', async () => {
      // A 404 rather than a 403 is the assertion: the request reached the store
      // and found no row, which is only possible past the gate.
      const { server } = await startBruno();
      await request(server)
        .delete(`/api/bruno/links${query}`)
        .set('Authorization', USER)
        .expect(404);
    });
  });

  describe('GET /entities/:namespace/:name/docs', () => {
    it('accepts the limited-access cookie with no Authorization header', async () => {
      const { server } = await startBruno();
      const res = await request(server)
        .get('/api/bruno/entities/default/payments/docs')
        .set('Cookie', mockCredentials.limitedUser.cookie())
        .expect(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.text).toContain('OpenCollection');
      expect(res.headers['x-frame-options']).toBeUndefined();
    });

    it('refuses a caller with neither a cookie nor a token', async () => {
      const { server } = await startBruno();
      await request(server)
        .get('/api/bruno/entities/default/payments/docs')
        .set('Authorization', NONE)
        .expect(401);
    });
  });
});
