import type {
  HttpAuthService,
  LoggerService,
  PermissionsService,
  UserInfoService
} from '@backstage/backend-plugin-api';
import { MiddlewareFactory } from '@backstage/backend-defaults/rootHttpRouter';
import type { Entity } from '@backstage/catalog-model';
import type { Config } from '@backstage/config';
import {
  ConflictError,
  InputError,
  NotAllowedError,
  NotFoundError
} from '@backstage/errors';
import { ScmIntegrations } from '@backstage/integration';
import type { CatalogService } from '@backstage/plugin-catalog-node';
import express from 'express';
import Router from 'express-promise-router';
import type { ManifestProbe } from './manifestProbe';
import { assertOwns, isAllowed, requirePermission } from './authorization';
import {
  brunoCollectionCreatePermission,
  brunoCollectionDeleteAnyPermission,
  brunoCollectionDeletePermission,
  brunoLinkCreatePermission,
  brunoLinkDeleteAnyPermission,
  brunoLinkDeletePermission
} from '../permissions';
import {
  DEFINITION_BYTES_ANNOTATION,
  DEFINITION_OMITTED_ANNOTATION
} from '../processor/BrunoKindProcessor';
import { collectionNameFromUrl } from '../provider/BrunoCollectionEntityProvider';
import { readBrunoCollections } from './brunoConfig';
import type { DocsOptions } from './brunoConfig';
import { normaliseApiRef, normaliseCollectionRef } from './entityRefs';
import {
  assertSourceAllowed,
  createProbeRateLimiter,
  readAllowedSources
} from './sourceAllowlist';
import type { UiCollectionStore } from '../store/uiCollectionStore';
import type { RuntimeLinkStore } from '../store/runtimeLinkStore';
import { escapeHtml, generateOcDocsHtml } from './generateOcDocsHtml';

/**
 * `metadata.name`'s grammar, from `@backstage/catalog-model`'s entity envelope
 * schema: alphanumerics, dashes, underscores and dots, starting and ending
 * alphanumeric, at most 63 characters.
 *
 * Duplicated from `plugins/bruno/src/components/AddCollection/
 * generateCatalogInfo.ts:38-39` rather than imported — the two plugins are
 * separate packages and the frontend already duplicates `BRUNO_API_VERSION`
 * for the same reason. Keep the two in step. A drift here is not silent: the
 * catalog rejects a name this accepts and the entity never appears.
 */
const ENTITY_NAME_PATTERN = /^[a-zA-Z0-9]([-_.a-zA-Z0-9]*[a-zA-Z0-9])?$/;
const MAX_ENTITY_NAME_LENGTH = 63;

/**
 * `metadata.title`'s length cap on a stored collection.
 *
 * The entity envelope bounds `title` not at all, so this is ours: it is
 * `MAX_LABEL_LENGTH` from `manifestProbe.ts`, the length a title FETCHED from a
 * collection manifest is clamped to. The two paths write the same field, and a
 * cap that let an authored title outgrow a fetched one would be arbitrary in
 * the one direction that matters. Mirrored by `MAX_TITLE_LENGTH` in
 * `plugins/bruno/src/components/AddCollection/generateCatalogInfo.ts`, so the
 * dialog reports the limit as a field error instead of a 400.
 */
const MAX_TITLE_LENGTH = 255;

/**
 * Ceiling on the entity refs one request body may carry.
 *
 * `POST /links` and `POST /collections` hand their whole ref list to
 * `catalog.getEntitiesByRefs` in a SINGLE call, so an unbounded array is an
 * unbounded catalog query bought with one authenticated request. Until now the
 * only bound was `express.json`'s byte cap, which is incidental: it limits how
 * much a caller may SEND, not how much work the send asks for, and it moves
 * whenever that cap is retuned.
 *
 * 100 is far above any real body — both lists come from a picker, and the APIs
 * one collection documents are counted in tens — and far below the point where
 * a single refused request costs anything. It is deliberately one number for
 * both routes: they are the same fan-out into the same catalog call.
 */
const MAX_PART_OF = 100;

export interface RouterOptions {
  logger: LoggerService;
  config: Config;
  catalog: CatalogService;
  httpAuth: HttpAuthService;
  /** The adopter's `PermissionPolicy`. Every mutating route asks it before it
   *  reads or writes anything; see `service/authorization.ts`. */
  permissions: PermissionsService;
  /** Resolves a credential's `ownershipEntityRefs`, which is what the two
   *  delete routes compare `created_by` against. */
  userInfo: UserInfoService;
  /** Reads a collection folder from source control, using the SERVER's
   *  integration credentials. Backs the add-collection scan. */
  probe: ManifestProbe;
  /** The write model for collections added from the Bruno dashboard. Read back
   *  service-to-service by `BrunoCollectionEntityProvider`. */
  uiCollections: UiCollectionStore;
  /** The write model for links made in this instance instead of in source
   *  control. Read back service-to-service by `BrunoKindProcessor`, which turns
   *  the rows into the same relations `spec.partOf` produces. */
  runtimeLinks: RuntimeLinkStore;
  /** `bruno.allowRuntimeWrites` — whether this instance may record a
   *  collection or a link in its own database rather than only in source
   *  control. Gates the two POST routes; see `requireRuntimeWrites`. */
  allowRuntimeWrites: boolean;
  /** `bruno.schedule.frequencySeconds` — the provider's tick, and therefore how
   *  long a created collection takes to appear and a deleted one to vanish.
   *  Returned on the create and delete responses so the UI can quote the real
   *  number instead of hardcoding the default. */
  refreshSeconds: number;
  /** `bruno.docs` — where the renderer bundle is fetched from, and what the
   *  docs page's Content-Security-Policy names as an allowed script and style
   *  origin. One value, both jobs; see `readDocsOptions`. */
  docs: DocsOptions;
}

/**
 * Builds the Express router for `/api/bruno/*`.
 *
 *   GET    /health                          -> { status: 'ok' }
 *   GET    /entities/:namespace/:name/docs  -> text/html (docs for a kind:Bruno entity)
 *   POST   /collections/probe               -> { found, ... } (does this URL hold a collection?)
 *   POST   /collections                     -> 201 (add a collection; auth: user;
 *                                              needs `bruno.allowRuntimeWrites`
 *                                              + `bruno.collection.create`)
 *   GET    /collections                     -> { collections, refreshSeconds }
 *                                              (auth: user | service; a user's
 *                                              rows omit `createdBy`)
 *   DELETE /collections/:name               -> { deleted: true } (auth: user;
 *                                              `bruno.collection.delete` + owns
 *                                              the row, unless
 *                                              `bruno.collection.delete.any`)
 *   GET    /links                           -> { links } (auth: service)
 *   POST   /links                           -> 201 (link at runtime; auth: user;
 *                                              needs `bruno.allowRuntimeWrites`
 *                                              + `bruno.link.create`)
 *                                              takes `apiRefs[]`, all or none,
 *                                              at most `MAX_PART_OF` entries
 *   DELETE /links?collection=&api=          -> { unlinked: true } (auth: user;
 *                                              `bruno.link.delete` + owns the
 *                                              row, unless
 *                                              `bruno.link.delete.any`)
 *
 * The first three are read-only and were the whole of this plugin: everything
 * the UI knows about an EXISTING collection travels on the `kind: Bruno` entity
 * itself, so the catalog is the read model and this plugin served only the two
 * things an entity cannot carry — a RENDERED document, which needs an origin
 * whose Content-Security-Policy admits the OpenCollection renderer bundle, and
 * a read of a repository that has not been catalogued yet, which a browser
 * cannot perform.
 *
 * The three `/collections` routes are why this plugin grew a database again.
 * The catalog is a read model with no WRITE model: entities come from a Location (a descriptor
 * that must already exist) or from an EntityProvider, and there is no
 * insert-an-entity API anywhere in Backstage. So the Bruno UI's "add a
 * collection" cannot write to the catalog at all — it writes HERE, and
 * `BrunoCollectionEntityProvider` materialises the stored rows into entities on
 * its next tick, exactly as it already does for `bruno.collections[]`. This
 * plugin is now the authoritative store for UI-created collections; the catalog
 * is downstream of it and always will be.
 *
 * BOTH write models are gated on `bruno.allowRuntimeWrites`, which is off by
 * default: they are the two places where this backend, rather than a reviewed
 * file, becomes the source of truth for something the catalog shows, and that
 * is one decision rather than two. The GET and DELETE routes are not gated —
 * see `requireRuntimeWrites` for why a delete has to outlive the permission
 * that created the row.
 *
 * EVERY MUTATING ROUTE IS PERMISSIONED, and the two deletes additionally check
 * ownership. The order is fixed and is the security property: authorize first,
 * then read the row the decision is about, then write. A route that read the
 * row first would leak its existence to a principal the policy refuses, and one
 * that deleted before checking ownership would be the IDOR this replaces —
 * `created_by` was recorded from the first commit and read by nothing. See
 * `../permissions.ts` for the six permissions and `./authorization.ts` for the
 * ownership comparison.
 *
 * The `/links` three are the same argument applied to RELATIONS. A relation is
 * derived output — recomputed and rewritten on every stitch — so there is no
 * relation to insert or delete either, and the only durable place a link can
 * live is a file (`spec.partOf`) or a row here. The rows are read back by
 * `BrunoKindProcessor`, which stamps them on the collection entity and emits
 * the relations from them on every processing cycle; that is what makes a
 * runtime link survive the rewrite. See `store/runtimeLinkStore.ts`.
 */
export async function createRouter(
  options: RouterOptions
): Promise<express.Router> {
  const {
    logger,
    config,
    catalog,
    httpAuth,
    permissions,
    userInfo,
    probe,
    uiCollections,
    runtimeLinks,
    refreshSeconds,
    allowRuntimeWrites,
    docs
  } = options;

  /**
   * Refuses a write that would make this instance, rather than a file in a
   * repository, the source of truth for what the catalog shows.
   *
   * Applied to the two POST routes and to neither DELETE. The asymmetry is the
   * point: turning the key off cannot retract rows that already exist — the
   * provider keeps materialising stored collections and the processor keeps
   * emitting relations from stored links — so refusing the deletes would strand
   * exactly the state the operator turned the key off to be rid of, with no way
   * out but the database. A delete only ever removes something a create was
   * once permitted to make.
   *
   * `NotAllowedError` is a 403 rather than a 404. The route exists and the
   * caller is authenticated; what is missing is the operator's consent, and the
   * message names the key so an admin reading a browser console knows which one
   * to set. The browser should never see this at all — the same config value is
   * `@visibility frontend`, so the UI hides both flows — which is why this is a
   * backstop for direct API callers rather than the primary gate.
   */
  const requireRuntimeWrites = (what: string): void => {
    if (!allowRuntimeWrites) {
      throw new NotAllowedError(
        `${what} in this Backstage instance is disabled. Set `
        + '`bruno.allowRuntimeWrites: true` in app-config.yaml to allow it, or '
        + 'record this in the collection\'s catalog-info.yaml instead.'
      );
    }
  };

  /**
   * The two-dimensional host-and-path gate in front of every URL that arrives
   * in a REQUEST BODY. Read once here: `bruno.allowedSources` is a security
   * control, so a change to it takes a restart rather than taking effect
   * halfway through a request.
   *
   * Applied to `POST /collections/probe` and `POST /collections` and to nothing
   * else. `bruno.collections[]` and `bruno.discovery[]` are the operator's own
   * URLs and stay ungated — see `sourceAllowlist.ts` for the whole argument.
   */
  const integrations = ScmIntegrations.fromConfig(config);
  const allowedSources = readAllowedSources(config);
  const assertAllowedSource = (url: string): string =>
    assertSourceAllowed({ url, integrations, allowed: allowedSources });
  const probeLimiter = createProbeRateLimiter();

  /**
   * Marks a collection for immediate reprocessing, and says whether it worked.
   *
   * This is what makes a runtime link feel like a link rather than like the
   * add-collection flow's minute-long wait. The rows below are read by
   * `BrunoKindProcessor`, which only runs when the catalog processes the
   * entity — on its own schedule, minutes away — so without this the user
   * clicks Link and nothing visibly happens. `refreshEntity` sets the entity
   * due now, and the relation lands within seconds.
   *
   * Failure is REPORTED, never thrown: the row is already written and the
   * relation will appear on the catalog's own next cycle regardless, so a
   * failed refresh makes the change slow, not wrong. The caller passes the
   * boolean back to the browser so the dialog can say "in a few seconds"
   * or "on the next catalog refresh" and be right either way.
   */
  const requestRefresh = async (
    entityRef: string,
    credentials: Parameters<typeof catalog.refreshEntity>[1]['credentials']
  ): Promise<boolean> => {
    try {
      await catalog.refreshEntity(entityRef, { credentials });
      return true;
    } catch (e) {
      logger.warn(
        `Could not schedule an immediate refresh of ${entityRef} after a `
        + 'runtime link change; the relation will follow on the catalog\'s own '
        + 'next processing cycle.',
        e instanceof Error ? e : new Error(String(e))
      );
      return false;
    }
  };

  const router = Router();
  // Explicit, rather than `express.json()`'s incidental 100 kB default. Every
  // body this router reads is a handful of short strings plus a ref list capped
  // at `MAX_PART_OF`, so 64 kB is roomy; what matters is that the number is a
  // decision rather than whatever a dependency happens to ship.
  router.use(express.json({ limit: '64kb' }));

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
  // The URL is the caller's, so `bruno.allowedSources` decides whether the
  // server will read it at all, and a per-user budget bounds how often. Both
  // run BEFORE the probe: this route is the plugin's only cold-fetch surface
  // reachable from a request body, and a check that fires after the read has
  // already paid for everything it was meant to prevent.
  router.post('/collections/probe', async (req, res) => {
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });

    const url = (req.body as { url?: unknown })?.url;
    if (typeof url !== 'string' || !url.trim()) {
      res.status(400).json({
        found: false,
        reason: 'unreadable',
        message: 'A collection URL is required.'
      });
      return;
    }

    // The gate's two outcomes are answered differently on purpose. A refusal is
    // a 403 carrying the config key, because it is the operator's decision and
    // the dialog has nothing useful to say about it; an unparseable URL keeps
    // this route's existing `{ found: false, reason: 'unreadable' }` 400, which
    // is what the dialog renders as a field-level message.
    let allowedUrl: string;
    try {
      allowedUrl = assertAllowedSource(url);
    } catch (e) {
      const message = String((e as Error)?.message ?? e);
      logger.info('Bruno collection probe failed.', { url, error: message });
      if (e instanceof NotAllowedError) {
        throw e;
      }
      res.status(400).json({ found: false, reason: 'unreadable', message });
      return;
    }

    // Spent only for a URL that passed the gate: a refused URL costs the server
    // nothing, so it must not cost the caller their budget either.
    const retryAfter = probeLimiter.spend(credentials.principal.userEntityRef);
    if (retryAfter !== undefined) {
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({
        found: false,
        reason: 'rate-limited',
        message:
          'Too many collection scans from this account. Try again in '
          + `${retryAfter} seconds.`
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
      snapshot = await probe.probe(allowedUrl);
    } catch (e) {
      const message = String((e as Error)?.message ?? e);
      // Logged at info: an unreachable URL here is a user typing a repository
      // they cannot see, not a fault in the deployment.
      //
      // The URL travels as STRUCTURED metadata rather than interpolated into
      // the message. It is the request body's value verbatim — the probe throws
      // on an unparseable URL before it normalises anything — so it can hold
      // newlines, and interpolating it would let an authenticated caller forge
      // whole log lines. The reader's message goes the same way: it can echo
      // the request it made, and that request can carry a token.
      logger.info('Bruno collection probe failed.', { url, error: message });
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

  // The three routes below are registered AFTER `POST /collections/probe` on
  // purpose. `probe` is the only literal path segment under `/collections`, and
  // keeping it earlier in the router's stack means it still wins if anyone
  // later adds a `POST /collections/:name`. As things stand Express cannot
  // confuse them anyway — the parameterised route is a DELETE — and a
  // `DELETE /collections/probe` binds `:name='probe'` and 404s honestly.

  // Adds a collection to the catalog from the Bruno dashboard.
  //
  // The row this writes is the only record of the collection; the entity is
  // produced from it by `BrunoCollectionEntityProvider` within
  // `bruno.schedule.frequencySeconds`. That is why the response carries
  // `refreshSeconds`: the dialog has to tell the user how long "shortly" is,
  // and the honest answer is instance-specific.
  //
  // Auth is `['user']` and deliberately excludes services. This is a
  // user-initiated write whose `created_by` column is read straight off the
  // principal; there is no service caller, because the provider only ever
  // READS. Admitting `['service']` would let any backend plugin holding a
  // plugin token mint catalog-visible entities with no user attribution, and
  // `created_by` would have to become a spoofable body field to carry anything
  // at all.
  //
  // The URL is gated by `bruno.allowedSources` exactly as on the probe route,
  // and for the same reason plus one more: this route is the one that would let
  // a caller who cannot reach `/collections/probe` reach the same read through
  // the create instead, so the guard has to sit on both or on neither.
  //
  // `bruno.collection.create` is asked BEFORE the allow-list, the name checks
  // and the probe, so a principal the policy refuses cannot use this route to
  // ask the server to read anything.
  router.post('/collections', async (req, res) => {
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    requireRuntimeWrites('Adding a collection');
    await requirePermission({
      permissions,
      permission: brunoCollectionCreatePermission,
      credentials
    });
    const createdBy = credentials.principal.userEntityRef;

    const body = (req.body ?? {}) as {
      url?: unknown;
      name?: unknown;
      title?: unknown;
      owner?: unknown;
      partOf?: unknown;
    };

    const rawUrl = body.url;
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
      throw new InputError('A collection URL is required.');
    }
    // Before the name checks and before the catalog fan-out, not just before
    // the read: a URL this instance will not accept should cost nothing at all.
    const allowedUrl = assertAllowedSource(rawUrl);
    const name = body.name;
    if (typeof name !== 'string' || !name.trim()) {
      throw new InputError('An entity name is required.');
    }
    if (name.length > MAX_ENTITY_NAME_LENGTH || !ENTITY_NAME_PATTERN.test(name)) {
      throw new InputError(
        `"${name}" is not a valid entity name. Use up to `
        + `${MAX_ENTITY_NAME_LENGTH} letters, digits, dashes, underscores and `
        + 'dots, starting and ending with a letter or digit.'
      );
    }
    // Trimmed, and a blank one is UNDEFINED rather than an error: the dialog
    // lets the title field be cleared, and clearing it is how a creator says
    // "take the display name from the collection manifest" — the row keeps a
    // NULL and `BrunoKindProcessor` derives the title on every cycle. Length is
    // capped for the same reason `manifestProbe` clamps a fetched label: this
    // value ends up in `metadata.title` on a catalog entity, and a fetched one
    // could never be longer than this.
    const rawTitle = typeof body.title === 'string' ? body.title.trim() : '';
    if (rawTitle.length > MAX_TITLE_LENGTH) {
      throw new InputError(
        `A title is at most ${MAX_TITLE_LENGTH} characters.`
      );
    }
    const title = rawTitle || undefined;
    const owner
      = typeof body.owner === 'string' && body.owner ? body.owner : undefined;
    // Normalised and CHECKED, exactly as `POST /links` does it. These land
    // verbatim in the emitted entity's `spec.partOf`, where an unparseable
    // entry is not an error the user ever sees: `BrunoKindProcessor` logs a
    // warning and skips it on every cycle, so the collection appears with a
    // relation silently missing. Normalising here also makes a row's refs the
    // same strings a descriptor's would be, which is what lets `POST /links`
    // recognise a link this flow already declared.
    const partOf = readOptionalApiRefs(body.partOf);

    // Stored NORMALIZED, so the provider's `claimed` key and the entity's
    // `url:` location annotation are the same string a `bruno.collections[]`
    // entry would have produced. The provider normalizes again on every tick;
    // `normalize` is idempotent, so the two paths converge on one identity.
    let normalized: string;
    try {
      normalized = probe.normalize(allowedUrl);
    } catch (e) {
      throw new InputError(
        `Backstage could not use this URL: ${String((e as Error)?.message ?? e)}`
      );
    }

    // Manifest validation is REQUIRED here, where the equivalent check on the
    // provider is deliberately lenient. A collection that cannot be read is
    // emitted anyway on a refresh (a transient outage must not delete an
    // existing entity), but a folder that has never held a manifest must not
    // become a row: it would be skipped on every tick forever and the user
    // would be left waiting for an entity that is never coming.
    //
    // Reuses the router's own probe instance rather than the module's — the two
    // are separate by design (see plugin.ts) — so this read warms the cache the
    // ingest a few seconds later reads from.
    let snapshot;
    try {
      snapshot = await probe.probe(allowedUrl);
    } catch (e) {
      throw new InputError(
        `Backstage could not read this URL: ${String((e as Error)?.message ?? e)}`
      );
    }
    if (!snapshot) {
      throw new InputError(
        `No bruno.json or opencollection.yml/.yaml found at ${normalized}. `
        + 'Point at the folder that holds the collection.'
      );
    }

    // One call for the whole selection, and a NotFoundError naming what is
    // missing — the same treatment `POST /links` gives its refs, for the same
    // reason: a ref that names nothing produces a relation pointing at nothing,
    // and the user picked these from a list a moment ago, so a miss means the
    // entity went away rather than that they typed it wrong.
    if (partOf.length > 0) {
      const apis = await catalog.getEntitiesByRefs(
        { entityRefs: partOf },
        { credentials }
      );
      const unknownRefs = partOf.filter((_ref, index) => !apis.items[index]);
      if (unknownRefs.length > 0) {
        throw new NotFoundError(
          `${describeRefs(unknownRefs)} ${
            unknownRefs.length === 1 ? 'does' : 'do'
          } not exist in the catalog, so ${
            unknownRefs.length === 1 ? 'it' : 'they'
          } cannot be listed in this collection's \`partOf\`.`
        );
      }
    }

    // Two duplicate-name checks with one meaning. The first is another UI
    // collection; the second is a `bruno.collections[]` entry, and without it
    // the create SUCCEEDS and the entity then never appears — the provider's
    // first-wins `claimed` guard skips the UI entry silently, because config
    // entries are iterated first on purpose.
    const existing = await uiCollections.getByName(name);
    if (existing) {
      throw new ConflictError(
        `A collection named "${name}" has already been added from the Bruno UI `
        + `(${existing.url}). Pick a different name.`
      );
    }
    for (const entry of readBrunoCollections(config, logger)) {
      let configName: string;
      try {
        configName = entry.name ?? collectionNameFromUrl(probe.normalize(entry.url));
      } catch {
        // An unusable URL in config is the provider's problem to log, not a
        // reason to fail this request; it can never claim a name either.
        continue;
      }
      // Lower-cased on BOTH sides, for the reason spelled out on
      // `UiCollectionStore.getByName`: an entity ref is lower-cased when it is
      // stringified, so a config entry named `Payments` and a UI collection
      // named `payments` are a collision, not two names. Comparing raw strings
      // lets this create through, and the provider then skips it on every tick
      // forever.
      if (
        configName.toLocaleLowerCase('en-US')
        === name.toLocaleLowerCase('en-US')
      ) {
        throw new ConflictError(
          `A collection named "${name}" is already defined in app-config.yaml `
          + `(${entry.url}), and a configured collection always wins. Pick a `
          + 'different name.'
        );
      }
    }

    await uiCollections.insert({
      name,
      title,
      url: normalized,
      owner,
      partOf,
      createdBy
    });

    // `title` is echoed so the caller can show what was STORED rather than what
    // it sent — trimmed, and absent when it was blank — which is the same
    // reason the normalized `url` comes back.
    res.status(201).json({
      name,
      ...(title && { title }),
      namespace: 'default',
      entityRef: `bruno:default/${name}`,
      url: normalized,
      refreshSeconds
    });
  });

  // Every UI-created collection, for `BrunoCollectionEntityProvider` and for
  // the dashboard's pending-collections strip.
  //
  // `['service']` is REQUIRED and was the original point of the route: the
  // provider calls it with a plugin token minted by `auth.getPluginRequestToken`,
  // whose principal type is `service`. Without `'service'` in the allow-list
  // every provider tick is a 403 and no UI-created collection ever reaches the
  // catalog.
  //
  // `'user'` was withheld until there was a user-facing consumer, and now there
  // is one. A collection is stored the instant `POST /collections` returns but
  // is not an entity until the provider's next tick, so the dashboard's list is
  // unchanged for up to `bruno.schedule.frequencySeconds` after a create — and
  // a user who closed modal 2 (which is a safe exit, by design) lands on a page
  // that says nothing at all about the collection they just added. The strip
  // compares this list against the catalog and names what has not landed yet;
  // it cannot be built from the catalog, because the whole subject is what the
  // catalog does not have.
  //
  // The reason `'user'` was withheld is honoured rather than dropped: the rows
  // carry `created_by`, a user entity ref, for every UI collection in the
  // INSTANCE, and none of that is the requesting user's business. So a user
  // principal gets rows with `createdBy` omitted. That omission is what makes
  // the widening safe — the remaining fields (name, url, partOf, owner) are all
  // about to be public on a catalog entity anyway, a minute from now. Service
  // callers get whole rows: the provider is the store's own reader, and
  // `created_by` is stored for the ownership check the DELETE route's IDOR note
  // describes.
  //
  // The rows are wrapped in an OBJECT alongside `refreshSeconds` rather than
  // returned as a bare array, matching what the create and delete responses
  // already carry. The dashboard's strip has to decide when a row has been
  // pending for LONGER than it ever should be — a collection whose name a
  // `bruno.collections[]` entry took is never going to land, and telling that
  // user to keep waiting is a lie the strip cannot detect any other way — and
  // the only honest threshold is a multiple of the provider's real tick. A
  // browser has no config read of its own, so the figure has to travel with the
  // list; a hardcoded 60 would be wrong on every instance that tuned the
  // schedule.
  router.get('/collections', async (req, res) => {
    const credentials = await httpAuth.credentials(req, {
      allow: ['user', 'service']
    });
    const rows = await uiCollections.listAll();
    if (credentials.principal.type === 'user') {
      res.json({
        collections: rows.map(({ createdBy: _createdBy, ...row }) => row),
        refreshSeconds
      });
      return;
    }
    res.json({ collections: rows, refreshSeconds });
  });

  // Removes a UI-created collection. The entity disappears from the catalog on
  // the provider's next tick, when the `full` mutation no longer names it.
  //
  // NOT gated on `bruno.allowRuntimeWrites`, unlike the create above. Turning
  // that key off leaves every row already stored still being materialised into
  // an entity every tick, so this is the only way to retract one — refusing it
  // would strand the exact state the operator turned the key off to be rid of.
  // See `requireRuntimeWrites`.
  //
  // A missing row is a 404 with an explanation rather than an idempotent
  // success, because the interesting case is not "already deleted" — it is a
  // collection that came from `app-config.yaml` or from a `catalog-info.yaml`
  // and cannot be removed from here at all. Silently succeeding would leave the
  // user watching a row that never goes away.
  //
  // Three gates in a fixed order, and the order is the whole point. The policy
  // decides whether this principal may delete collections AT ALL; only then is
  // the row read, so a refused principal learns nothing about which names
  // exist; and only then is ownership decided, against the same row that the
  // delete below removes — `getByName` and `delete` fold case identically, so
  // there is no gap between the row that was authorised and the row that goes.
  //
  // `bruno.collection.delete.any` is the admin escape hatch: ALLOW on it skips
  // the ownership check and nothing else. It is asked only when there is a row
  // to own, because until then there is no decision for it to change.
  router.delete('/collections/:name', async (req, res) => {
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    await requirePermission({
      permissions,
      permission: brunoCollectionDeletePermission,
      credentials
    });
    const { name } = req.params;
    const existing = await uiCollections.getByName(name);
    if (!existing) {
      throw new NotFoundError(
        `No collection named "${name}" was added from the Bruno UI. `
        + 'Collections defined in app-config.yaml, or by a catalog-info.yaml in '
        + 'source control, are removed by editing that file.'
      );
    }
    const mayDeleteAny = await isAllowed({
      permissions,
      permission: brunoCollectionDeleteAnyPermission,
      credentials
    });
    if (!mayDeleteAny) {
      await assertOwns({
        userInfo,
        credentials,
        createdBy: existing.createdBy,
        what: `The collection "${existing.name}"`
      });
    }
    // The 404 above already proved the row is there, so a false here can only
    // be a concurrent delete — which is the same outcome the caller wanted.
    await uiCollections.delete(name);

    // The collection's runtime links go with it. They are keyed by entity ref
    // and the entity is about to stop existing, so leaving them would leave
    // rows nothing can ever read or remove — and a collection re-added under
    // the same name would silently inherit the links of the one it replaced.
    // Deliberately AFTER the delete and deliberately not in a transaction: the
    // row is what the user asked to remove, and failing their delete because a
    // cleanup did not run would be the wrong trade. A leftover here is inert.
    try {
      const droppedLinks = await runtimeLinks.deleteForCollection(
        normaliseCollectionRef(`bruno:default/${name}`)
      );
      if (droppedLinks > 0) {
        logger.info(
          `Removed ${droppedLinks} runtime link(s) along with the UI `
          + `collection "${name}".`
        );
      }
    } catch (error) {
      // Swallowed on purpose. The row the user asked to remove is already gone,
      // so reporting a failure here would describe a delete that did happen as
      // one that did not, and the leftover link rows are inert — they name an
      // entity that is about to stop existing.
      logger.warn(
        `Removed the UI collection "${name}" but could not remove its runtime `
        + 'links; they are inert, and name an entity that no longer exists.',
        error instanceof Error ? error : new Error(String(error))
      );
    }

    res.json({ deleted: true, name, refreshSeconds });
  });

  // Every runtime link in the instance, for `BrunoKindProcessor`.
  //
  // `['service']` ONLY, and for the same reason `GET /collections` was
  // service-only until it grew a user-facing consumer: the processor is the
  // reader this route exists for, and a browser has no use for the list. What a
  // browser needs is which APIs are linked to the collection IT is looking at,
  // and that arrives on the entity itself — the processor stamps
  // `usebruno.com/runtime-part-of` from these rows, so the catalog answers it
  // with no call here. Widening to `'user'` would also disclose `created_by`
  // for every link in the instance, which is the thing `GET /collections`
  // strips.
  router.get('/links', async (req, res) => {
    await httpAuth.credentials(req, { allow: ['service'] });
    res.json({ links: await runtimeLinks.listAll() });
  });

  // Links an API to a Bruno collection in THIS instance, without touching
  // source control.
  //
  // The pull-request flow in the frontend stays the primary one, and this route
  // does not replace it: a `spec.partOf` entry is reviewable, survives a rebuilt
  // database and travels with the repository. What this covers is every case
  // where that flow cannot run at all — a `bruno.collections[]` entry and a
  // discovered collection have no descriptor to edit, a `file:` location is not
  // in an SCM, and automatic pull requests are GitHub-only — plus the user who
  // does not want to wait for a review to see the relation.
  //
  // Auth is `['user']` and excludes services, exactly as `POST /collections`
  // does: `created_by` is read off the principal, and admitting a service token
  // would let any backend plugin mint catalog-visible relations with no user
  // attribution.
  //
  // `bruno.link.create` is asked before the body is even read, so a refused
  // principal costs the catalog nothing. WHICH entities may be linked is still
  // the catalog's decision, not this permission's: both reads below are made as
  // the requesting user, so the route can never link something the caller could
  // not see.
  router.post('/links', async (req, res) => {
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    requireRuntimeWrites('Linking an API to a collection');
    await requirePermission({
      permissions,
      permission: brunoLinkCreatePermission,
      credentials
    });
    const createdBy = credentials.principal.userEntityRef;

    const body = (req.body ?? {}) as {
      collectionRef?: unknown;
      apiRefs?: unknown;
    };
    const collectionRef = readCollectionRef(body.collectionRef);
    const apiRefs = readApiRefs(body.apiRefs);

    // Read AS THE USER, so this route can never link a collection or an API the
    // caller could not see in the catalog themselves.
    const collection = await catalog.getEntityByRef(collectionRef, {
      credentials
    });
    if (!collection) {
      throw new NotFoundError(
        `No entity ${collectionRef} exists in the catalog, so it cannot be `
        + 'linked. A collection has to be registered before it can be linked '
        + 'to an API.'
      );
    }
    if (collection.kind.toLocaleLowerCase('en-US') !== 'bruno') {
      throw new InputError(
        `${collectionRef} is a ${collection.kind} entity, not a Bruno `
        + 'collection. Only a Bruno collection can hold a link to an API.'
      );
    }

    // One call for the whole selection rather than a read each: the refs come
    // straight off a picker, so a user linking six APIs should not cost six
    // round trips to the catalog.
    const apis = await catalog.getEntitiesByRefs(
      { entityRefs: apiRefs },
      { credentials }
    );
    const unknownRefs = apiRefs.filter((_ref, index) => !apis.items[index]);
    if (unknownRefs.length > 0) {
      throw new NotFoundError(
        `${describeRefs(unknownRefs)} ${
          unknownRefs.length === 1 ? 'does' : 'do'
        } not exist in the catalog, so linking would produce a relation `
        + 'pointing at nothing.'
      );
    }

    // Refuse a link source control already declares. The relation is either
    // there or one processing cycle away, so the row would add nothing — and it
    // would then have to be removed separately from the descriptor entry,
    // leaving a user who unlinks by pull request watching a relation that does
    // not go away.
    const declared = declaredPartOf(collection);
    const alreadyDeclared = apiRefs.filter((ref) => declared.includes(ref));
    if (alreadyDeclared.length > 0) {
      throw new ConflictError(
        `${describeRefs(alreadyDeclared)} ${
          alreadyDeclared.length === 1 ? 'is' : 'are'
        } already listed in ${collectionRef}'s \`spec.partOf\`, so the link is `
        + 'declared in source control. There is nothing to add here.'
      );
    }

    // Pre-checked against the table as well, so the message can NAME the ref
    // that is already linked — the unique violation the insert would raise
    // cannot say which pair caused it. The insert still catches its own race.
    const existing = new Set(
      await runtimeLinks.listForCollection(collectionRef)
    );
    const alreadyLinked = apiRefs.filter((ref) => existing.has(ref));
    if (alreadyLinked.length > 0) {
      throw new ConflictError(
        `${describeRefs(alreadyLinked)} ${
          alreadyLinked.length === 1 ? 'is' : 'are'
        } already linked to ${collectionRef} in this Backstage instance.`
      );
    }

    await runtimeLinks.insert(
      apiRefs.map((apiRef) => ({ collectionRef, apiRef, createdBy }))
    );
    const refreshRequested = await requestRefresh(collectionRef, credentials);

    res.status(201).json({
      linked: true,
      collectionRef,
      apiRefs,
      refreshRequested
    });
  });

  // Removes a runtime link. The mirror of `POST /links`, and the only way to
  // remove one — a link this route did not write lives in a file, and the 404
  // below says so rather than reporting a success that changes nothing.
  //
  // Ungated for the same reason `DELETE /collections/:name` is: the processor
  // keeps emitting relations from rows written while `bruno.allowRuntimeWrites`
  // was on, so removing them has to stay possible after it goes off.
  //
  // The two refs travel as QUERY parameters rather than path segments. They are
  // entity refs, which contain `:` and `/`; percent-encoding those into a path
  // works but is the kind of thing a proxy in front of the backend decodes
  // early and then routes wrong. A DELETE with a body is the other option and
  // is worse — bodies on DELETE are widely dropped in transit.
  //
  // Gated in the same three steps as `DELETE /collections/:name`, and for the
  // same reasons: authorize, then read the row so `created_by` can be compared,
  // then delete. `bruno.link.delete.any` skips the ownership step. Note the
  // collection delete above CASCADES to these rows without consulting this
  // permission — the links belong to the collection, and a user who may remove
  // the collection may remove what hangs off it.
  router.delete('/links', async (req, res) => {
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    await requirePermission({
      permissions,
      permission: brunoLinkDeletePermission,
      credentials
    });
    const collectionRef = readCollectionRef(req.query.collection);
    const apiRef = readApiRef(req.query.api);

    const existing = await runtimeLinks.get(collectionRef, apiRef);
    if (!existing) {
      throw new NotFoundError(
        `${apiRef} is not linked to ${collectionRef} in this Backstage `
        + 'instance. A link declared by `spec.partOf` in the collection\'s '
        + 'descriptor, or by `partOf` on its app-config entry, is removed by '
        + 'editing that file.'
      );
    }
    const mayDeleteAny = await isAllowed({
      permissions,
      permission: brunoLinkDeleteAnyPermission,
      credentials
    });
    if (!mayDeleteAny) {
      await assertOwns({
        userInfo,
        credentials,
        createdBy: existing.createdBy,
        what: `The link from ${collectionRef} to ${apiRef}`
      });
    }
    // The 404 above already proved the row is there, so a false here can only
    // be a concurrent delete — the same outcome the caller asked for.
    await runtimeLinks.delete(collectionRef, apiRef);
    const refreshRequested = await requestRefresh(collectionRef, credentials);

    // `apiRefs` even though this route removes exactly one, so both link
    // responses have one shape and a client needs one result type.
    res.json({
      unlinked: true,
      collectionRef,
      apiRefs: [apiRef],
      refreshRequested
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
    applyDocsEmbeddingHeaders(res, config, docs);
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
    res.type('text/html').send(generateOcDocsHtml(yaml, title, theme, docs));
  });

  // Error handling per current Backstage conventions.
  const middleware = MiddlewareFactory.create({ logger, config });
  router.use(middleware.error());

  return router;
}

/**
 * Reads and normalises the refs a runtime link is made of.
 *
 * Three readers rather than one per route, because `POST /links` and
 * `DELETE /links` have to agree on the spelling to the character: the POST
 * writes the rows and the DELETE looks one up by exact match on both columns,
 * so a difference of one normalisation step between them is a link that cannot
 * be removed. They take the refs from different places — a JSON body and a
 * query string — which is why the parameters are typed `unknown`.
 *
 * Unparseable is an `InputError`, not a 500: `spec.partOf` is written by hand
 * and a browser can hand us whatever the user's screen showed, so a bad ref is
 * ordinary input.
 */
function readCollectionRef(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new InputError('A Bruno collection entity reference is required.');
  }
  try {
    return normaliseCollectionRef(raw);
  } catch (e) {
    throw new InputError(
      `"${raw}" is not a usable entity reference: ${
        String((e as Error)?.message ?? e)
      }`
    );
  }
}

function readApiRef(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new InputError('An API entity reference is required.');
  }
  try {
    return normaliseApiRef(raw);
  } catch (e) {
    throw new InputError(
      `"${raw}" is not a usable entity reference: ${
        String((e as Error)?.message ?? e)
      }`
    );
  }
}

/**
 * The API refs of a `POST /links` body: at least one, deduped, normalised.
 *
 * Deduped AFTER normalising, so a body naming the same API twice under two
 * spellings — which is what a hand-edited `spec.partOf` looks like — is one
 * link rather than a unique violation against itself.
 *
 * Counted BEFORE normalising, so the refusal costs one length read rather than
 * a parse of every entry. See {@link MAX_PART_OF}.
 */
function readApiRefs(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new InputError('At least one API entity reference is required.');
  }
  if (raw.length > MAX_PART_OF) {
    throw new InputError(
      `At most ${MAX_PART_OF} API entity references can be linked in one `
      + `request; this one names ${raw.length}.`
    );
  }
  return [...new Set(raw.map(readApiRef))];
}

/**
 * The API refs of a `POST /collections` body: optional, deduped, normalised.
 *
 * The counterpart of {@link readApiRefs}, and separate from it because the two
 * bodies disagree about emptiness. A link with no API is meaningless, so an
 * empty `apiRefs` is an InputError there; a collection that is part of nothing
 * is the ordinary case, so an absent or empty `partOf` is simply no entries.
 *
 * What it does NOT do is tolerate a bad entry. Dropping one would register a
 * collection missing a relation the user asked for and say nothing, and the
 * refs come from a picker, so a value that will not parse means the caller is
 * not the dialog.
 */
function readOptionalApiRefs(raw: unknown): string[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new InputError(
      '`partOf` must be a list of API entity references.'
    );
  }
  if (raw.length > MAX_PART_OF) {
    throw new InputError(
      `A collection can list at most ${MAX_PART_OF} entries in \`partOf\`; `
      + `this one names ${raw.length}.`
    );
  }
  return [...new Set(raw.map(readApiRef))];
}

/** `` `a` ``, `` `a` and `b` `` — refs a sentence can hold. */
function describeRefs(refs: string[]): string {
  const quoted = refs.map((ref) => `\`${ref}\``);
  if (quoted.length <= 1) {
    return quoted[0] ?? '';
  }
  return `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}

/**
 * The API refs a collection's own descriptor declares, normalised.
 *
 * Read off `spec.partOf` rather than off the entity's RELATIONS on purpose. The
 * relations of a collection with a runtime link already include that link — the
 * processor emits both kinds identically, which is the point — so comparing
 * against them would report every runtime link as source-control-declared and
 * refuse to remove it. `spec.partOf` is the file, and the file is what this
 * check is about.
 *
 * An entry the catalog cannot parse is dropped rather than thrown: the
 * processor already logs it and ignores it when emitting relations, so it names
 * no relation, and it is certainly not the ref being looked for.
 */
function declaredPartOf(collection: Entity): string[] {
  const raw = (collection.spec as { partOf?: unknown } | undefined)?.partOf;
  if (!Array.isArray(raw)) {
    return [];
  }
  const refs: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !entry) {
      continue;
    }
    try {
      refs.push(normaliseApiRef(entry));
    } catch {
      continue;
    }
  }
  return refs;
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
  config: Config,
  docs: DocsOptions
): void {
  const appBaseUrl = config.getOptionalString('app.baseUrl');
  const frameAncestors = ['\'self\'', appBaseUrl].filter(Boolean).join(' ');
  // The renderer's own origin, taken from the SAME value the page's <script>
  // and <link> are built from, so a mirror can never be fetchable and
  // CSP-refused at once.
  const bundleOrigin = new URL(docs.cdnBaseUrl).origin;
  // Pinned, not `https:`. The origin list below was produced by downloading
  // the live bundle and extracting every absolute URL it references, so it is
  // an audit rather than a guess — and it has to be re-run against whatever
  // production bundle eventually ships, because a `script-src` that names the
  // wrong hosts fails closed and silently (the renderer simply never boots).
  //
  // Two allowances are NOT tightenable and should not be "cleaned up":
  //   'unsafe-eval'  the bundle ships a QuickJS WASM runtime and calls
  //                  `new Function`. 'wasm-unsafe-eval' would cover the first
  //                  but not the second.
  //   blob:          it builds module workers with `URL.createObjectURL`,
  //                  including a PDF.js CDN-wrapper shim.
  //
  // Two are deliberately loose:
  //   img-src / media-src stay scheme-wide because a collection's own
  //   documentation may reference any image or clip, and pinning those breaks
  //   real content rather than demo data.
  //   frame-src lists the oEmbed players the bundle can mount. If in-portal
  //   video embeds are not a requirement, `frame-src 'none'` drops ten origins
  //   and costs nothing else.
  const jsdelivr = 'https://cdn.jsdelivr.net';
  const cdnjs = 'https://cdnjs.cloudflare.com';
  res.removeHeader('X-Frame-Options');
  res.setHeader(
    'Content-Security-Policy',
    [
      'default-src \'none\'',
      'script-src \'self\' \'unsafe-inline\' \'unsafe-eval\' blob: '
      + `${bundleOrigin} ${jsdelivr} ${cdnjs} https://connect.facebook.net`,
      'worker-src \'self\' blob:',
      `style-src 'self' 'unsafe-inline' ${bundleOrigin} https://fonts.googleapis.com`,
      'font-src \'self\' data: https://fonts.gstatic.com',
      'img-src \'self\' data: blob: https:',
      'media-src \'self\' data: blob: https:',
      'connect-src \'self\' data: blob: '
      + `${bundleOrigin} ${jsdelivr} ${cdnjs} `
      + 'https://noembed.com https://cdn.embed.ly https://api.dmcdn.net',
      'frame-src https://www.youtube.com https://www.youtube-nocookie.com '
      + 'https://player.vimeo.com https://w.soundcloud.com '
      + 'https://player.twitch.tv https://player-widget.mixcloud.com '
      + 'https://fast.wistia.com https://play.vidyard.com '
      + 'https://streamable.com https://videodelivery.net',
      `frame-ancestors ${frameAncestors}`,
      'base-uri \'none\'',
      'form-action \'none\'',
      'object-src \'none\''
    ].join('; ')
  );
}
