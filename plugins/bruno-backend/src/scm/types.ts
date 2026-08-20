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
   * anything non-public with an error that names neither the cause nor the fix.
   * Only `github.com` self-defaults an integration entry; every other provider
   * requires an explicit config block even for public repos
   * (docs/MULTI-SCM-PLAN.md B10). Called before the first read of a URL.
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
   * only through a host-configured service credential
   * (docs/MULTI-SCM-PLAN.md §1.4, B4).
   */
  readTreeWithUserToken?(args: ScmUserTokenReadArgs): Promise<ScmFileTree>;
}
