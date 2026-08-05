/**
 * @usebruno/plugin-bruno — Bruno for Backstage frontend plugin.
 *
 * Default-exports the plugin so the app can do:
 *   import brunoPlugin from '@usebruno/plugin-bruno';
 *   createApp({ features: [..., brunoPlugin] });
 */
export { brunoPlugin, default } from './plugin';

// Public API surface (client + types) for reuse by other plugins.
export { brunoApiRef } from './api/BrunoApi';
export type { BrunoApi } from './api/BrunoApi';
export { BrunoClient } from './api/BrunoClient';
export * from './api/types';
