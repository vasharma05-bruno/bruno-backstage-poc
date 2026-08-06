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
import type { ConnectionStore } from '../store/connectionStore';
import { generateCollectionHtml } from './generateCollectionHtml';

export interface RouterOptions {
  logger: LoggerService;
  config: Config;
  collectionService: CollectionService;
  connectionStore: ConnectionStore;
  httpAuth: HttpAuthService;
  userInfo: UserInfoService;
}

/**
 * Builds the Express router implementing the shared API contract
 * (docs/POC-DECISIONS.md §3).
 *
 *   GET /health                 -> { status: 'ok' }
 *   GET /collections            -> Array<CollectionSummary>
 *   GET /collections/:id        -> CollectionDetail (404 if unknown)
 *   GET /collections/:id/docs   -> text/html (self-contained Scenario-B docs)
 *   GET /dashboard              -> Dashboard (stats + cards + failed sources)
 *   POST /refresh               -> re-reads and re-parses all sources
 */
export async function createRouter(
  options: RouterOptions
): Promise<express.Router> {
  const { logger, config, collectionService, connectionStore, httpAuth, userInfo } =
    options;

  const router = Router();
  router.use(express.json());

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/collections', (_req, res) => {
    res.json(collectionService.listCollections());
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

  router.get('/dashboard', async (req, res) => {
    await httpAuth.credentials(req, { allow: ['user', 'service'] });
    const links = await connectionStore.listAll();
    res.json(collectionService.getDashboard(links));
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
    await connectionStore.delete(req.params.entityRef);
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
