import { createFrontendPlugin } from '@backstage/frontend-plugin-api';
import { brunoApi } from './api/extension';
import { brunoCard, brunoDocsContent } from './extensions';

/**
 * The Bruno frontend plugin (new frontend system).
 *
 * Signature verified against @backstage/frontend-plugin-api@0.17.3:
 * `createFrontendPlugin({ pluginId, extensions })` (mirrors the api-docs
 * plugin in node_modules/@backstage/plugin-api-docs/dist/alpha.esm.js — the
 * field is `pluginId`, not `id`, and `extensions` is an array).
 *
 * Extensions:
 *  - brunoApi         -> registers brunoApiRef (ApiBlueprint)
 *  - brunoCard        -> entity card on kind:api + spec.type:bruno-collection
 *  - brunoDocsContent -> "API Docs" tab at /bruno-docs on the same filter
 */
export const brunoPlugin = createFrontendPlugin({
  pluginId: 'bruno',
  extensions: [brunoApi, brunoCard, brunoDocsContent]
});

export default brunoPlugin;
