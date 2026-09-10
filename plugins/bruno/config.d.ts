/**
 * The one Bruno config key the BROWSER needs.
 *
 * A separate schema file from `plugins/bruno-backend/config.d.ts`, and
 * deliberately not a copy of it. Config schemas are collected by walking a
 * package's dependencies, and `packages/app` depends on this plugin, not on the
 * backend one — so a key declared only over there is never in the schema the
 * frontend config is filtered against, and `@visibility frontend` on it would
 * do nothing. Everything else under `bruno.` is read by the backend alone and
 * stays declared there.
 *
 * The `bruno` parent is annotated `@visibility backend` to MATCH that file. The
 * two schemas are merged when both are collected, and the merge is by data
 * path: the parent must agree, while a child that declares its own visibility
 * overrides the inherited one. That is what lets exactly this key — a boolean
 * that decides whether two buttons render — cross to the browser while the
 * integration-credential-adjacent keys beside it do not.
 */
export interface Config {
  /**
   * Configuration for the Bruno-for-Backstage plugins.
   * @visibility backend
   */
  bruno?: {
    /**
     * Whether users may add a collection, or link one to an API, in THIS
     * Backstage instance instead of in source control.
     *
     * Off by default. The frontend reads it to decide whether to offer the
     * add-collection dialog's "Add collection" ending and the link dialogs'
     * "Link in this Backstage instance" method; the backend reads the same key
     * to gate `POST /collections` and `POST /links`, so hiding the UI is a
     * courtesy rather than the enforcement.
     *
     * The pull-request half of both flows is unaffected — a collection can
     * always be catalogued by a generated `catalog-info.yaml`, and an API can
     * always be linked by a pull request against one.
     *
     * See `plugins/bruno-backend/config.d.ts` for what it means for the
     * catalog, and for what happens to rows already stored when it is turned
     * back off.
     *
     * @visibility frontend
     */
    allowRuntimeWrites?: boolean;
  };
}
