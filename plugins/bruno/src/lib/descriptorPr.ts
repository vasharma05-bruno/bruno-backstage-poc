import { Octokit } from '@octokit/rest';
import { descriptorPathForCollection, repoRootFromCollectionUrl } from './scmUrl';

/**
 * Opens the pull request that ADDS a collection's `catalog-info.yaml`, at the
 * path the collection actually lives at.
 *
 * Why this exists rather than `catalogImportApi.submitPullRequest`. That client
 * commits to `catalog.import.entityFilename` at the REPOSITORY ROOT and nowhere
 * else (`plugin-catalog-import/dist/api/GitHub.esm.js` passes `path: fileName`
 * with no directory component). For a collection in a subfolder — the normal
 * case, `…/bruno-collections/tree/main/github-rest-api-collection` — that puts
 * the descriptor somewhere the collection is not, and caps a repository at ONE
 * describable collection: the second import would need the same root path and
 * the client cannot update a file it did not create. It also pins every import
 * to one fixed branch name, so two collections cannot be in flight at once.
 *
 * The same three limits are why `lib/unlinkPr.ts` talks to GitHub directly, and
 * this module is deliberately its sibling: same credential contract, same
 * plan/submit split, same branch-per-attempt naming. The one real difference is
 * that this CREATES a file, so it commits without a `sha` and treats an
 * existing descriptor as a stop rather than something to overwrite.
 *
 * Credentials. The caller resolves an SCM token through
 * `scmAuthApi.getCredentials({ url, additionalScope: { repoWrite: true } })`,
 * so the pull request is authored by the ACTUAL USER — correct attribution, and
 * no server-side write credential. The token is passed in, held in a local,
 * handed to exactly one `new Octokit({ auth })`, and is never logged, stored, or
 * put into a URL.
 *
 * GitHub only. Azure DevOps stays on `catalogImportApi`, root path and all;
 * see `GeneratedYamlDialog`.
 */

/** Everything the dialog needs to describe, and then open, the pull request. */
export interface DescriptorPlan {
  /** `https://<host>/<owner>/<repo>` — shown in the dialog. */
  repoUrl: string;
  owner: string;
  repo: string;
  /** Repo-relative path the descriptor will be committed at. */
  path: string;
  /** The head branch this attempt will create. Unique per attempt. */
  branch: string;
  /** The repository's default branch: what we read, and the pull request base. */
  baseBranch: string;
  /** The descriptor, exactly as previewed and downloaded. */
  content: string;
  /** Pull request title and body, as edited by the user. */
  title: string;
  body: string;
}

/** Why a descriptor pull request could not be composed. */
type DescriptorPrReason = 'unparseable-url' | 'already-exists';

/**
 * A typed failure of the PLAN, as opposed to a network or permission failure.
 * The dialog surfaces `message` verbatim; `reason` is the machine-readable
 * discriminant, and every `message` is written to stand on its own without it.
 */
export class DescriptorPrError extends Error {
  readonly reason: DescriptorPrReason;

  constructor(reason: DescriptorPrReason, message: string) {
    super(message);
    this.name = 'DescriptorPrError';
    this.reason = reason;
  }
}

/** `https://<host>/<owner>/<repo>/…` → its owner and repo. */
function parseGitHubRepoUrl(
  repoUrl: string
): { owner: string; repo: string } | undefined {
  let url: URL;
  try {
    url = new URL(repoUrl);
  } catch {
    return undefined;
  }
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length < 2) {
    return undefined;
  }
  return { owner: segments[0], repo: segments[1].replace(/\.git$/, '') };
}

/** Base64-encodes UTF-8 text for the GitHub contents API. */
function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** A short random suffix, so two attempts in a row never collide on a branch. */
function branchSuffix(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Reduces a name to something safe to put in a git ref. */
function slugify(name: string): string {
  return (
    name
      .toLocaleLowerCase('en-US')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'collection'
  );
}

/**
 * Composes the pull request WITHOUT writing anything: resolves the repository
 * and the descriptor's path, picks a branch, and checks that the path is free.
 *
 * Split from {@link submitDescriptorPr} for the same reason the unlink flow is:
 * every failure that can be found before a branch exists — an unreadable URL, a
 * descriptor already sitting at that path, no permission to read the repository
 * — happens while nothing has been created yet, so a retry is not cleaning up
 * after the last attempt.
 *
 * An existing descriptor at the path is a STOP rather than an update. This flow
 * only ever produces a fresh entity from a form the user just filled in;
 * committing that over a descriptor someone else wrote would silently discard
 * their `spec.partOf`, their owner, and any comments in the file. Editing an
 * existing descriptor is what `lib/unlinkPr.ts` is for.
 */
export async function planDescriptorPr(opts: {
  /** The collection folder URL, as entered in the form. */
  collectionUrl: string;
  /** `metadata.name`, for the branch name. */
  collectionName: string;
  /** `catalog.import.entityFilename`, so a re-configured app is honoured. */
  filename: string;
  /** The descriptor, byte-for-byte as previewed. */
  content: string;
  title: string;
  body: string;
  token: string;
  /**
   * The integration's `apiBaseUrl`, for GitHub Enterprise. Omitted for
   * github.com, where Octokit's own default is right — passing the wrong one
   * here would send the whole flow at the public API and 404 on a repository
   * that exists.
   */
  apiBaseUrl?: string;
}): Promise<DescriptorPlan> {
  const {
    collectionUrl,
    collectionName,
    filename,
    content,
    title,
    body,
    token,
    apiBaseUrl
  } = opts;

  const repoUrl = repoRootFromCollectionUrl(collectionUrl);
  const parsed = parseGitHubRepoUrl(repoUrl);
  if (!parsed) {
    throw new DescriptorPrError(
      'unparseable-url',
      `Could not work out the repository from ${collectionUrl}.`
    );
  }
  const { owner, repo } = parsed;
  const path = descriptorPathForCollection(collectionUrl, filename);

  const octokit = new Octokit({ auth: token, ...(apiBaseUrl ? { baseUrl: apiBaseUrl } : {}) });
  const repoInfo = await octokit.repos.get({ owner, repo });
  const baseBranch = repoInfo.data.default_branch;

  // A 404 here is the GOOD answer — the path is free. Anything else (403 on a
  // repository the token cannot read, a network failure) is a real error and is
  // left to propagate rather than being read as "free".
  try {
    await octokit.repos.getContent({ owner, repo, path, ref: baseBranch });
    throw new DescriptorPrError(
      'already-exists',
      `${path} already exists in ${owner}/${repo}. Download the file and merge `
      + 'it into the existing descriptor by hand — this flow only adds a new '
      + 'one, and committing over that file would discard whatever it declares.'
    );
  } catch (e) {
    if (e instanceof DescriptorPrError) {
      throw e;
    }
    if ((e as { status?: number }).status !== 404) {
      throw e;
    }
  }

  return {
    repoUrl,
    owner,
    repo,
    path,
    branch: `bruno-add-${slugify(collectionName)}-${branchSuffix()}`,
    baseBranch,
    content,
    title,
    body
  };
}

/**
 * Creates the branch, commits the descriptor at {@link DescriptorPlan.path} and
 * opens the pull request.
 *
 * `createOrUpdateFileContents` is called WITHOUT `sha`, which is what makes it a
 * create: {@link planDescriptorPr} has already established the path is free, and
 * a `sha`-less call against an existing file is rejected by GitHub rather than
 * clobbering it — so the check and the commit fail the same way if someone lands
 * a descriptor between the two.
 */
export async function submitDescriptorPr(
  plan: DescriptorPlan,
  token: string,
  apiBaseUrl?: string
): Promise<{ link: string }> {
  const octokit = new Octokit({ auth: token, ...(apiBaseUrl ? { baseUrl: apiBaseUrl } : {}) });

  const baseRef = await octokit.git.getRef({
    owner: plan.owner,
    repo: plan.repo,
    ref: `heads/${plan.baseBranch}`
  });
  await octokit.git.createRef({
    owner: plan.owner,
    repo: plan.repo,
    ref: `refs/heads/${plan.branch}`,
    sha: baseRef.data.object.sha
  });

  await octokit.repos.createOrUpdateFileContents({
    owner: plan.owner,
    repo: plan.repo,
    path: plan.path,
    branch: plan.branch,
    message: plan.title,
    content: encodeBase64(plan.content)
  });

  const pr = await octokit.pulls.create({
    owner: plan.owner,
    repo: plan.repo,
    head: plan.branch,
    base: plan.baseBranch,
    title: plan.title,
    body: plan.body
  });

  return { link: pr.data.html_url };
}
