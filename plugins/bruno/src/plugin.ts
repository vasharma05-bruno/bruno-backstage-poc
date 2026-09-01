import { createFrontendPlugin } from '@backstage/frontend-plugin-api';
import { brunoApi } from './api/extension';
import {
  brunoCard,
  brunoPage,
  brunoAddCollectionAction,
  brunoEntityHeader,
  brunoDocumentationCard,
  brunoRelatedApisCard,
  brunoEnvironmentsCard,
  brunoApiDocsContent
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
 *  - brunoApi              -> registers brunoApiRef (ApiBlueprint)
 *  - brunoPage             -> the Bruno Collections dashboard at /bruno
 *                             (auto-registered in the sidebar via
 *                             routeRef + title + icon)
 *  - brunoAddCollectionAction
 *                          -> the `Add Bruno Collection` header action and its
 *                             two modals. Plugin-scoped, so it renders on every
 *                             page of this plugin that HAS a header — which is
 *                             /bruno, this plugin's only page
 *
 * On `kind: API` entities:
 *  - brunoCard             -> card listing the Bruno collections related to the
 *                             API, resolved through catalog relations
 *
 * On `kind: Bruno` entities — the collection as a catalog entity:
 *  - brunoEntityHeader     -> replaces the entity header, adding Version,
 *                             Source and the collection's own actions
 *  - brunoDocumentationCard-> Overview card: the collection's documentation
 *  - brunoRelatedApisCard  -> Overview card: the APIs it is `partOf`, + Unlink
 *  - brunoEnvironmentsCard -> Overview card: `spec.environments`
 *  - brunoApiDocsContent   -> the `Bruno API Docs` tab, rendered from the
 *                             OpenCollection document on `spec.definition`
 */
export const brunoPlugin = createFrontendPlugin({
  pluginId: 'bruno',
  extensions: [
    brunoApi,
    brunoCard,
    brunoPage,
    brunoAddCollectionAction,
    brunoEntityHeader,
    brunoDocumentationCard,
    brunoRelatedApisCard,
    brunoEnvironmentsCard,
    brunoApiDocsContent
  ]
});

export default brunoPlugin;
