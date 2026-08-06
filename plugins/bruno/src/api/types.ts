/**
 * Shared API contract between the `bruno` backend plugin and this frontend
 * plugin. Mirrors docs/POC-DECISIONS.md §3.
 *
 * The backend (plugin id `bruno`) exposes:
 *   GET /collections            -> CollectionSummary[]
 *   GET /collections/:id        -> CollectionDetail (includes `collection`)
 *   GET /collections/:id/docs   -> text/html (self-contained Scenario-B HTML)
 */

/** Environment variable within a collection environment. */
export interface EnvVariable {
  name: string;
  value: string;
  enabled: boolean;
}

/** A named set of variables (e.g. "local", "prod"). */
export interface Environment {
  name: string;
  variables: EnvVariable[];
}

/** A header or form field pair. */
export interface KeyValue {
  name: string;
  value: string;
  enabled: boolean;
}

/** Query/path parameter. */
export interface RequestParam {
  name: string;
  value: string;
  type: 'query' | 'path';
  enabled: boolean;
}

export type BodyMode
  = | 'none'
    | 'json'
    | 'text'
    | 'xml'
    | 'formUrlEncoded'
    | 'multipartForm'
    | 'graphql';

export interface RequestBody {
  mode: BodyMode;
  raw?: string;
  form?: KeyValue[];
}

export type AuthMode
  = | 'none'
    | 'inherit'
    | 'basic'
    | 'bearer'
    | 'apikey'
    | 'digest';

export interface RequestAuth {
  mode: AuthMode;
  [k: string]: unknown;
}

export interface Assertion {
  expr: string;
  op: string;
  value: string;
  enabled: boolean;
}

/** A folder grouping other items. */
export interface FolderItem {
  type: 'folder';
  name: string;
  docs?: string;
  items: Item[];
}

/** An executable HTTP / GraphQL request. */
export interface RequestItem {
  type: 'http' | 'graphql';
  name: string;
  seq?: number;
  docs?: string;
  method: string;
  url: string;
  headers: KeyValue[];
  params: RequestParam[];
  body?: RequestBody;
  auth?: RequestAuth;
  script?: { req?: string; res?: string };
  tests?: string;
  assertions?: Assertion[];
}

export type Item = FolderItem | RequestItem;

/** The full normalized collection model returned by the backend. */
export interface NormalizedCollection {
  id: string;
  name: string;
  version?: string;
  environments: Environment[];
  items: Item[];
  /** Collection-root README markdown, if present. */
  readme?: string;
}

/** GET /collections list entry. */
export interface CollectionSummary {
  id: string;
  name: string;
  requestCount: number;
  source: 'local' | 'url';
  sourceUrl?: string;
}

/** GET /collections/:id response. */
export interface CollectionDetail {
  id: string;
  name: string;
  source: 'local' | 'url';
  sourceUrl?: string;
  requestCount: number;
  collection: NormalizedCollection;
}

/** POST /connections response. */
export interface ConnectResult {
  collectionId: string;
  name: string;
  requestCount: number;
}

/** A single candidate collection root from `POST /connections/discover`. */
export interface DiscoveredCollection {
  collectionPath: string;
  name: string;
  requestCount: number;
  collectionId: string;
  githubUrl: string;
}

/** POST /connections/discover response. */
export interface DiscoverResult {
  collections: DiscoveredCollection[];
}

/** GET /connections/:entityRef response. */
export interface ConnectionRecord {
  entityRef: string;
  collectionId: string;
  githubUrl: string;
  connectedBy: string;
  updatedAt: string;
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

/** Type guard: narrow an Item to a request. */
export function isRequestItem(item: Item): item is RequestItem {
  return item.type === 'http' || item.type === 'graphql';
}

/** Type guard: narrow an Item to a folder. */
export function isFolderItem(item: Item): item is FolderItem {
  return item.type === 'folder';
}
