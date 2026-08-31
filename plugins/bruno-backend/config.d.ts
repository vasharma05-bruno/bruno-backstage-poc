export interface Config {
  /**
   * Configuration for the Bruno-for-Backstage backend plugin.
   * @visibility backend
   */
  bruno?: {
    /**
     * The Bruno collection sources to load.
     * @visibility backend
     */
    sources?: Array<{
      /**
       * A unique, url-safe id for the collection (used as the collection id
       * and the catalog entity name).
       * @visibility backend
       */
      id: string;
      /**
       * Human-readable display name (falls back to the name in bruno.json).
       * @visibility backend
       */
      name: string;
      /**
       * The source type: read from the local filesystem, or fetch from a URL
       * (e.g. a GitHub, GitLab, or Bitbucket tree/blob URL) via Backstage's
       * UrlReader.
       * @visibility backend
       */
      type: 'local' | 'url';
      /**
       * For `local`: a path to the collection directory (relative to the
       * Backstage working dir / packages/backend / repo root). For `url`: a
       * source-control tree or blob URL (GitHub, GitLab, Bitbucket, …) on a
       * host configured under `integrations`.
       * @visibility backend
       */
      target: string;
    }>;
    /**
     * Bruno collections to materialize as `kind: Bruno` entities, without a
     * catalog-info.yaml. Ingested through the same path as an authored
     * entity: fetch the folder, require a bruno.json or
     * opencollection.yml/.yaml, then enrich name/version/description.
     * @visibility backend
     */
    collections?: Array<{
      /** The source type. Only `url` is supported. @visibility backend */
      type: 'url';
      /**
       * Git URL of the Bruno collection FOLDER (a tree or blob URL on a host
       * configured under `integrations`).
       * @visibility backend
       */
      url: string;
      /**
       * Entity reference(s) to the API entities this collection is part of.
       * A bare string is accepted and treated as a single-element list.
       * @visibility backend
       */
      partOf?: string | string[];
      /**
       * Entity reference to the owner of the collection. Unprefixed values
       * default to a Group, matching the authored `spec.owner`. Without it a
       * config-created collection has no `ownedBy` relation and reads as
       * unowned in the catalog.
       * @visibility backend
       */
      owner?: string;
      /**
       * Optional entity-name override. The default name is derived from the
       * last path segment of `url`; set this when two configured collections
       * would otherwise collide, or to pin a name against a URL change.
       * NOT part of the PRD's config shape — a documented superset.
       * @visibility backend
       */
      name?: string;
    }>;
    /**
     * Optional provider refresh schedule.
     * @visibility backend
     */
    schedule?: {
      /**
       * How often the entity provider re-reads sources, in seconds.
       * @visibility backend
       */
      frequencySeconds?: number;
      /**
       * Per-run timeout, in seconds.
       * @visibility backend
       */
      timeoutSeconds?: number;
    };
  };
}
