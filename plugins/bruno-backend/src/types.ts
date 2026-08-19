/**
 * Shared types for the Bruno-for-Backstage backend plugin.
 *
 * `NormalizedCollection` is the exact output shape the frontend consumes
 * (see docs/POC-DECISIONS.md §3). It is our own clean model, parsed directly
 * from `.bru` files via `@usebruno/lang`. We intentionally do NOT conform to
 * `@opencollection/types` (decision D2/D5) — controlling the shape keeps the
 * native viewer and the self-contained Scenario-B HTML generator decoupled
 * from an external contract.
 *
 * These types are exported from the package entrypoint so the frontend plugin
 * may reuse them if desired.
 *
 * @public
 */

/** A name/value pair with an enabled flag (headers, form fields, env vars). */
export interface KeyValue {
  name: string;
  value: string;
  enabled: boolean;
}

/** A request parameter — either a query or a path parameter. */
export interface Param {
  name: string;
  value: string;
  type: 'query' | 'path';
  enabled: boolean;
}

/** Request body. `mode` mirrors Bruno's body modes. */
export interface RequestBody {
  mode:
    | 'none'
    | 'json'
    | 'text'
    | 'xml'
    | 'formUrlEncoded'
    | 'multipartForm'
    | 'graphql';
  /** Present for json/text/xml/graphql (query) modes. */
  raw?: string;
  /** Present for formUrlEncoded/multipartForm modes. */
  form?: KeyValue[];
}

/** Request authentication. Extra mode-specific fields live under `[k]`. */
export interface RequestAuth {
  mode: 'none' | 'inherit' | 'basic' | 'bearer' | 'apikey' | 'digest';
  [k: string]: unknown;
}

/** Pre/post request scripts. */
export interface RequestScript {
  req?: string;
  res?: string;
}

/** A single assertion from an `assert { }` block. */
export interface Assertion {
  /** The left-hand side expression, e.g. `res.status`. */
  expr: string;
  /** The operator, e.g. `eq`, `neq`, `gt`. */
  op: string;
  /** The expected value. */
  value: string;
  enabled: boolean;
}

/** A folder node in the collection tree. */
export interface FolderItem {
  type: 'folder';
  name: string;
  docs?: string;
  items: Item[];
}

/** An HTTP or GraphQL request node. */
export interface RequestItem {
  type: 'http' | 'graphql';
  name: string;
  seq?: number;
  docs?: string;
  method: string;
  url: string;
  headers: KeyValue[];
  params: Param[];
  body?: RequestBody;
  auth?: RequestAuth;
  script?: RequestScript;
  tests?: string;
  assertions?: Assertion[];
}

/** A node in the ordered collection tree. */
export type Item = FolderItem | RequestItem;

/** A Bruno environment and its variables. */
export interface Environment {
  name: string;
  variables: KeyValue[];
}

/** The normalized collection — the exact shape returned to the frontend. */
export interface NormalizedCollection {
  id: string;
  name: string;
  version?: string;
  environments: Environment[];
  /** Ordered by `meta.seq`. */
  items: Item[];
  /** Collection-root README markdown, if present. */
  readme?: string;
}

/** Source configuration for a single collection (`bruno.sources[]`). */
export interface BrunoSourceConfig {
  id: string;
  name: string;
  type: 'local' | 'url';
  target: string;
}

/** A collection as summarized in `GET /collections`. */
export interface CollectionSummary {
  id: string;
  name: string;
  requestCount: number;
  source: 'local' | 'url';
  sourceUrl?: string;
}

/** The full payload returned by `GET /collections/:id`. */
export interface CollectionDetail extends CollectionSummary {
  collection: NormalizedCollection;
}

/** A single candidate collection root found by `POST /connections/discover`. */
export interface DiscoveredCollection {
  /** Root-relative path of the collection within the input tree (`''` = root). */
  collectionPath: string;
  name: string;
  requestCount: number;
  collectionId: string;
  /** Fully-qualified source URL to pass verbatim to `POST /connections`. */
  sourceUrl: string;
}

/** The full payload returned by `POST /connections/discover`. */
export interface DiscoverResult {
  collections: DiscoveredCollection[];
}

/** A collection card in the dashboard aggregate (`GET /dashboard`). */
export interface DashboardCollection {
  id: string;
  name: string;
  requestCount: number;
  envCount: number;
  activeEnv?: string;
  specType?: string;
  linked: boolean;
  entityRef?: string;
  /**
   * True for a collection imported (§5) but not yet materialized/connected —
   * a stub card with a Link action.
   */
  imported?: boolean;
}

/** An imported-but-unlinked collection (GET /collections/imported). */
export interface ImportedCollection {
  collectionId: string;
  name: string;
  sourceUrl: string;
  importedBy: string;
  updatedAt: string;
}

/** A source that failed to load during the last `refresh`. */
export interface SourceFailure {
  id: string;
  target: string;
  error: string;
}

/** Aggregate stat tiles for the dashboard. */
export interface DashboardStats {
  collections: number;
  totalRequests: number;
  linkedEntities: number;
}

/** The full payload returned by `GET /dashboard`. */
export interface Dashboard {
  stats: DashboardStats;
  collections: DashboardCollection[];
  failures: SourceFailure[];
}
