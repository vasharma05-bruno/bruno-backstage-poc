/**
 * @usebruno/bruno-plugin-poc — Bruno for Backstage frontend plugin.
 *
 * Default-exports the plugin so the app can do:
 *   import brunoPlugin from '@usebruno/bruno-plugin-poc';
 *   createApp({ features: [..., brunoPlugin] });
 */
export { brunoPlugin, default } from './plugin';

/**
 * The Bruno mark, re-exported from the package entrypoint so the app can
 * register it as the `kind:bruno` catalog icon without reaching into the
 * plugin's source tree (`packages/app/src/modules/icons`).
 */
export { BrunoIcon } from './components/BrunoLogo';

/**
 * Public API surface for reuse by other plugins.
 *
 * Down to the client and its ref. The wire types that used to live alongside
 * them (`CollectionSummary`, `Dashboard`, `ConnectionRecord`, the normalized
 * collection model, …) described the runtime connection store, which no longer
 * has a frontend caller — a Bruno collection is a catalog entity now, and
 * `lib/brunoEntity.ts` is the shape the UI reads.
 */
export { brunoApiRef } from './api/BrunoApi';
export type { BrunoApi } from './api/BrunoApi';
export { BrunoClient } from './api/BrunoClient';
