import type {
  HttpAuthService,
  LoggerService
} from '@backstage/backend-plugin-api';
import { MiddlewareFactory } from '@backstage/backend-defaults/rootHttpRouter';
import type { Entity } from '@backstage/catalog-model';
import type { Config } from '@backstage/config';
import type { CatalogService } from '@backstage/plugin-catalog-node';
import express from 'express';
import Router from 'express-promise-router';
import type { ManifestProbe } from './manifestProbe';
import {
  DEFINITION_BYTES_ANNOTATION,
  DEFINITION_OMITTED_ANNOTATION
} from '../processor/BrunoKindProcessor';
import { generateOcDocsHtml } from './generateOcDocsHtml';

export interface RouterOptions {
  logger: LoggerService;
  config: Config;
  catalog: CatalogService;
  httpAuth: HttpAuthService;
  /** Reads a collection folder from source control, using the SERVER's
   *  integration credentials. Backs the add-collection scan. */
  probe: ManifestProbe;
}

/**
 * Builds the Express router for `/api/bruno/*`.
 *
 *   GET  /health                          -> { status: 'ok' }
 *   GET  /entities/:namespace/:name/docs  -> text/html (docs for a kind:Bruno entity)
 *   POST /collections/probe               -> { found, ... } (does this URL hold a collection?)
 *
 * Deliberately this small. Everything the UI knows about a collection now
 * travels on the `kind: Bruno` entity itself, so the catalog is the read model
 * and this plugin serves only the two things an entity cannot carry: a RENDERED
 * document, which needs an origin whose Content-Security-Policy admits the
 * OpenCollection renderer bundle, and a read of a repository that has not been
 * catalogued yet, which a browser cannot perform.
 */
export async function createRouter(
  options: RouterOptions
): Promise<express.Router> {
  const { logger, config, catalog, httpAuth, probe } = options;

  const router = Router();
  router.use(express.json());

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Does this URL hold a Bruno collection? The scan behind the add-collection
  // dialog's URL field (PRD: "scan the link to find a bruno.json/
  // opencollection.yaml file").
  //
  // It has to happen on the SERVER. `catalogImportApi.analyzeUrl` is the
  // obvious candidate and is the wrong one — it looks for a `catalog-info.yaml`,
  // which is precisely the file that does not exist yet at this point in the
  // flow. And a browser cannot read a private repository: the credentials for
  // these hosts are the backend's `integrations` config, and moving them to the
  // client to avoid one round trip would be indefensible.
  //
  // The three outcomes are deliberately not three status codes. `no-manifest`
  // is a 200 because the read SUCCEEDED — the answer is simply no, and the
  // dialog renders it as a field-level message rather than a failure. Only an
  // unreadable URL is a 4xx.
  //
  // POC scope: any authenticated user may ask the backend to read any URL its
  // integrations can reach, which is both an SSRF surface and a way to confirm
  // the existence of private repositories. Documented, not fixed, along with
  // the rest of the Beta hardening — see docs/execution/BE-P1-plan.md §3.D.
  router.post('/collections/probe', async (req, res) => {
    await httpAuth.credentials(req, { allow: ['user'] });

    const url = (req.body as { url?: unknown })?.url;
    if (typeof url !== 'string' || !url.trim()) {
      res.status(400).json({
        found: false,
        reason: 'unreadable',
        message: 'A collection URL is required.'
      });
      return;
    }

    let snapshot;
    try {
      // The same probe the processor and the provider share, so this scan warms
      // the cache that the ingestion a few seconds later will read from — the
      // tree is fetched once for both. It generates the OpenCollection document
      // as a side effect, which is more work than the question needs; reusing
      // the one seam is worth more than a narrower read that would have to be
      // kept in step with it.
      snapshot = await probe.probe(url);
    } catch (e) {
      const message = String((e as Error)?.message ?? e);
      // Logged at info: an unreachable URL here is a user typing a repository
      // they cannot see, not a fault in the deployment.
      logger.info(`Bruno collection probe failed for ${url}: ${message}`);
      res.status(400).json({ found: false, reason: 'unreadable', message });
      return;
    }

    if (!snapshot) {
      res.json({ found: false, reason: 'no-manifest' });
      return;
    }

    // Only the manifest fields. `snapshot.definition` is the whole generated
    // OpenCollection document — up to `bruno.definition.maxBytes` — and the
    // dialog has no use for it; it belongs on the entity, written by the
    // processor once the collection is actually catalogued.
    res.json({
      found: true,
      format: snapshot.format,
      manifestPath: snapshot.manifestPath,
      ...(snapshot.name && { name: snapshot.name }),
      ...(snapshot.version && { version: snapshot.version }),
      ...(snapshot.description && { description: snapshot.description })
    });
  });

  // The `kind: Bruno` entity's docs, built from the OpenCollection YAML the
  // processor already stored on the entity as `spec.definition` — so no
  // source-control read happens here.
  //
  // Served from the backend rather than assembled in the browser ON PURPOSE:
  // this document has its own origin (the backend's), so the OpenCollection
  // renderer bundle is fetched under the CSP set below rather than under the
  // app's `backend.csp.*`. A `blob:` document minted by the app would inherit
  // the app's CSP, where the CDN is not allowed, and the bundle would be
  // blocked everywhere except under the CSP-less webpack dev server.
  //
  // Auth: the route is gated by the `user-cookie` policy (plugin.ts). The
  // credentials read here is not a second gate; it exists because the catalog
  // call needs a principal to act as, and it is deliberately cookie-tolerant:
  // `allowLimitedAccess` is what lets the iframe's limited-access cookie (the
  // request carries no Authorization header) resolve to the requesting user,
  // and without it the read throws on every framed request. The allow-list is
  // the default pair, NOT narrowed to `['user']`. The catalog is then read AS
  // THAT USER, so this route can never surface a collection the caller could
  // not read from the catalog itself.
  router.get('/entities/:namespace/:name/docs', async (req, res) => {
    // Embedding headers up-front — BEFORE any error branch — so every error
    // page below is framable too: the docs are reached as an iframe `src`, and
    // Helmet's default `X-Frame-Options: SAMEORIGIN` would otherwise leave the
    // user with a cryptic "refused to connect" instead of the message.
    applyDocsEmbeddingHeaders(res, config);
    const credentials = await httpAuth.credentials(req, {
      allow: ['user', 'service'],
      allowLimitedAccess: true
    });
    const { namespace, name } = req.params;
    const entity = await catalog.getEntityByRef(
      { kind: 'Bruno', namespace, name },
      { credentials }
    );
    if (!entity) {
      sendDocsErrorPage(
        res,
        404,
        `No Bruno collection named ${namespace}/${name}.`
      );
      return;
    }
    // Defensive: `getEntityByRef` is asked for `kind: Bruno`, so a foreign kind
    // should be unreachable — but rendering a non-Bruno entity's `spec` through
    // the OpenCollection renderer would fail far less legibly than this does.
    if (entity.kind.toLocaleLowerCase('en-US') !== 'bruno') {
      sendDocsErrorPage(
        res,
        400,
        `${namespace}/${name} is a ${entity.kind} entity, not a Bruno `
        + 'collection, so it has no OpenCollection document.'
      );
      return;
    }
    const yaml = (entity.spec as { definition?: unknown } | undefined)
      ?.definition;
    if (typeof yaml !== 'string' || !yaml) {
      sendDocsErrorPage(res, 404, missingDefinitionMessage(entity));
      return;
    }
    const theme = req.query.theme === 'dark' ? 'dark' : 'light';
    const title = entity.metadata.title ?? entity.metadata.name;
    res.type('text/html').send(generateOcDocsHtml(yaml, title, theme));
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
 * Sends a framable HTML error page from the docs route.
 *
 * The docs are reached as an iframe `src`, so an error has to be a DOCUMENT the
 * frame can render. A JSON body (what the error middleware would produce) shows
 * up as raw text or an empty frame, and tells the reader nothing.
 */
function sendDocsErrorPage(
  res: express.Response,
  status: number,
  message: string
): void {
  res
    .status(status)
    .type('text/html')
    .send(
      `<!DOCTYPE html><html><body><h1>${status}</h1><p>${escapeHtml(
        message
      )}</p></body></html>`
    );
}

/**
 * Explains why a Bruno entity carries no `spec.definition`.
 *
 * Three genuinely different states, and the reader can only act on the right
 * one. `BrunoKindProcessor` stamps `usebruno.com/definition-omitted` when it HAD a
 * document and dropped it — `size` (over `bruno.definition.maxBytes`, with the
 * would-be size in `usebruno.com/definition-bytes`) or `error` (the collection
 * could not be read/converted). No annotation at all means the entity simply
 * has not been processed yet, which resolves itself on the next cycle.
 */
function missingDefinitionMessage(entity: Entity): string {
  const annotations = entity.metadata.annotations ?? {};
  const omitted = annotations[DEFINITION_OMITTED_ANNOTATION];
  const bytes = annotations[DEFINITION_BYTES_ANNOTATION];
  if (omitted === 'size') {
    return (
      'This collection\'s OpenCollection document'
      + (bytes ? ` (${bytes} bytes)` : '')
      + ' exceeds the configured bruno.definition.maxBytes, so it was not '
      + 'stored on the entity and cannot be rendered. Raise that limit in your '
      + 'Backstage configuration.'
    );
  }
  if (omitted === 'error') {
    return (
      'The OpenCollection document for this collection could not be generated. '
      + 'Check the entity\'s processing errors for why the collection could not '
      + 'be read.'
    );
  }
  if (omitted) {
    return `No OpenCollection document is stored on this entity (${omitted}).`;
  }
  return (
    'No API documentation has been generated for this collection yet. It is '
    + 'written to the entity the first time Backstage reads the collection from '
    + 'source control — check back in a minute.'
  );
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
