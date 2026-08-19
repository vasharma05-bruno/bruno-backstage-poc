/** A repo URL decomposed into the parts the collection loader needs. */
export interface ParsedRepoUrl {
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
 */
export interface ScmProvider {
  /** The `ScmIntegration.type` this adapter serves, e.g. `'github'`. */
  readonly type: string;

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
   * Resolves the repo's default branch. Called only when the URL carries no
   * explicit ref, and only to name a ref in a composed URL.
   */
  resolveDefaultBranch(
    url: string,
    opts?: { userToken?: string }
  ): Promise<string>;
}
