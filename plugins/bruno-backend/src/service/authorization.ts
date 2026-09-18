/**
 * The two halves of a mutating route's gate: "may this principal do this at
 * all", and "is this row theirs".
 *
 * They are separate because they answer to different owners. The first is the
 * ADOPTER's — a `PermissionPolicy` decides it, and this plugin only asks — and
 * the second is this plugin's, decided against the `created_by` column the
 * stores have always written and never read. Keeping them apart is also what
 * makes the `.any` permissions expressible: an admin escape hatch is a policy
 * ALLOW that causes the second check to be SKIPPED, which only reads as one
 * thing if the two are distinct calls in the route.
 *
 * `requirePermission` is modelled on Backstage's own `AuthorizedLocationService`
 * (`@backstage/plugin-catalog-backend/src/service/AuthorizedLocationService.ts`)
 * — one `authorize([...], { credentials })` per decision, DENY throws
 * `NotAllowedError` — rather than on a middleware, because the routes here have
 * to authorize BEFORE they read the row they are about to delete and the
 * ordering is the security property.
 */
import type {
  BackstageCredentials,
  PermissionsService,
  UserInfoService
} from '@backstage/backend-plugin-api';
import { NotAllowedError } from '@backstage/errors';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import type { BasicPermission } from '@backstage/plugin-permission-common';

/**
 * Refuses the request unless the policy ALLOWs `permission`.
 *
 * `NotAllowedError` rather than a `NotFoundError`, which is what the catalog's
 * location service answers for a denied READ: hiding existence is the right
 * answer to "you may not see this" and the wrong one to "you may not do this",
 * and every caller of this is a mutation the user asked for by name. The
 * message is deliberately empty — the policy knows why it refused and this
 * plugin does not, so inventing a reason here would be a guess printed in a
 * browser console.
 */
export async function requirePermission(args: {
  permissions: PermissionsService;
  permission: BasicPermission;
  credentials: BackstageCredentials;
}): Promise<void> {
  const [decision] = await args.permissions.authorize(
    [{ permission: args.permission }],
    { credentials: args.credentials }
  );
  if (decision.result === AuthorizeResult.DENY) {
    throw new NotAllowedError();
  }
}

/**
 * The same question asked for its ANSWER rather than for its refusal.
 *
 * Used only for the two `.any` permissions, where a DENY is not a refusal at
 * all — it means "fall through to the ownership check", which is the ordinary
 * path every non-admin takes.
 */
export async function isAllowed(args: {
  permissions: PermissionsService;
  permission: BasicPermission;
  credentials: BackstageCredentials;
}): Promise<boolean> {
  const [decision] = await args.permissions.authorize(
    [{ permission: args.permission }],
    { credentials: args.credentials }
  );
  return decision.result === AuthorizeResult.ALLOW;
}

/**
 * Refuses unless the caller owns the row.
 *
 * The comparison is DIRECT and deliberately unnormalised, and this is the note
 * that should stop someone "fixing" it. `created_by` is written from
 * `credentials.principal.userEntityRef`, which is the JWT's `sub` claim, which
 * is `stringifyEntityRef(entity)` — lower-cased kind, namespace and name.
 * `ownershipEntityRefs` is built from the same token's `ent` claim, whose first
 * entry is that same string. A `parseEntityRef`/`stringifyEntityRef` round-trip
 * over either side would therefore be a no-op that looks like it is doing
 * something, and the next reader would reasonably conclude the casing needs
 * handling somewhere — it does not, because neither string ever reaches this
 * function un-stringified.
 *
 * GROUP OWNERSHIP IS ASYMMETRIC HERE, and that is the intended behaviour.
 * `ownershipEntityRefs` also carries the caller's GROUP refs, but `created_by`
 * only ever holds a user ref, so `includes()` degrades to "is this ref mine".
 * A user cannot delete a team-mate's collection because they share a group, and
 * they should not be able to: nothing records that the row belongs to the team
 * rather than to the person. Making that work is a second column (an owner ref
 * chosen at create time), not a looser comparison — a looser one would
 * silently grant it on the strength of a claim that is about the CALLER.
 *
 * UNDER THE GUEST AUTH PROVIDER THIS CHECK IS MEANINGLESS. Every guest session
 * resolves to the single ref `user:development/guest`, so every row is owned by
 * everyone. `auth.providers.guest` is enabled in this repository's
 * `app-config.yaml`, so that is the state a default `yarn dev` is in. It is
 * documented rather than coded around: refusing to serve these routes under
 * guest auth would take the whole feature away from the setup the POC is
 * demonstrated in, and no ownership model can distinguish two principals that
 * are genuinely the same principal.
 */
export async function assertOwns(args: {
  userInfo: UserInfoService;
  credentials: BackstageCredentials;
  /** The row's `created_by`. */
  createdBy: string;
  /** Names the thing in the refusal, e.g. `the collection "payments"`. */
  what: string;
}): Promise<void> {
  const { ownershipEntityRefs } = await args.userInfo.getUserInfo(
    args.credentials
  );
  if (!ownershipEntityRefs.includes(args.createdBy)) {
    // The creator is NOT named. `GET /collections` strips `created_by` from
    // every row it serves a user principal precisely so that who added what is
    // not readable by everyone in the instance, and a refusal that quoted the
    // ref back would hand out the same fact one probe at a time.
    throw new NotAllowedError(
      `${args.what} was added by someone else, and only its owner can remove `
      + 'it.'
    );
  }
}
