import { createApiRef } from '@backstage/core-plugin-api';

/**
 * A Bruno manifest was found at the probed URL.
 *
 * `format` is the manifest FLAVOUR, not a file extension: `yml` means an
 * `opencollection.yml`/`.yaml` and `bru` means a `bruno.json` alongside `.bru`
 * files. Mirrors `CollectionManifest` in
 * plugins/bruno-backend/src/service/manifestProbe.ts — keep the two in step.
 *
 * `name`, `version` and `description` are all optional because a manifest is
 * allowed to omit them, and because a malformed one is logged and skipped by the
 * backend's extractor rather than failing the probe.
 */
export interface ProbeFound {
  found: true;
  format: 'bru' | 'yml';
  /** Repo-relative path of the manifest that was found. */
  manifestPath: string;
  name?: string;
  version?: string;
  description?: string;
}

/**
 * The answer to "is there a Bruno collection at this URL?".
 *
 * Three outcomes, not two, and the difference between the last two is the whole
 * reason this is a union rather than a nullable: a repository that read fine but
 * holds no manifest is the user's mistake (wrong URL, or the collection lives in
 * a subfolder), while a repository that could not be read at all is the
 * INSTANCE's problem (no `integrations` entry for the host, a revoked token, a
 * private repo). The first needs "point me at the collection folder"; the second
 * needs the backend's own diagnostic shown verbatim, because only an operator
 * can act on it.
 *
 * Both non-found cases are ordinary results, never exceptions — an unreadable
 * URL is something a user types by accident several times per session.
 */
export type ProbeResult
  = | ProbeFound
    | { found: false; reason: 'no-manifest' }
    | { found: false; reason: 'unreadable'; message: string };

/**
 * What {@link BrunoApi.createCollection} needs to register a collection.
 *
 * The same five fields `BrunoEntityInput` collects for the descriptor, because
 * the two describe the same collection — one as a stored row, one as YAML. They
 * are separate types rather than one shared type because the descriptor's shape
 * is fixed by the catalog's entity envelope and this one is fixed by the
 * backend's route body; letting either drag the other is how a rename in one
 * ends up silently changing the wire format of the other.
 */
export interface CreateCollectionInput {
  /** `metadata.name` of the entity to create. Must be unique in the instance. */
  name: string;
  /**
   * `metadata.title` — the display name for the entity the provider will build.
   *
   * Optional, and absence is a real instruction rather than a missing value: a
   * row with no title produces an entity with no authored `metadata.title`, and
   * `BrunoKindProcessor` then derives it from the collection manifest on every
   * cycle. Sending `''` would author an empty title, so the dialog collapses a
   * blank field to `undefined` before it gets here.
   */
  title?: string;
  /** The collection folder in source control. Normalized by the backend. */
  url: string;
  /** Entity references for `spec.partOf`. */
  partOf: string[];
  /** `spec.owner`, when one was picked. */
  owner?: string;
}

/** What the backend recorded, once a collection has been registered. */
export interface CreatedCollection {
  name: string;
  /**
   * The title the backend STORED — trimmed, and absent when the field was left
   * blank.
   *
   * Declared rather than dropped for the same reason {@link refreshSeconds}
   * below is: it describes the route's 201 body, which does send it. No screen
   * reads it today — the flow closes on a successful create and the collection
   * is next seen as a catalog entity — but a caller that wants to name what it
   * just created should read it here rather than re-trim what it sent.
   */
  title?: string;
  namespace: string;
  /** Ref of the entity that WILL exist, once the provider has run. */
  entityRef: string;
  /**
   * The NORMALIZED collection URL the backend stored, which is not necessarily
   * the string that was submitted.
   */
  url: string;
  /**
   * The provider's refresh interval — how long this collection has to wait
   * before it is an entity. Configurable (`bruno.schedule.frequencySeconds`),
   * and a wrong figure on screen is worse than no figure: a user told "a
   * minute" on a ten-minute schedule concludes the create failed.
   *
   * No add-collection screen reads it any more. The flow closes on a successful
   * create and the wait is reported by the dashboard's pending strip, which
   * reads its own interval off {@link StoredCollections} — the same number, from
   * the response that also carries the rows it is describing. Kept here because
   * it describes the route's 201 body, which still sends it, and because a
   * caller that DOES want to say "about a minute" at create time should read it
   * rather than hardcode one.
   */
  refreshSeconds: number;
}

/**
 * One stored collection, as a browser is allowed to see it.
 *
 * Deliberately NOT the backend's whole row. `GET /collections` answers a user
 * principal with `createdBy` omitted — it is a user entity ref for every UI
 * collection in the instance, and disclosing who added what is not something
 * the dashboard needs to do its job — so the field is absent from this type
 * rather than optional. An optional field invites a caller to render it and get
 * `undefined` forever.
 *
 * Everything that IS here is about to be visible on a catalog entity anyway,
 * within `bruno.schedule.frequencySeconds`. That is the whole point: this list
 * is the same collections the catalog will hold, read a refresh interval early.
 */
export interface StoredCollectionSummary {
  /** `metadata.name` of the entity this row will produce. */
  name: string;
  /**
   * `metadata.title` for that entity, when one was chosen.
   *
   * Genuinely optional, unlike the deliberately-absent `createdBy` above: the
   * add-collection dialog lets the field be cleared, and a row with no title is
   * one whose display name is left to the collection manifest. A caller
   * rendering this has to fall back to {@link name} for that case.
   */
  title?: string;
  /** The normalized collection folder in source control. */
  url: string;
  /** Entity references destined for `spec.partOf`. */
  partOf: string[];
  /** `spec.owner`, when one was picked. */
  owner?: string;
  /** ISO timestamp of when the row was stored. */
  createdAt: string;
}

/**
 * What {@link BrunoApi.listCollections} answers: the stored rows, and the
 * interval that says how long any of them should still be waiting.
 *
 * The rows travel in an envelope rather than as a bare array because the list
 * alone cannot be read honestly. A row that is stored but not yet an entity is
 * normally a few seconds from landing — but it may also be one that never will,
 * because the provider skipped it, and the difference is entirely a matter of
 * how long it has been waiting relative to the provider's tick. That tick is
 * `bruno.schedule.frequencySeconds`, which a browser has no way to read, so it
 * comes back with the rows.
 */
export interface StoredCollections {
  collections: StoredCollectionSummary[];
  /**
   * The provider's refresh interval, as on {@link CreatedCollection}. Here it
   * is what turns `createdAt` into a verdict rather than a timestamp.
   */
  refreshSeconds: number;
}

/** What the backend confirmed, once a collection has been removed. */
export interface DeletedCollection {
  name: string;
  /**
   * The provider's refresh interval again, and the reason this is not a `void`
   * call. Deleting is eventually consistent in exactly the way creating is: the
   * row is gone, the entity is not, and the dashboard still shows the row the
   * user just deleted. The confirmation has to quote how long that lasts, and
   * the response is the only place the real figure is available to a frontend
   * with no config read of its own.
   */
  refreshSeconds: number;
}

/**
 * What {@link BrunoApi.createRuntimeLinks} links, in one call.
 *
 * A runtime link is the alternative to a `spec.partOf` entry: the same
 * `partOf`/`hasPart` relation, recorded in the `bruno` backend's own table
 * instead of in a file. It exists because the pull-request flow cannot always
 * run — a `bruno.collections[]` entry and a discovered collection have no
 * descriptor to edit, a `file:` location is not in an SCM, and automatic pull
 * requests are GitHub-only — and because a user is sometimes not waiting for a
 * review to see a relation.
 *
 * Plural for the same reason `planLink` takes `apiRefs`: the collection-side
 * dialog picks several APIs at once and they all land in the same `partOf`, so
 * one call is one refresh and one all-or-nothing outcome.
 */
export interface RuntimeLinkInput {
  /** Entity ref of the Bruno collection — the `partOf` SOURCE. */
  collectionRef: string;
  /** Entity refs of the API entities the collection is part of. */
  apiRefs: string[];
}

/** The one pair {@link BrunoApi.deleteRuntimeLink} removes. */
export interface RuntimeUnlinkInput {
  collectionRef: string;
  apiRef: string;
}

/** What the backend recorded, once a runtime link has been made or removed. */
export interface RuntimeLinkResult {
  /** The refs as the backend NORMALISED them, which is what its table holds. */
  collectionRef: string;
  /**
   * The API refs the call acted on, normalised. One entry for an unlink, and
   * for a link the whole selection — deduped by the backend, which is why it
   * is read back rather than assumed to be what was sent.
   */
  apiRefs: string[];
  /**
   * Whether the backend managed to mark the collection for immediate
   * reprocessing.
   *
   * The write itself is done either way; this says how long the relation takes
   * to appear or disappear. `true` means seconds — the catalog reprocesses the
   * entity now, `BrunoKindProcessor` re-reads the link table and re-emits the
   * relations. `false` means the refresh call failed, so the change waits for
   * the catalog's own next processing cycle, which is minutes. Reported rather
   * than assumed because a dialog that says "a few seconds" and then sits there
   * for five minutes is worse than one that says which it is.
   */
  refreshRequested: boolean;
}

/**
 * Client for the `bruno` backend plugin.
 *
 * All calls resolve the backend base URL through the discovery API for plugin
 * id `bruno` (i.e. `discoveryApi.getBaseUrl('bruno')`).
 *
 * Deliberately small. Everything the UI needs about a collection that ALREADY
 * EXISTS travels on the `kind: Bruno` entity itself — the catalog is the read
 * model, so listing, filtering, counting and relation-walking all go through
 * `@backstage/plugin-catalog-react` rather than through this client. What is
 * left are the four things no entity can answer:
 *
 *  - a RENDERED document: the docs page has to be served from an origin whose
 *    Content-Security-Policy allows the OpenCollection renderer's bundle, which
 *    rules out assembling the HTML in the browser (see `useEntityDocsSession`);
 *  - a question about a repository that is NOT in the catalog yet, which is
 *    what the add-collection flow asks before it will generate a descriptor;
 *  - bringing a collection INTO existence, and taking one back out;
 *  - and, following from that, which collections have been brought into
 *    existence but are not entities YET — a question the catalog answers "none"
 *    to by construction, because the gap is exactly what it does not know about.
 *
 * The fifth is the same gap one level down: a RELATION cannot be written
 * either. Relations are derived output — recomputed by the processors and
 * rewritten wholesale on every stitch — and `plugin-catalog-backend`'s router
 * exposes no relation-mutation endpoint, so a link written straight into the
 * catalog would be reverted within one processing cycle. The two link calls
 * below write a row that `BrunoKindProcessor` re-derives the relation from on
 * every cycle, which is what makes it last.
 *
 * That third one is here because the catalog is a read model with no write
 * model. There is no "create entity" endpoint anywhere in `catalogApi`:
 * entities come from a Location (a descriptor that must already exist
 * somewhere a reader can fetch) or from an EntityProvider. So a browser cannot
 * create one directly. Instead these two calls write to the `bruno` backend's
 * own store, and `BrunoCollectionEntityProvider` materialises the catalog
 * entity from it on its next tick — which is why both of them are eventually
 * consistent rather than immediate, and why every caller has to say so on
 * screen. The fourth call reads that same store back, which is the only way a
 * screen can say so with the collection's NAME in the sentence rather than as a
 * general disclaimer.
 */
export interface BrunoApi {
  /**
   * Asks the backend whether `url` points at a Bruno collection.
   *
   * Server-side on purpose. The browser cannot do this itself: a private repo
   * needs the host's `integrations.*` credentials, which exist only on the
   * backend, and `catalogImportApi.analyzeUrl` — the obvious-looking
   * alternative — looks for a `catalog-info.yaml`, not for a Bruno manifest, so
   * it answers a different question entirely.
   *
   * Takes no token. The route reuses the server-side `UrlReaderService`, so a
   * user's OAuth token never reaches it and can never be logged there.
   */
  probeCollection(url: string): Promise<ProbeResult>;

  /**
   * Absolute URL of the OpenCollection docs page for a `kind: Bruno` entity,
   * for embedding via an iframe `src`. The backend renders it from the entity's
   * own `spec.definition`; `theme` selects the renderer's light/dark palette.
   */
  getEntityDocsUrl(
    namespace: string,
    name: string,
    theme: 'light' | 'dark'
  ): Promise<string>;

  /**
   * Registers a collection, so that the catalog grows a `kind: Bruno` entity
   * for it on the provider's next refresh.
   *
   * Resolving does NOT mean the entity exists — it means the backend has stored
   * the row that will produce it. The gap is `refreshSeconds` on the returned
   * value, and the caller is responsible for saying so rather than showing a
   * catalog link that 404s. The add-collection flow discharges that by handing
   * the gap to the dashboard's pending strip, which is built on
   * {@link listCollections} for exactly this purpose.
   *
   * REJECTS with the backend's own message for the cases the user can act on,
   * and the duplicate-name one is the important one: the name is permanent, the
   * form is still on screen, and "HTTP 409" tells the user nothing about which
   * field to change. See `BrunoClient.createCollection`.
   */
  createCollection(input: CreateCollectionInput): Promise<CreatedCollection>;

  /**
   * Removes a collection that was registered through {@link createCollection}.
   *
   * Only the stored row is removed. The collection in source control is
   * untouched, and so is any `catalog-info.yaml` committed for it. Like the
   * create, the catalog catches up on the provider's next tick, so the entity
   * is still listed for up to `bruno.schedule.frequencySeconds` afterwards.
   *
   * Rejects with a not-found message when the entity was not created here —
   * a config- or descriptor-origin collection is edited in its own file, and
   * the route says which.
   */
  deleteCollection(name: string): Promise<DeletedCollection>;

  /**
   * Every collection registered through {@link createCollection}, in this
   * instance — including the ones the catalog does not have yet.
   *
   * The one read on this client that is NOT answered by the catalog, and it has
   * to be: a collection exists as a stored row the moment the create returns,
   * and as an entity only after `BrunoCollectionEntityProvider`'s next tick.
   * Between those two moments the catalog's honest answer is "no such thing",
   * which is precisely the state the dashboard has to be able to describe. So
   * this is the WRITE model being read directly, and the caller's job is to
   * subtract what the catalog already has.
   *
   * Not a substitute for the catalog anywhere else. It knows nothing about
   * configured or descriptor-defined collections, carries no processed metadata,
   * and is not filtered by anything the user picked.
   *
   * Answers a {@link StoredCollections} envelope, not a bare array, so the
   * caller can also say WHICH side of the provider's tick each row is on — see
   * that type for why the list is not readable without the interval.
   */
  listCollections(): Promise<StoredCollections>;

  /**
   * Links one or more API entities to a Bruno collection in THIS Backstage
   * instance, without touching source control.
   *
   * The secondary way to link, and the one that always works. A `spec.partOf`
   * entry in the collection's descriptor is better where it is possible —
   * reviewable, and it travels with the repository — which is why the link
   * dialog leads with the pull request and offers this beside it. Where no
   * descriptor can be edited, this is the only way.
   *
   * All of them or none: the backend writes the rows in one statement, so a
   * selection is never half-applied. Resolving means the rows are written, not
   * that the relations exist yet — the backend marks the collection for
   * reprocessing and they follow, within seconds when `refreshRequested` came
   * back `true`. Callers have to say so on screen rather than showing a
   * relation that is not there.
   *
   * REJECTS with the backend's own message for everything the user can act on,
   * and every one of those messages NAMES the references at fault: a collection
   * or API that is not in the catalog, an entity that is not a Bruno
   * collection, a link the descriptor already declares (there would be nothing
   * to add), and one that already exists.
   */
  createRuntimeLinks(input: RuntimeLinkInput): Promise<RuntimeLinkResult>;

  /**
   * Removes one link made by {@link createRuntimeLinks}.
   *
   * Singular where the create is plural, and deliberately: unlinking is a
   * per-row action on both cards, so there is no screen from which several go
   * at once.
   *
   * Only a runtime link. A link declared by `spec.partOf` is not touched and
   * cannot be — the rejection says which file to edit instead, because a
   * "success" that leaves the relation in place would have the user waiting for
   * a change that is never coming. `linkSource` in `lib/brunoEntity.ts` is how
   * a caller tells the two apart before offering either.
   *
   * Eventually consistent in the same way and to the same degree as the create.
   */
  deleteRuntimeLink(input: RuntimeUnlinkInput): Promise<RuntimeLinkResult>;
}

export const brunoApiRef = createApiRef<BrunoApi>({
  id: 'plugin.bruno.service'
});
