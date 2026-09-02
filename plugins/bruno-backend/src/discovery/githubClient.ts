/**
 * The Octokit-backed {@link GithubDiscoveryClient}: every credential concern of
 * a sweep, and none of its decisions.
 *
 * Credential isolation, as everywhere else in this plugin: the only credential
 * is the host's `integrations.github` config — a PAT or a GitHub App
 * installation token, resolved by the same `GithubCredentialsProvider` the
 * UrlReader uses — and there is deliberately no parameter for a caller's OAuth
 * token. A sweep runs inside a scheduled provider task where no user request
 * exists, so a per-user credential could only ever be one borrowed from an
 * unrelated request. A repository the service credential cannot LIST is simply
 * not discovered.
 *
 * Credentials are resolved per call rather than once per host, because a GitHub
 * App issues one installation token per repository; `DefaultGithubCredentials
 * Provider` caches them, so the extra resolves are not extra HTTP.
 */
import type {
  GithubCredentialsProvider,
  ScmIntegrationRegistry
} from '@backstage/integration';
import { Octokit } from '@octokit/rest';
import type { DiscoveryRepo, GithubDiscoveryClient } from './types';

/** GitHub's maximum page size. Fewer round trips per sweep. */
const PER_PAGE = 100;

export function createOctokitDiscoveryClient(options: {
  integrations: ScmIntegrationRegistry;
  githubCredentials: GithubCredentialsProvider;
}): GithubDiscoveryClient {
  const { integrations, githubCredentials } = options;

  /** The API base for a host, so GitHub Enterprise works without a branch. */
  function apiBaseUrl(host: string): string {
    return (
      integrations.github.byHost(host)?.config.apiBaseUrl
      ?? 'https://api.github.com'
    );
  }

  async function octokitFor(host: string, path: string): Promise<Octokit> {
    const url = `https://${host}/${path}`;
    let token: string | undefined;
    try {
      // `|| undefined` so a blank token from a tokenless (anonymous)
      // integration is treated as "no host credential" rather than as one.
      token = (await githubCredentials.getCredentials({ url })).token || undefined;
    } catch {
      // No host credential for this target (e.g. a GitHub App not installed
      // there). Fall through anonymously — enough for public repositories, and
      // the honest failure for the rest.
    }
    return new Octokit({ auth: token, baseUrl: apiBaseUrl(host) });
  }

  return {
    /**
     * Organizations first, then user accounts. The fallback is not a nicety:
     * a personal account is where a collection usually lives before a team owns
     * it, and `repos.listForOrg` answers 404 for one — the same status it
     * answers for an organization the credential cannot see, which is why the
     * original error is thrown when the fallback fails too.
     *
     * `type: 'owner'` for a user, so repositories they merely collaborate on
     * are not swept under this entry; those belong to the entry for THEIR
     * owner, with that entry's `owner:` and pattern.
     */
    async listRepositories({ host, organization }) {
      const octokit = await octokitFor(host, organization);
      let raw: RepoResponse[];
      try {
        // The endpoint-ROUTE form of `paginate`, not `paginate(octokit.repos.
        // listForOrg, …)`. The method-reference overload does not typecheck
        // against the @octokit/rest tree installed here: `plugin-paginate-rest`
        // and `plugin-rest-endpoint-methods` resolve two different copies of
        // @octokit/types, whose `mediaType.previews` differ by one `undefined`.
        // The route form takes its types from `PaginatingEndpoints` and is
        // unaffected.
        raw = await octokit.paginate('GET /orgs/{org}/repos', {
          org: organization,
          per_page: PER_PAGE,
          type: 'all'
        });
      } catch (e) {
        if ((e as { status?: number })?.status !== 404) {
          throw e;
        }
        try {
          raw = await octokit.paginate('GET /users/{username}/repos', {
            username: organization,
            per_page: PER_PAGE,
            type: 'owner'
          });
        } catch (userError) {
          if ((userError as { status?: number })?.status === 404) {
            throw e;
          }
          throw userError;
        }
      }
      return raw.map(toDiscoveryRepo);
    },

    /**
     * One recursive tree call per repository. `truncated` is reported rather
     * than paged around: the caller logs it, because a truncated tree means
     * some collections are invisible and no amount of paging fixes it (the API
     * offers no cursor for a recursive tree).
     */
    async listTree({ host, owner, repo, ref }) {
      const octokit = await octokitFor(host, `${owner}/${repo}`);
      const { data } = await octokit.git.getTree({
        owner,
        repo,
        tree_sha: ref,
        recursive: 'true'
      });
      return {
        paths: data.tree
          .filter((entry) => entry.type === 'blob' && entry.path)
          .map((entry) => entry.path as string),
        truncated: data.truncated === true
      };
    },

    async readTextFile({ host, owner, repo, ref, path }) {
      const octokit = await octokitFor(host, `${owner}/${repo}`);
      try {
        const { data } = await octokit.repos.getContent({
          owner,
          repo,
          path,
          ref,
          // Raw, so nothing has to base64-decode a descriptor — and so a file
          // over the 1 MB JSON limit still reads.
          mediaType: { format: 'raw' }
        });
        // Typed as the JSON union; `format: 'raw'` makes it the file's text.
        return data as unknown as string;
      } catch (e) {
        if ((e as { status?: number })?.status === 404) {
          return undefined;
        }
        throw e;
      }
    }
  };
}

/** The subset of a repository response the sweep reads. */
type RepoResponse = {
  name: string;
  full_name: string;
  html_url: string;
  default_branch?: string;
  pushed_at?: string | null;
  archived?: boolean;
  size?: number;
  owner?: { login?: string } | null;
};

function toDiscoveryRepo(repo: RepoResponse): DiscoveryRepo {
  return {
    // `full_name` is `owner/name`; the login is read from it rather than from
    // `owner.login` so a response that omits the owner object still parses.
    owner: repo.owner?.login ?? repo.full_name.split('/')[0],
    name: repo.name,
    fullName: repo.full_name,
    htmlUrl: repo.html_url,
    defaultBranch: repo.default_branch ?? 'main',
    // Null for a repository with no commits, which `empty` already covers.
    pushedAt: repo.pushed_at ?? '',
    archived: repo.archived === true,
    // A repository with no commits has no tree to read: `git.getTree` answers
    // 409 for one, which would otherwise fail the whole sweep.
    empty: repo.size === 0
  };
}
