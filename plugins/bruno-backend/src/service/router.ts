import type {
  HttpAuthService,
  LoggerService,
  UserInfoService
} from '@backstage/backend-plugin-api';
import { MiddlewareFactory } from '@backstage/backend-defaults/rootHttpRouter';
import type { Config } from '@backstage/config';
import { InputError } from '@backstage/errors';
import express from 'express';
import Router from 'express-promise-router';
import type { CollectionService } from './collectionService';
import { collectionIdFromUrl } from './collectionService';
import type { ConnectionStore } from '../store/connectionStore';
import type { CollectionsStore } from '../store/collectionsStore';
import { generateOcDocsHtml } from './generateOcDocsHtml';
import {
  redactCollectionDetail,
  toOpenCollectionYaml
} from './openCollectionExport';

export interface RouterOptions {
  logger: LoggerService;
  config: Config;
  collectionService: CollectionService;
  connectionStore: ConnectionStore;
  collectionsStore: CollectionsStore;
  httpAuth: HttpAuthService;
  userInfo: UserInfoService;
}

/**
 * Builds the Express router implementing the shared API contract
 * (docs/POC-DECISIONS.md §3).
 *
 *   GET /health                 -> { status: 'ok' }
 *   GET /collections            -> Array<CollectionSummary>
 *   POST /collections/import    -> { imported: number } (import unlinked collections)
 *   GET /collections/imported   -> Array<ImportedCollection>
 *   DELETE /collections/imported/:id -> 204 (remove an imported-but-unlinked collection)
 *   GET /collections/:id        -> CollectionDetail (404 if unknown)
 *   GET /collections/:id/docs   -> text/html (self-contained Scenario-B docs)
 *   GET /collections/:id/opencollection.yml -> text/yaml (OpenCollection export)
 *   POST /collections/:id/sync  -> live re-pull from the SCM host, refresh cache
 *   GET /dashboard              -> Dashboard (stats + cards + failed sources)
 *   POST /connections/discover  -> DiscoverResult (all collection roots in a repo)
 *   POST /refresh               -> re-reads and re-parses all sources
 */
export async function createRouter(
  options: RouterOptions
): Promise<express.Router> {
  const {
    logger,
    config,
    collectionService,
    connectionStore,
    collectionsStore,
    httpAuth,
    userInfo
  } = options;

  const router = Router();
  router.use(express.json());

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/collections', async (req, res) => {
    await httpAuth.credentials(req, { allow: ['user'] });
    res.json(collectionService.listCollections());
  });

  router.post('/collections/import', async (req, res) => {
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    const { userEntityRef } = await userInfo.getUserInfo(credentials);
    const { collections } = req.body ?? {};
    if (!Array.isArray(collections) || collections.length === 0) {
      throw new InputError('`collections` must be a non-empty array.');
    }
    let count = 0;
    for (const c of collections) {
      if (!c?.sourceUrl || !c?.name) {
        throw new InputError('Each collection needs `sourceUrl` and `name`.');
      }
      let collectionId: string;
      try {
        collectionId = collectionIdFromUrl(c.sourceUrl);
      } catch {
        throw new InputError(`Invalid sourceUrl: ${c.sourceUrl}`);
      }
      await collectionsStore.upsert({
        collectionId,
        sourceUrl: c.sourceUrl,
        name: c.name,
        importedBy: userEntityRef
      });
      count += 1;
    }
    res.json({ imported: count });
  });

  router.get('/collections/imported', async (req, res) => {
    await httpAuth.credentials(req, { allow: ['user', 'service'] });
    const rows = await collectionsStore.listAll();
    res.json(
      rows.map((row) => ({
        collectionId: row.collectionId,
        name: row.name,
        sourceUrl: row.sourceUrl,
        importedBy: row.importedBy,
        updatedAt: row.updatedAt
      }))
    );
  });

  router.delete('/collections/imported/:id', async (req, res) => {
    await httpAuth.credentials(req, { allow: ['user'] });
    const id = req.params.id;
    await collectionsStore.delete(id);
    // Defensive: `collectionIdFromUrl` is deterministic, so an imported id can
    // collide with a live connected-cache entry. The eviction is a no-op for a
    // purely-imported row and is idempotent.
    collectionService.evictConnected(id);
    res.status(204).end();
  });

  router.get('/collections/:id', async (req, res) => {
    await httpAuth.credentials(req, { allow: ['user'] });
    const detail = collectionService.getCollection(req.params.id);
    if (!detail) {
      res.status(404).json({ error: `Unknown collection: ${req.params.id}` });
      return;
    }
    // Redact secrets before returning: the raw detail otherwise leaks env-var
    // values + auth secrets in plaintext. Same choke point as the YAML export.
    res.json(redactCollectionDetail(detail));
  });

  // No in-handler credentials call: the `user-cookie` auth policy (plugin.ts)
  // already gates this route via the credentials barrier, accepting either a
  // full user/service token OR the Backstage limited-access cookie the iframe
  // carries. A bearer-only `credentials` read here would reject that cookie.
  router.get('/collections/:id/docs', (req, res) => {
    // Apply the embedding headers up-front — BEFORE the 404 branch — so the
    // error page is framable too. Otherwise Helmet's default
    // `X-Frame-Options: SAMEORIGIN` blocks the app from rendering the 404 in the
    // iframe and the user sees a cryptic "refused to connect" instead of the
    // "Unknown collection" message. Serving the docs as a real document (iframe
    // `src`, not `srcdoc`) is what gives the OpenCollection bundle a real
    // origin for its sessionStorage + HashRouter; the page is framed by the
    // Backstage app (a different origin in dev: :3000 vs :7007), so we override
    // the headers that would otherwise block cross-origin embedding.
    applyDocsEmbeddingHeaders(res, config);
    const detail = collectionService.getCollection(req.params.id);
    if (!detail) {
      res
        .status(404)
        .type('text/html')
        .send(`<!DOCTYPE html><html><body><h1>404</h1><p>Unknown collection: ${escapeHtml(
          req.params.id
        )}</p></body></html>`);
      return;
    }
    const theme = req.query.theme === 'dark' ? 'dark' : 'light';
    const yaml = toOpenCollectionYaml(detail);
    res.type('text/html').send(generateOcDocsHtml(yaml, detail.name, theme));
  });

  router.get('/collections/:id/opencollection.yml', async (req, res) => {
    await httpAuth.credentials(req, { allow: ['user'] });
    const detail = collectionService.getCollection(req.params.id);
    if (!detail) {
      res.status(404).json({ error: `Unknown collection: ${req.params.id}` });
      return;
    }
    res.type('text/yaml').send(toOpenCollectionYaml(detail));
  });

  router.post('/collections/:id/sync', async (req, res) => {
    await httpAuth.credentials(req, { allow: ['user'] });
    const id = req.params.id;
    const userToken = scmTokenFromHeader(req);
    // Resolve the source URL: a runtime connection row first, else the cached
    // collection's own sourceUrl. Local collections (no remote source) cannot
    // be synced.
    const rows = await connectionStore.listAll();
    const row = rows.find((r) => r.collectionId === id);
    const url = row?.sourceUrl ?? collectionService.getCollection(id)?.sourceUrl;
    if (!url) {
      res
        .status(404)
        .json({ error: `No syncable remote source for collection: ${id}` });
      return;
    }
    const detail = await collectionService.syncCollection({ id, url, userToken });
    res.json({
      collectionId: id,
      name: detail.name,
      requestCount: detail.requestCount
    });
  });

  router.get('/dashboard', async (req, res) => {
    await httpAuth.credentials(req, { allow: ['user', 'service'] });
    const links = await connectionStore.listAll();
    const imported = await collectionsStore.listAll();
    res.json(collectionService.getDashboard(links, imported));
  });

  router.post('/connections', async (req, res) => {
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    const { userEntityRef } = await userInfo.getUserInfo(credentials);

    const { entityRef, url } = req.body ?? {};
    if (!entityRef || !url) {
      throw new InputError('`entityRef` and `url` are required.');
    }

    const { collectionId, detail } = await collectionService.connectFromUrl({
      url,
      userToken: scmTokenFromHeader(req)
    });

    await connectionStore.upsert({
      entityRef,
      sourceUrl: detail.sourceUrl!,
      collectionId,
      connectedBy: userEntityRef
    });

    res.json({
      collectionId,
      name: detail.name,
      requestCount: detail.requestCount
    });
  });

  router.post('/connections/discover', async (req, res) => {
    await httpAuth.credentials(req, { allow: ['user'] });

    const { url } = req.body ?? {};
    if (!url) {
      throw new InputError('`url` is required.');
    }

    res.json(
      await collectionService.discoverCollections({
        url,
        userToken: scmTokenFromHeader(req)
      })
    );
  });

  router.get('/connections', async (req, res) => {
    await httpAuth.credentials(req, { allow: ['user', 'service'] });
    const rows = await connectionStore.listAll();
    res.json(
      rows.map((row) => ({
        entityRef: row.entityRef,
        collectionId: row.collectionId,
        sourceUrl: row.sourceUrl,
        connectedBy: row.connectedBy,
        updatedAt: row.updatedAt
      }))
    );
  });

  router.get('/connections/:entityRef', async (req, res) => {
    await httpAuth.credentials(req, { allow: ['user'] });
    const row = await connectionStore.getByEntityRef(req.params.entityRef);
    if (!row) {
      res
        .status(404)
        .json({ error: `No connection for entity: ${req.params.entityRef}` });
      return;
    }
    res.json({
      entityRef: row.entityRef,
      collectionId: row.collectionId,
      sourceUrl: row.sourceUrl,
      connectedBy: row.connectedBy,
      updatedAt: row.updatedAt
    });
  });

  router.delete('/connections/:entityRef', async (req, res) => {
    await httpAuth.credentials(req, { allow: ['user'] });
    const entityRef = req.params.entityRef;
    const row = await connectionStore.getByEntityRef(entityRef);
    await connectionStore.delete(entityRef);
    if (row) {
      collectionService.evictConnected(row.collectionId);
    }
    res.status(204).end();
  });

  // Manual refresh endpoint (handy for the POC / demos).
  router.post('/refresh', async (_req, res) => {
    await collectionService.refresh();
    res.json({ status: 'ok', collections: collectionService.listCollections().length });
  });

  // Error handling per current Backstage conventions.
  const middleware = MiddlewareFactory.create({ logger, config });
  router.use(middleware.error());

  return router;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Reads the caller's SCM OAuth token from the `x-bruno-scm-token` request
 * header (the frontend sends it here, never in the JSON body). Returns
 * `undefined` when absent or empty. The token is never logged.
 */
function scmTokenFromHeader(req: express.Request): string | undefined {
  const raw = req.headers['x-bruno-scm-token'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value ? value : undefined;
}

/**
 * Relaxes the security headers on the docs response so the OpenCollection docs
 * page can be embedded in the Backstage app's iframe from a different origin.
 *
 * Helmet (root http router) sets `X-Frame-Options: SAMEORIGIN` and a CSP whose
 * default `frame-ancestors 'self'` both forbid cross-origin framing, so we
 * remove the former and replace the CSP with one scoped to this document:
 * it permits the OpenCollection CDN bundle (script/style/font), the WASM eval
 * the bundle needs, and framing by the configured app origin. The route itself
 * is gated by the `user-cookie` auth policy (plugin.ts); Beta hardening would
 * additionally serve it on a dedicated origin.
 */
function applyDocsEmbeddingHeaders(
  res: express.Response,
  config: Config
): void {
  const appBaseUrl = config.getOptionalString('app.baseUrl');
  const frameAncestors = ['\'self\'', appBaseUrl].filter(Boolean).join(' ');
  // POC-scope: the OpenCollection renderer (staging bundle) lazy-loads from
  // several CDNs and embeds arbitrary third-party media, so pinning hosts is
  // impractical. Derived by statically auditing the bundle:
  //   - script  : its own bundle (opencollection->usebruno CDN 301) + Monaco
  //               editor from jsDelivr + blob: module workers  -> https: blob:
  //   - wasm     : QuickJS runtime fetched as a data: URL + eval'd
  //               -> connect-src data: + script-src 'unsafe-eval'
  //   - fonts    : Inter from fonts.googleapis/gstatic          -> https: data:
  //   - media    : HLS/FLV/Mux players (jsDelivr) + blob:        -> media-src
  //   - iframes  : oEmbed players (YouTube/Vimeo/SoundCloud/...) -> frame-src
  // The bundle is a trusted first-party renderer on an isolated origin,
  // embeddable only by the app (frame-ancestors), and the route is gated by
  // the `user-cookie` auth policy. Beta hardening = pin exact hosts.
  res.removeHeader('X-Frame-Options');
  res.setHeader(
    'Content-Security-Policy',
    [
      'default-src \'self\'',
      'script-src \'self\' \'unsafe-inline\' \'unsafe-eval\' https: blob:',
      'style-src \'self\' \'unsafe-inline\' https: data:',
      'font-src \'self\' data: https:',
      'img-src \'self\' data: blob: https:',
      'media-src \'self\' data: blob: https:',
      'connect-src \'self\' https: data: blob:',
      'worker-src \'self\' blob: https:',
      'frame-src \'self\' https:',
      `frame-ancestors ${frameAncestors}`
    ].join('; ')
  );
}
