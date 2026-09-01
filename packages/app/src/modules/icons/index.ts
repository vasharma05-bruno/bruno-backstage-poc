import { createFrontendModule } from '@backstage/frontend-plugin-api';
import { IconBundleBlueprint } from '@backstage/plugin-app-react';
import { BrunoIcon } from '@usebruno/bruno-plugin-poc';

/**
 * Registers the Bruno mark as the app's `kind:bruno` catalog icon.
 *
 * Only nine kind icons ship with the app defaults (api, component, domain,
 * group, location, system, user, resource, template — see
 * `@backstage/plugin-app/dist/.../defaults/icons.esm.js`), so `kind: Bruno`
 * would otherwise fall through to the generic placeholder wherever the platform
 * itself picks the icon: the Inspect-entity dialog's `EntityKindIcon` and the
 * ancestry graph. Every Bruno surface we render ourselves passes `BrunoIcon`
 * directly and does not depend on this registration.
 *
 * The icon is imported from the plugin's package entrypoint rather than a deep
 * path, so this module keeps the same public dependency on the plugin that
 * `App.tsx` already has.
 */
const brunoIconBundle = IconBundleBlueprint.make({
  name: 'bruno',
  params: {
    icons: {
      'kind:bruno': BrunoIcon
    }
  }
});

/**
 * `pluginId: 'app'` because `IconBundleBlueprint` is documented as limited to
 * the app plugin — the extension attaches to the app's icon registry, not to a
 * feature plugin's.
 */
export const iconsModule = createFrontendModule({
  pluginId: 'app',
  extensions: [brunoIconBundle]
});
