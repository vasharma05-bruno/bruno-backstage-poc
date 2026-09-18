export * from './BrunoApi';
export * from './BrunoClient';

/**
 * `./extension` — the `ApiBlueprint` registration — is deliberately NOT
 * re-exported here. It is the only module in this directory that imports
 * `@backstage/frontend-plugin-api`, and half the plugin's components reach this
 * barrel for `brunoApiRef`; re-exporting it put the new frontend system's
 * extension runtime in the import graph of every one of them, including the
 * components `src/legacy.ts` hands to a legacy app. `src/plugin.ts` is the only
 * consumer and imports it directly.
 */
