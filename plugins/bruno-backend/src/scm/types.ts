import type { TreeIdentity, TreeIdentityCheck } from './treeIdentity';

/** A flat map of collection-relative file path -> file contents. */
export type ScmFileTree = Map<string, string>;

/** A repo URL decomposed into the parts the collection loader needs. */
export interface ParsedRepoUrl {
  /**
   * The repository's namespace. A GitHub owner, a Bitbucket workspace, or a
   * GitLab group path — which may itself contain slashes for nested subgroups
   * (`group/subgroup`). Callers that feed this to a provider-specific API must
   * therefore encode it, not assume a single segment.
   */
  owner: string;
  repo: string;
  /** The explicit ref from the URL, when the grammar carries one. */
  ref?: string;
  /** Path of the collection root within the repo; `''` = repo root. */
  subpath: string;
}

/**
 * Per-provider URL grammar and ref resolution. One implementation per SCM
 * provider; selected by `ScmIntegration.type` (see `createScmProviderRegistry`).
 *
 * ONE CREDENTIAL, BY DECISION. Every read in this seam authenticates with the
 * host's `integrations.<type>` credential and nothing else. There is no
 * per-user read path and no place to put a caller's OAuth token — not an
 * omission, a choice: a repository the service credential cannot see is simply
 * unreadable here, and the user's own SCM token is used in exactly one place in
 * this codebase, the frontend's pull-request flows (`plugins/bruno/src/lib/
 * unlinkPr.ts` and the three dialogs that call `scmAuthApi.getCredentials`).
 * Those write on the user's behalf and must be attributed to them; reads must
 * not vary by who is looking, because the catalog entity they produce is shared.
 *
 * A `readTreeWithUserToken` member and a `userToken` retry tier on
 * `resolveDefaultBranch` used to exist here. Do not reintroduce either: the
 * probe behind both consumers runs under a catalog processor and a scheduled
 * provider, where no user request exists to take a token from, so the parameter
 * could only ever be filled by a token borrowed from an unrelated request.
 *
 * RETAINED DELIBERATELY, and only partly reached today. `manifestProbe` is the
 * one consumer, and it calls `normalizeUrl`, `assertConfigured` and
 * `checkTreeIdentity` only. These three have no caller on this branch:
 *
 *   composeCollectionUrl    multi-collection discovery — composes the stored
 *                           `spec.url` for each root found inside one repo
 *   repoRootFromUrl         the same discovery path, reducing a collection URL
 *                           back to its repo
 *   resolveDefaultBranch    names a ref when a pasted URL carries none
 *
 * They are not scaffolding written ahead of use — they had callers, in
 * `service/collectionService.ts` and `provider/BrunoEntityProvider.ts`, and the
 * `kind: Bruno` entity rewrite deleted both modules and left these behind. The
 * still-live implementations are on `feat/multi-scm`, which predates that
 * rewrite.
 *
 * Keeping them is a decision, taken because discovery is planned work rather
 * than an abandoned idea. So do not "clean these up" on the strength of a caller
 * count; the count is expected to be zero until that work is rebased onto the
 * current architecture.
 */
export interface ScmProvider {
  /** The `ScmIntegration.type` this adapter serves, e.g. `'github'`. */
  readonly type: string;

  /** Human-readable provider name, for error messages and UI copy. */
  readonly label: string;

  /**
   * Reduces a URL to the stable identity string that keys the collection cache
   * and seeds the collection id. Must be idempotent.
   */
  normalizeUrl(url: string): string;

  parseRepoUrl(url: string): ParsedRepoUrl;

  /**
   * Rebuilds a fully-qualified collection URL for a root discovered within
   * `normalizedRepoUrl`. `ref` is required: the composed URL is the collection's
   * stored identity, so it must name a concrete ref.
   */
  composeCollectionUrl(
    normalizedRepoUrl: string,
    rootPrefixWithinInput: string,
    ref: string
  ): string;

  /** Reduces a collection URL to its repo-root URL. Must never throw. */
  repoRootFromUrl(url: string): string;

  /**
   * Throws when this host is not usable — i.e. it has no `integrations.<type>`
   * entry, so the UrlReader would fall through to `FetchUrlReader` and fail on
   * anything non-public with an error naming neither the cause nor the fix.
   * Called before the first read of a URL.
   *
   * Verified against @backstage/integration@2.0.3: the three PUBLIC hosts
   * (`github.com`, `gitlab.com`, `bitbucket.org`) each get a default integration
   * entry when the host configures none, so public repos on them need no config
   * block at all. This therefore fires only for SELF-HOSTED instances
   * (`gitlab.company.com`, Bitbucket Server, GHE) — worth restating because
   * all three public hosts self-default, not just github.com.
   */
  assertConfigured(url: string): void;

  /**
   * Cheaply answers whether the collection tree behind `url` still matches the
   * one a cached snapshot was built from, using a CONDITIONAL HTTP request.
   *
   * OPTIONAL, and absent for GitLab and Bitbucket Cloud on purpose — see the
   * header of `scm/treeIdentity.ts`. A provider without it, and any failure of
   * one with it, falls through to `readTree` exactly as before.
   *
   * Must be TOTAL: report `unknown` rather than throwing. The caller treats
   * this as an optimisation in front of a read it is willing to make anyway,
   * and the read's error is the one with a URL and a credential behind it.
   *
   * `cached` is whatever this same method returned last time, or `undefined`
   * the first time a tree is checked — in which case there is nothing to send
   * an `If-None-Match` for and the only honest answer is `changed`.
   */
  checkTreeIdentity?(args: {
    url: string;
    cached?: TreeIdentity;
  }): Promise<TreeIdentityCheck>;

  /**
   * Resolves the repo's default branch, using the host's integration credential.
   * Called only when the URL carries no explicit ref, and only to name a ref in
   * a composed URL.
   *
   * A credential that merely EXISTS is not necessarily authorized — a PAT scoped
   * to one org 404s on a repo somebody can see perfectly well — so this can fail
   * on a repo a human would call readable. That is the same limit the tree read
   * has, and it fails the same way: with the host's own error.
   */
  resolveDefaultBranch(url: string): Promise<string>;
}
