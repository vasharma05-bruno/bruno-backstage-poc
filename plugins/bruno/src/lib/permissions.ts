import { createPermission } from '@backstage/plugin-permission-common';
import type { BasicPermission } from '@backstage/plugin-permission-common';
import { usePermission } from '@backstage/plugin-permission-react';

/**
 * The backend's four user-facing permissions, re-declared here.
 *
 * Hand-mirrored rather than imported, exactly as `BRUNO_API_VERSION` and
 * `ENTITY_NAME_PATTERN` already are: this plugin deliberately does not depend on
 * `@usebruno/bruno-backend-plugin-poc`, and importing from it to reach four
 * string constants would pull a backend package — knex, express, the SCM
 * readers — into the browser bundle. **Keep the names in step with
 * `plugins/bruno-backend/src/permissions.ts`.** A drift is not silent for long:
 * the policy stops matching, the affordance disappears, and the backend keeps
 * refusing or keeps allowing whatever it did before.
 *
 * The two `.any` permissions are NOT mirrored. They only ever change whether
 * the backend skips an ownership check, and this app cannot evaluate ownership
 * in the first place — `GET /collections` strips `createdBy` from every row it
 * serves a user principal, on purpose — so a UI that consulted them would be
 * guessing at half of a decision it cannot see the other half of.
 */
const brunoCollectionCreatePermission = createPermission({
  name: 'bruno.collection.create',
  attributes: { action: 'create' }
});

const brunoCollectionDeletePermission = createPermission({
  name: 'bruno.collection.delete',
  attributes: { action: 'delete' }
});

const brunoLinkCreatePermission = createPermission({
  name: 'bruno.link.create',
  attributes: { action: 'create' }
});

const brunoLinkDeletePermission = createPermission({
  name: 'bruno.link.delete',
  attributes: { action: 'delete' }
});

/**
 * Whether to OFFER an action, given the policy's answer about it.
 *
 * This is a courtesy layer and nothing more — the backend is the gate, and it
 * re-asks the same policy on every call — so the failure modes are resolved
 * towards showing the control rather than hiding it. `loading` is the first
 * render of every screen, and hiding then showing an Add button is a worse
 * screen than one that briefly offers an action the backend would refuse;
 * `error` means this app could not reach the permission backend at all, which
 * says nothing about what the user may do. Only a definitive DENY removes the
 * affordance.
 *
 * What it can NEVER anticipate is the ownership half of a delete. The backend
 * refuses a delete of somebody else's row, and the fact that makes that
 * decision is withheld from this app by design, so a Remove offered here can
 * still come back 403 — and the dialogs surface that message rather than
 * pretending it cannot happen.
 *
 * Unlike `useRuntimeWritesEnabled` next door this does NOT guard the API with
 * `useApiHolder`: `permissionApiRef` is registered by `createApp` itself
 * (`@backstage/plugin-app`'s `defaultApis`), not by an optional module, so
 * there is no host that can be missing it — and a hook cannot be called
 * conditionally anyway.
 */
function useOffered(permission: BasicPermission): boolean {
  const { loading, error, allowed } = usePermission({ permission });
  return loading || Boolean(error) || allowed;
}

/** Whether to offer the add-collection flow's "Add collection" ending. */
export function useCanCreateCollection(): boolean {
  return useOffered(brunoCollectionCreatePermission);
}

/** Whether to offer Remove on a stored collection. */
export function useCanDeleteCollection(): boolean {
  return useOffered(brunoCollectionDeletePermission);
}

/** Whether to offer "Link in this Backstage instance" in the link dialogs. */
export function useCanCreateLink(): boolean {
  return useOffered(brunoLinkCreatePermission);
}

/** Whether to offer removal of a runtime link in the unlink dialog. */
export function useCanDeleteLink(): boolean {
  return useOffered(brunoLinkDeletePermission);
}
