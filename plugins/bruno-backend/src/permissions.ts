/**
 * The permissions this plugin registers, and the one it deliberately does not.
 *
 * Four of them are the ordinary create/delete pairs over this plugin's two
 * write models — the stored collection (`bruno_ui_collections`) and the runtime
 * link (`bruno_runtime_links`). They are BASIC permissions rather than resource
 * permissions: a conditional policy would need a resource type, a rule set and a
 * query the routes could push down, and the only condition anyone has asked for
 * is ownership, which the routes answer in one string comparison against
 * `created_by`. A resource type here would be machinery wrapped around a
 * `includes()`.
 *
 * The other two are the ADMIN ESCAPE HATCH, and they are why this list is six
 * rather than four. `bruno.collection.delete` says "may delete collections they
 * own"; the ownership check underneath it is unconditional, so with only that
 * permission an adopter has no way to express "platform-admins may clean up
 * anything" — a stored collection whose creator has left the company would be
 * removable only from the database. `bruno.collection.delete.any` and
 * `bruno.link.delete.any` are that expression: when the policy returns ALLOW for
 * one, the route skips the ownership check and nothing else changes. They are
 * separate permissions rather than a config key because the decision is
 * per-principal, which is the one thing a config key cannot be.
 *
 * THERE IS NO `bruno.collection.read`, on purpose. Every read path in this
 * plugin resolves through `catalogServiceRef` with the REQUESTING USER's
 * credentials — the docs route, both link routes and the frontend's entity
 * reads all go through the catalog — so the catalog's own `catalog.entity.read`
 * already governs what a caller may see, and a Bruno collection is an ordinary
 * catalog entity. A second gate in front of it would buy nothing and cost two
 * things. An adopter who denies it gets a blank Bruno tab on an entity the
 * catalog is happily showing them, which reads as a bug rather than as a
 * policy; and every conditional catalog policy an adopter writes — ownership
 * filters, lifecycle filters, anything `catalog.entity.read` can carry
 * conditions for — would have to be mirrored here, with nothing in either
 * codebase keeping the two in step. `GET /collections` is the one read this
 * plugin serves from its own store rather than from the catalog, and it already
 * strips `createdBy` for user principals; the remaining fields are about to be
 * public on a catalog entity a minute from now.
 *
 * Registered with `permissionsRegistry.addPermissions` in `plugin.ts`, and
 * re-exported from the package root so an adopter's `PermissionPolicy` can
 * import the same objects the routes authorize against rather than matching on
 * name strings.
 */
import { createPermission } from '@backstage/plugin-permission-common';

/** Add a collection from the Bruno dashboard (`POST /collections`). */
export const brunoCollectionCreatePermission = createPermission({
  name: 'bruno.collection.create',
  attributes: { action: 'create' }
});

/**
 * Delete a stored collection (`DELETE /collections/:name`).
 *
 * Grants deletion of the caller's OWN collections; see
 * {@link brunoCollectionDeleteAnyPermission} for the rest.
 */
export const brunoCollectionDeletePermission = createPermission({
  name: 'bruno.collection.delete',
  attributes: { action: 'delete' }
});

/** Link an API to a collection in this instance (`POST /links`). */
export const brunoLinkCreatePermission = createPermission({
  name: 'bruno.link.create',
  attributes: { action: 'create' }
});

/**
 * Remove a runtime link (`DELETE /links`).
 *
 * Grants removal of links the caller MADE; see
 * {@link brunoLinkDeleteAnyPermission} for the rest.
 */
export const brunoLinkDeletePermission = createPermission({
  name: 'bruno.link.delete',
  attributes: { action: 'delete' }
});

/**
 * Delete ANY stored collection, whoever created it.
 *
 * Checked in addition to {@link brunoCollectionDeletePermission}, never instead
 * of it: a policy that ALLOWs this one and DENYs the other still gets a 403,
 * because the base permission is what says the principal may reach the route at
 * all. Note that a collection delete cascades to that collection's runtime
 * links, so this permission reaches links the holder did not make.
 */
export const brunoCollectionDeleteAnyPermission = createPermission({
  name: 'bruno.collection.delete.any',
  attributes: { action: 'delete' }
});

/** Remove ANY runtime link, whoever made it. The link-side counterpart of
 *  {@link brunoCollectionDeleteAnyPermission}, with the same layering. */
export const brunoLinkDeleteAnyPermission = createPermission({
  name: 'bruno.link.delete.any',
  attributes: { action: 'delete' }
});

/** Every permission this plugin registers, for `addPermissions` and for an
 *  adopter who wants to enumerate them. */
export const brunoPermissions = [
  brunoCollectionCreatePermission,
  brunoCollectionDeletePermission,
  brunoCollectionDeleteAnyPermission,
  brunoLinkCreatePermission,
  brunoLinkDeletePermission,
  brunoLinkDeleteAnyPermission
];
