import { createFrontendPlugin } from '@backstage/frontend-plugin-api';
import { brunoApi } from './api/extension';
import {
  brunoCard,
  brunoCollectionTreeCard,
  brunoCollectionOverviewCard,
  brunoDocsContent,
  brunoPage,
  brunoDocsPage
} from './extensions';

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
 *  - brunoCard             -> entity card on kind:api + spec.type:bruno-collection
 *  - brunoCollectionOverviewCard -> collection-root README card on kind:api
 *  - brunoCollectionTreeCard -> read-only collection tree card on kind:api
 *  - brunoDocsContent      -> "API Docs" tab at /bruno-docs on the same filter
 *  - brunoPage             -> standalone Bruno page at /bruno (auto-registered
 *                             in the sidebar via routeRef + title + icon)
 *  - brunoDocsPage         -> chrome-less full-screen docs page at /bruno/docs
 *                             (no title/icon, kept out of the sidebar)
 */
export const brunoPlugin = createFrontendPlugin({
  pluginId: 'bruno',
  extensions: [
    brunoApi,
    brunoCard,
    brunoCollectionOverviewCard,
    brunoCollectionTreeCard,
    brunoDocsContent,
    brunoPage,
    brunoDocsPage
  ]
});

export default brunoPlugin;
