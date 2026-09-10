import { configApiRef, useApiHolder } from '@backstage/core-plugin-api';

/** The config key both plugins gate their instance-local writes on. */
const ALLOW_RUNTIME_WRITES = 'bruno.allowRuntimeWrites';

/**
 * Whether this instance lets a user record a collection or a link in the Bruno
 * backend's database rather than in source control.
 *
 * One hook for both flows because it is one key, and one key because it is one
 * decision — see `readAllowRuntimeWrites` in the backend plugin for the
 * argument. What it gates in the UI is narrow and worth stating: the
 * add-collection dialog's **Add collection** ending, and the link dialogs'
 * **Link in this Backstage instance** method. The pull-request half of both
 * flows never consults it.
 *
 * Read from config rather than fetched from the backend, which is why the key
 * is `@visibility frontend` in `config.d.ts`. A `GET /config` would make every
 * gated component asynchronous — a spinner, then a button appearing — to
 * decide something that is fixed for the lifetime of the app bundle.
 *
 * `useApiHolder` rather than `useApi`, matching the rest of this plugin: a host
 * app that has not registered the config API should lose these two actions,
 * not the card they sit on. Absent config reads as OFF, which is also the
 * schema default — the two must agree, because the backend would refuse the
 * write anyway and a UI that offers it would be offering a 403.
 */
export function useRuntimeWritesEnabled(): boolean {
  const configApi = useApiHolder().get(configApiRef);
  return configApi?.getOptionalBoolean(ALLOW_RUNTIME_WRITES) ?? false;
}
