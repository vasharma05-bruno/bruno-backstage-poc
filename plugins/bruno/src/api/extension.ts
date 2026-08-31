import { ApiBlueprint } from '@backstage/frontend-plugin-api';
import { discoveryApiRef } from '@backstage/core-plugin-api';
import { brunoApiRef } from './BrunoApi';
import { BrunoClient } from './BrunoClient';

/**
 * Registers the {@link brunoApiRef} implementation ({@link BrunoClient}).
 *
 * Signature verified against @backstage/frontend-plugin-api@0.17.3:
 * `ApiBlueprint`'s `params` is an `ExtensionBlueprintDefineParams`, so the
 * callback form `params: defineParams => defineParams({ api, deps, factory })`
 * is required (mirrors `apiDocsConfigApi` in
 * node_modules/@backstage/plugin-api-docs/dist/alpha.esm.js).
 */
export const brunoApi = ApiBlueprint.make({
  name: 'bruno',
  params: (defineParams) =>
    defineParams({
      api: brunoApiRef,
      deps: {
        discoveryApi: discoveryApiRef
      },
      factory: ({ discoveryApi }) => new BrunoClient({ discoveryApi })
    })
});
