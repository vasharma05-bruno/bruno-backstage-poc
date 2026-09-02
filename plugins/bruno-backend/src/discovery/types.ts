/**
 * The shapes discovery deals in, and the narrow GitHub surface it needs.
 *
 * `GithubDiscoveryClient` exists so the sweep's orchestration — pattern
 * filtering, the pushed-at cache, per-repo failure handling, the descriptor
 * deferral — is testable without Octokit or a network. The Octokit-backed
 * implementation is `githubClient.ts`; it holds every credential concern and no
 * decisions.
 */

/** A collection found in source control, ready to be emitted as an entity. */
export interface DiscoveredCollection {
  /** Normalized collection folder URL — becomes the entity's `spec.url`. */
  url: string;
  /** Repo-qualified entity name; see `discoveredCollectionName`. */
  name: string;
  /** `spec.owner`, copied from the discovery entry that found it. */
  owner?: string;
  /** `owner/repo`, for log lines only. */
  repository: string;
}

/** A source of collections found by sweeping an SCM host. */
export interface CollectionDiscovery {
  /**
   * Sweeps every configured entry.
   *
   * THROWS rather than returning a short list when any entry cannot be swept.
   * The caller applies a `full` mutation, which deletes by set difference, so a
   * partial result is indistinguishable from "these collections are gone" — a
   * throw is the only way to say "I do not know", and the provider answers it
   * by skipping the tick.
   */
  discover(): Promise<DiscoveredCollection[]>;
}

/** One repository, as the sweep needs it. */
export interface DiscoveryRepo {
  owner: string;
  name: string;
  /** `owner/name`. */
  fullName: string;
  /** The repo's web URL — the base every collection URL is composed from, so
   *  it is taken from the API rather than assembled from the host. */
  htmlUrl: string;
  defaultBranch: string;
  /**
   * Last push to ANY branch, as an opaque change token. Over-invalidates (a
   * push to a side branch re-lists the tree) and never under-invalidates for
   * the default branch, which is the direction that matters.
   */
  pushedAt: string;
  archived: boolean;
  /** True for a repository with no commits, whose tree read would 409. */
  empty: boolean;
}

/** The GitHub reads the sweep makes. One call per method, no retries. */
export interface GithubDiscoveryClient {
  /** Every repository of an organization OR user account. */
  listRepositories(args: {
    host: string;
    organization: string;
  }): Promise<DiscoveryRepo[]>;

  /** Every blob path in `ref`, repo-relative. */
  listTree(args: {
    host: string;
    owner: string;
    repo: string;
    ref: string;
  }): Promise<{ paths: string[]; truncated: boolean }>;

  /** One text file, or undefined when it is absent. */
  readTextFile(args: {
    host: string;
    owner: string;
    repo: string;
    ref: string;
    path: string;
  }): Promise<string | undefined>;
}
