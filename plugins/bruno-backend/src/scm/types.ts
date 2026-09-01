import type {
  LoggerService,
  UrlReaderService
} from '@backstage/backend-plugin-api';

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

/** Arguments for a provider's user-token read. */
export interface ScmUserTokenReadArgs {
  /** The normalized collection URL to read. */
  url: string;
  /** The caller's own OAuth token. Never log it. */
  userToken: string;
  /**
   * The plugin's injected `UrlReaderService`. Providers whose reader honours a
   * per-call `options.token` read through this rather than hand-rolling an API
   * client, so Backstage's proxy config and archive-based fetch still apply.
   */
  reader: UrlReaderService;
  logger: LoggerService;
}

/**
 * Per-provider URL grammar and ref resolution. One implementation per SCM
 * provider; selected by `ScmIntegration.type` (see `createScmProviderRegistry`).
 *
 * RETAINED DELIBERATELY, and only partly reached today. `manifestProbe` is the
 * one consumer, and it calls `normalizeUrl` and `assertConfigured` only. These
 * four have no caller on this branch:
 *
 *   composeCollectionUrl    multi-collection discovery — composes the stored
 *                           `spec.url` for each root found inside one repo
 *   repoRootFromUrl         the same discovery path, reducing a collection URL
 *                           back to its repo
 *   resolveDefaultBranch    names a ref when a pasted URL carries none
 *   readTreeWithUserToken   reads a private repo with the CALLER's OAuth token,
 *                           after the host credential has failed
 *
 * They are not scaffolding written ahead of use — they had callers, in
 * `service/collectionService.ts` and `provider/BrunoEntityProvider.ts`, and the
 * `kind: Bruno` entity rewrite deleted both modules and left these behind. The
 * still-live implementations are on `feat/multi-scm`, which predates that
 * rewrite.
 *
 * Keeping them is a decision, taken because `readTreeWithUserToken` is the only
 * route to a private GitLab or Bitbucket repo while neither has a configured
 * service token — deleting it would drop a capability, not just unused code —
 * and because discovery is planned work rather than an abandoned idea. So do
 * not "clean these up" on the strength of a caller count; the count is expected
 * to be zero until that work is rebased onto the current architecture.
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
   * Resolves the repo's default branch. Called only when the URL carries no
   * explicit ref, and only to name a ref in a composed URL.
   */
  resolveDefaultBranch(
    url: string,
    opts?: { userToken?: string }
  ): Promise<string>;

  /**
   * Reads a collection tree using the CALLER's OAuth token, for a private repo
   * the host's service credential cannot see. Called only after the
   * service-credential read has already failed.
   *
   * `undefined` means this provider has no per-user read path at all — not that
   * it is unimplemented here. Bitbucket Cloud's `UrlReader` ignores
   * `options.token` and its integration config silently drops a bare token, so
   * there is nowhere to put a user token; such providers reach private repos
   * only through a host-configured service credential.
   */
  readTreeWithUserToken?(args: ScmUserTokenReadArgs): Promise<ScmFileTree>;
}
