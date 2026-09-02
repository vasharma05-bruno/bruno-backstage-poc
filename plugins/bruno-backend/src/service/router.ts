import type {
  HttpAuthService,
  LoggerService
} from '@backstage/backend-plugin-api';
import { MiddlewareFactory } from '@backstage/backend-defaults/rootHttpRouter';
import type { Entity } from '@backstage/catalog-model';
import type { Config } from '@backstage/config';
import { ConflictError, InputError, NotFoundError } from '@backstage/errors';
import type { CatalogService } from '@backstage/plugin-catalog-node';
import express from 'express';
import Router from 'express-promise-router';
import type { ManifestProbe } from './manifestProbe';
import {
  DEFINITION_BYTES_ANNOTATION,
  DEFINITION_OMITTED_ANNOTATION
} from '../processor/BrunoKindProcessor';
import { collectionNameFromUrl } from '../provider/BrunoCollectionEntityProvider';
import { readBrunoCollections } from './brunoConfig';
import { normaliseApiRef, normaliseCollectionRef } from './entityRefs';
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

export interface RouterOptions {
  logger: LoggerService;
  config: Config;
  catalog: CatalogService;
  httpAuth: HttpAuthService;
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
  /** `bruno.schedule.frequencySeconds` — the provider's tick, and therefore how
   *  long a created collection takes to appear and a deleted one to vanish.
   *  Returned on the create and delete responses so the UI can quote the real
   *  number instead of hardcoding the default. */
  refreshSeconds: number;
}

/**
 * Builds the Express router for `/api/bruno/*`.
 *
 *   GET    /health                          -> { status: 'ok' }
 *   GET    /entities/:namespace/:name/docs  -> text/html (docs for a kind:Bruno entity)
 *   POST   /collections/probe               -> { found, ... } (does this URL hold a collection?)
 *   POST   /collections                     -> 201 (add a collection; auth: user)
 *   GET    /collections                     -> { collections, refreshSeconds }
 *                                              (auth: user | service; a user's
 *                                              rows omit `createdBy`)
 *   DELETE /collections/:name               -> { deleted: true } (auth: user)
 *   GET    /links                           -> { links } (auth: service)
 *   POST   /links                           -> 201 (link at runtime; auth: user)
 *                                              takes `apiRefs[]`, all or none
 *   DELETE /links?collection=&api=          -> { unlinked: true } (auth: user)
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
    probe,
    uiCollections,
    runtimeLinks,
    refreshSeconds
  } = options;

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
  // the rest of the Beta hardening — see docs/execution/UI-P6-plan.md
  // §"Standing constraints".
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
  // POC scope, matching the posture on the probe route above: any authenticated
  // user may ask the backend to read any URL its integrations can reach (an
  // SSRF surface and a private-repository existence oracle), and any
  // authenticated user may add a collection that everyone else then sees.
  // Documented, not fixed — see docs/execution/UI-P6-plan.md
  // §"Standing constraints".
  router.post('/collections', async (req, res) => {
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    const createdBy = credentials.principal.userEntityRef;

    const body = (req.body ?? {}) as {
      url?: unknown;
      name?: unknown;
      owner?: unknown;
      partOf?: unknown;
    };

    const rawUrl = body.url;
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
      throw new InputError('A collection URL is required.');
    }
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
    const owner
      = typeof body.owner === 'string' && body.owner ? body.owner : undefined;
    const partOf
      = Array.isArray(body.partOf)
        && body.partOf.every((v) => typeof v === 'string')
        ? (body.partOf as string[])
        : [];

    // Stored NORMALIZED, so the provider's `claimed` key and the entity's
    // `url:` location annotation are the same string a `bruno.collections[]`
    // entry would have produced. The provider normalizes again on every tick;
    // `normalize` is idempotent, so the two paths converge on one identity.
    let normalized: string;
    try {
      normalized = probe.normalize(rawUrl);
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
      snapshot = await probe.probe(rawUrl);
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
      url: normalized,
      owner,
      partOf,
      createdBy
    });

    res.status(201).json({
      name,
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
  // A missing row is a 404 with an explanation rather than an idempotent
  // success, because the interesting case is not "already deleted" — it is a
  // collection that came from `app-config.yaml` or from a `catalog-info.yaml`
  // and cannot be removed from here at all. Silently succeeding would leave the
  // user watching a row that never goes away.
  //
  // POC scope (IDOR): any authenticated user may delete any UI-created
  // collection. `created_by` is recorded and NOT enforced. Beta hardening is a
  // permission plus an ownership check against that column.
  router.delete('/collections/:name', async (req, res) => {
    await httpAuth.credentials(req, { allow: ['user'] });
    const { name } = req.params;
    const removed = await uiCollections.delete(name);
    if (!removed) {
      throw new NotFoundError(
        `No collection named "${name}" was added from the Bruno UI. `
        + 'Collections defined in app-config.yaml, or by a catalog-info.yaml in '
        + 'source control, are removed by editing that file.'
      );
    }

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
  // POC scope, matching the rest of this router: any authenticated user may
  // link any collection to any API entity they can read, and any authenticated
  // user may then remove that link. Documented, not fixed — see
  // docs/execution/UI-P6-plan.md §"Standing constraints".
  router.post('/links', async (req, res) => {
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
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
  // The two refs travel as QUERY parameters rather than path segments. They are
  // entity refs, which contain `:` and `/`; percent-encoding those into a path
  // works but is the kind of thing a proxy in front of the backend decodes
  // early and then routes wrong. A DELETE with a body is the other option and
  // is worse — bodies on DELETE are widely dropped in transit.
  router.delete('/links', async (req, res) => {
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    const collectionRef = readCollectionRef(req.query.collection);
    const apiRef = readApiRef(req.query.api);

    const removed = await runtimeLinks.delete(collectionRef, apiRef);
    if (!removed) {
      throw new NotFoundError(
        `${apiRef} is not linked to ${collectionRef} in this Backstage `
        + 'instance. A link declared by `spec.partOf` in the collection\'s '
        + 'descriptor, or by `partOf` on its app-config entry, is removed by '
        + 'editing that file.'
      );
    }
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
 */
function readApiRefs(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new InputError('At least one API entity reference is required.');
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
