/**
 * The seam every descriptor pull request goes through, so that
 * `lib/unlinkPr.ts` and `lib/descriptorPr.ts` hold the YAML edit and the flow
 * and know nothing about a forge.
 *
 * WHY THIS RUNS IN THE BROWSER, and why moving it to the backend is eliminated
 * rather than merely unchosen. Backstage ships scaffolder modules that open
 * pull requests against all three forges (`publish:github:pull-request` and its
 * siblings), and every review of this code proposes delegating to them. They
 * are BACKEND actions. This flow runs in the browser on the user's own
 * `scmAuth` token, which is the single place a per-user SCM credential is used
 * anywhere in this plugin (`packages/app/src/modules/auth/scmAuth.ts`), and the
 * whole point of it is that these writes are ATTRIBUTED TO THE USER. Running
 * them server-side has exactly two forms and both are refused: every pull
 * request is authored by a service account, losing the attribution and the
 * audit trail; or the user's token is forwarded to our backend, which
 * `plugins/bruno-backend/README.md#credential-isolation` explicitly refuses.
 * There is no third form, so there is nothing here to reconsider.
 *
 * ONE abstraction earns its place, and it is {@link PrFile.concurrencyToken}.
 * Everything else in this interface is the same four calls under three names.
 */

/** A repository, in the terms its forge's API takes. */
export interface PrRepo {
  /**
   * The instance, as an ORIGIN (`https://github.acme.internal:8443`) rather
   * than a bare hostname. {@link PrAdapter.repoUrl} rebuilds the dialog's link
   * from it, so a GitHub Enterprise host on a non-default port — or one served
   * over plain http — has to survive the round trip scheme and port intact, or
   * the dialog names a repository on a different server than the one the pull
   * request lands on.
   */
  host: string;
  /**
   * The namespace: the owner on GitHub, the group-and-subgroup path on GitLab.
   * Slashes are legal and expected — GitLab namespaces nest arbitrarily deep.
   */
  project: string;
  /** The repository's own name, without any `.git` suffix. */
  repo: string;
}

/** A file in a repository, as identified by a descriptor URL. */
export interface PrDescriptor extends PrRepo {
  /** Repo-relative path, never leading-slashed. */
  path: string;
}

/** A file as read, and what proves it has not moved since. */
export interface PrFile {
  /** The decoded UTF-8 text. */
  content: string;
  /**
   * An opaque "fail if this moved under me" handle: GitHub's blob `sha`,
   * GitLab's `last_commit_id`, Bitbucket's parent sha. All three forges take
   * one, all three mean the same thing by it, and none of them is readable, so
   * it travels as a string and is only ever handed back.
   *
   * `undefined` in a {@link PrRequest} means CREATE rather than update — which
   * `lib/descriptorPr.ts` relies on, since a create that collides is refused by
   * the forge rather than clobbering the file it collided with.
   */
  concurrencyToken: string;
}

/** Everything a forge needs to branch, commit one file and open the request. */
export interface PrRequest {
  repo: PrRepo;
  /** Repo-relative path of the file to write. */
  path: string;
  /** The head branch to create. Unique per attempt. */
  branch: string;
  /** The branch to base the head on, and the request's target. */
  baseBranch: string;
  /** The file's new contents. */
  content: string;
  /** From the {@link PrFile} that was read; absent to create the file. */
  concurrencyToken?: string;
  commitMessage: string;
  title: string;
  body: string;
}

export interface PrAdapter {
  /**
   * `https://<host>/<owner>/<repo>/<view>/<ref>/<path>` → its parts, or
   * `undefined` for a URL that is not a file in a repository on this forge.
   *
   * Total: a caller hands it whatever `backstage.io/managed-by-location` said,
   * which includes collection FOLDER URLs stamped by the entity provider.
   */
  parseDescriptorUrl(descriptorUrl: string): PrDescriptor | undefined;

  /** `https://<host>/<owner>/<repo>` → its parts, or `undefined`. */
  parseRepoUrl(repoUrl: string): PrRepo | undefined;

  /** The repository's browser URL, for the dialog to link to. */
  repoUrl(repo: PrRepo): string;

  /** The branch a read is taken from and a pull request is opened against. */
  defaultBranch(repo: PrRepo): Promise<string>;

  /**
   * The file at `path` on `ref`, or `undefined` when there is nothing readable
   * as a file there.
   *
   * `undefined` rather than a throw for a missing file because BOTH callers
   * need that answer and mean opposite things by it: an edit cannot proceed
   * without the file, and a create cannot proceed with it. Every other failure
   * — no permission, a network error — propagates, so neither caller can read
   * a 403 as "the path is free".
   */
  readFile(repo: PrRepo, path: string, ref: string): Promise<PrFile | undefined>;

  /** Branches, commits and opens the request; resolves with its browser URL. */
  openPullRequest(request: PrRequest): Promise<{ link: string }>;
}
