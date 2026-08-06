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
import { generateCollectionHtml } from './generateCollectionHtml';
import { toOpenCollectionYaml } from './openCollectionExport';

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
 *   GET /collections/:id        -> CollectionDetail (404 if unknown)
 *   GET /collections/:id/docs   -> text/html (self-contained Scenario-B docs)
 *   GET /collections/:id/opencollection.yml -> text/yaml (OpenCollection export)
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

  router.get('/collections', (_req, res) => {
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
      if (!c?.githubUrl || !c?.name) {
        throw new InputError('Each collection needs `githubUrl` and `name`.');
      }
      let collectionId: string;
      try {
        collectionId = collectionIdFromUrl(c.githubUrl);
      } catch {
        throw new InputError(`Invalid githubUrl: ${c.githubUrl}`);
      }
      await collectionsStore.upsert({
        collectionId,
        githubUrl: c.githubUrl,
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
        githubUrl: row.githubUrl,
        importedBy: row.importedBy,
        updatedAt: row.updatedAt
      }))
    );
  });

  router.get('/collections/:id', (req, res) => {
    const detail = collectionService.getCollection(req.params.id);
    if (!detail) {
      res.status(404).json({ error: `Unknown collection: ${req.params.id}` });
      return;
    }
    res.json(detail);
  });

  router.get('/collections/:id/docs', (req, res) => {
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
    const html = generateCollectionHtml(detail.collection);
    res.type('text/html').send(html);
  });

  router.get('/collections/:id/opencollection.yml', (req, res) => {
    const detail = collectionService.getCollection(req.params.id);
    if (!detail) {
      res.status(404).json({ error: `Unknown collection: ${req.params.id}` });
      return;
    }
    res.type('text/yaml').send(toOpenCollectionYaml(detail));
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

    const { entityRef, url, userGithubToken } = req.body ?? {};
    if (!entityRef || !url) {
      throw new InputError('`entityRef` and `url` are required.');
    }

    const { collectionId, detail } = await collectionService.connectFromUrl({
      url,
      userToken: userGithubToken
    });

    await connectionStore.upsert({
      entityRef,
      githubUrl: detail.sourceUrl!,
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

    const { url, userGithubToken } = req.body ?? {};
    if (!url) {
      throw new InputError('`url` is required.');
    }

    res.json(
      await collectionService.discoverCollections({
        url,
        userToken: userGithubToken
      })
    );
  });

  router.get('/connections', async (req, res) => {
    await httpAuth.credentials(req, { allow: ['user', 'service'] });
    const rows = await connectionStore.listAll();
    res.json(
      rows.map(row => ({
        entityRef: row.entityRef,
        collectionId: row.collectionId,
        githubUrl: row.githubUrl,
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
      githubUrl: row.githubUrl,
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
