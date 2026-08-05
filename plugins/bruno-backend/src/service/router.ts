import type { LoggerService } from '@backstage/backend-plugin-api';
import { MiddlewareFactory } from '@backstage/backend-defaults/rootHttpRouter';
import type { Config } from '@backstage/config';
import express from 'express';
import Router from 'express-promise-router';
import type { CollectionService } from './collectionService';
import { generateCollectionHtml } from './generateCollectionHtml';

export interface RouterOptions {
  logger: LoggerService;
  config: Config;
  collectionService: CollectionService;
}

/**
 * Builds the Express router implementing the shared API contract
 * (docs/POC-DECISIONS.md §3).
 *
 *   GET /health                 -> { status: 'ok' }
 *   GET /collections            -> Array<CollectionSummary>
 *   GET /collections/:id        -> CollectionDetail (404 if unknown)
 *   GET /collections/:id/docs   -> text/html (self-contained Scenario-B docs)
 *   POST /refresh               -> re-reads and re-parses all sources
 */
export async function createRouter(
  options: RouterOptions
): Promise<express.Router> {
  const { logger, config, collectionService } = options;

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
