import { createGitlabPrAdapter } from './gitlab';

/** Parsing and URL construction only — no fetch is reachable from these. */
const pure = createGitlabPrAdapter({ token: 'unused' });

describe('gitlab parseDescriptorUrl', () => {
  it.each([
    [
      'https://gitlab.com/acme/apis/-/blob/main/catalog-info.yaml',
      'https://gitlab.com',
      'acme',
      'catalog-info.yaml'
    ],
    // A subgroup namespace: everything before `/-/` except the last segment.
    // Counting segments would call the project `apis` and the namespace `acme`,
    // addressing a project one level up that may well exist.
    [
      'https://gitlab.com/acme/team/platform/apis/-/blob/main/collections/payments/catalog-info.yaml',
      'https://gitlab.com',
      'acme/team/platform',
      'collections/payments/catalog-info.yaml'
    ],
    // Self-hosted, on a non-default port: the origin survives intact, which is
    // what the dialog's repository link and the API base fallback are built on.
    [
      'https://gitlab.acme.internal:8443/acme/apis/-/raw/main/catalog-info.yaml',
      'https://gitlab.acme.internal:8443',
      'acme',
      'catalog-info.yaml'
    ]
  ])('reads %s', (url, expectedHost, expectedProject, expectedPath) => {
    expect(pure.parseDescriptorUrl(url)).toEqual({
      host: expectedHost,
      project: expectedProject,
      repo: 'apis',
      path: expectedPath
    });
  });

  it.each([
    // A project URL, not a descriptor.
    'https://gitlab.com/acme/apis',
    // The legacy separator-less form: `blob` here is indistinguishable from a
    // subgroup of that name, so it is refused rather than guessed at.
    'https://gitlab.com/acme/apis/blob/main/catalog-info.yaml',
    // A view segment this flow cannot read as a file path.
    'https://gitlab.com/acme/apis/-/commits/main/catalog-info.yaml',
    // A ref with no path below it.
    'https://gitlab.com/acme/apis/-/tree/main',
    // One namespace segment short.
    'https://gitlab.com/apis/-/blob/main/catalog-info.yaml',
    'not a url'
  ])('refuses %s', (url) => {
    expect(pure.parseDescriptorUrl(url)).toBeUndefined();
  });
});

describe('gitlab parseRepoUrl and repoUrl', () => {
  it.each([
    ['https://gitlab.com/acme/apis', 'https://gitlab.com/acme/apis'],
    [
      'https://gitlab.com/acme/team/apis.git',
      'https://gitlab.com/acme/team/apis'
    ],
    [
      'https://gitlab.acme.internal:8443/acme/team/platform/apis',
      'https://gitlab.acme.internal:8443/acme/team/platform/apis'
    ],
    // A collection folder URL, which is what the add-collection flow hands it.
    [
      'https://gitlab.com/acme/team/apis/-/tree/main/collections/payments',
      'https://gitlab.com/acme/team/apis'
    ]
  ])('round-trips %s', (url, expected) => {
    const repo = pure.parseRepoUrl(url);
    expect(repo).toBeDefined();
    expect(pure.repoUrl(repo!)).toBe(expected);
  });

  it.each(['https://gitlab.com/acme', 'https://gitlab.com/', 'not a url'])(
    'refuses %s',
    (url) => {
      expect(pure.parseRepoUrl(url)).toBeUndefined();
    }
  );
});

/** One recorded call: what was requested, and what to answer with. */
interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function stubFetch(
  answers: Array<{ status?: number; body?: unknown }>
): { calls: Call[]; fetch: typeof globalThis.fetch } {
  const calls: Call[] = [];
  let index = 0;
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method as string,
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(init.body as string) : undefined
    });
    const answer = answers[index] ?? {};
    index += 1;
    const status = answer.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => answer.body,
      text: async () => JSON.stringify(answer.body ?? '')
    };
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

const REPO = {
  host: 'https://gitlab.com',
  project: 'acme/team',
  repo: 'apis'
};

/** `spec:\n  partOf: []\n`, base64, as both the fixture and the assertion. */
const base64 = (text: string): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)));

/**
 * The transport is where the concurrency guards live, and dropping one is
 * silent: the pull request still opens, and it overwrites whatever landed while
 * the preview was on screen. So these assert the exact request bodies rather
 * than that a call happened.
 */
describe('gitlab transport', () => {
  it('reads a file by namespaced project id and returns last_commit_id', async () => {
    const { calls, fetch } = stubFetch([
      { body: { content: base64('kind: Bruno\n'), last_commit_id: 'abc123' } }
    ]);
    const adapter = createGitlabPrAdapter({
      token: 'tok',
      apiBaseUrl: 'https://gitlab.com/api/v4',
      fetch
    });

    await expect(
      adapter.readFile(REPO, 'collections/payments/catalog-info.yaml', 'main')
    ).resolves.toEqual({
      content: 'kind: Bruno\n',
      concurrencyToken: 'abc123'
    });
    expect(calls[0].url).toBe(
      'https://gitlab.com/api/v4/projects/acme%2Fteam%2Fapis/repository/files/'
      + 'collections%2Fpayments%2Fcatalog-info.yaml?ref=main'
    );
    expect(calls[0].method).toBe('GET');
    expect(calls[0].headers.Authorization).toBe('Bearer tok');
  });

  it('reads a missing file as undefined rather than throwing', async () => {
    const { fetch } = stubFetch([{ status: 404 }]);
    const adapter = createGitlabPrAdapter({ token: 'tok', fetch });

    await expect(
      adapter.readFile(REPO, 'catalog-info.yaml', 'main')
    ).resolves.toBeUndefined();
  });

  it('falls back to the origin when no integration supplied an apiBaseUrl', async () => {
    const { calls, fetch } = stubFetch([{ body: { default_branch: 'trunk' } }]);
    const adapter = createGitlabPrAdapter({ token: 'tok', fetch });

    await expect(adapter.defaultBranch(REPO)).resolves.toBe('trunk');
    expect(calls[0].url).toBe(
      'https://gitlab.com/api/v4/projects/acme%2Fteam%2Fapis'
    );
  });

  it('commits with start_branch and last_commit_id, then opens the merge request', async () => {
    const { calls, fetch } = stubFetch([
      { body: { id: 'commit-sha' } },
      { body: { web_url: 'https://gitlab.com/acme/team/apis/-/merge_requests/7' } }
    ]);
    const adapter = createGitlabPrAdapter({
      token: 'tok',
      apiBaseUrl: 'https://gitlab.com/api/v4',
      fetch
    });

    await expect(
      adapter.openPullRequest({
        repo: REPO,
        path: 'collections/payments/catalog-info.yaml',
        branch: 'bruno-link-payments-0a1b2c3d',
        baseBranch: 'main',
        content: 'kind: Bruno\n',
        concurrencyToken: 'abc123',
        commitMessage: 'Link api:default/payments to Bruno collection',
        title: 'Link api:default/payments to Bruno collection',
        body: 'Opened from Backstage.'
      })
    ).resolves.toEqual({
      link: 'https://gitlab.com/acme/team/apis/-/merge_requests/7'
    });

    expect(calls[0].url).toBe(
      'https://gitlab.com/api/v4/projects/acme%2Fteam%2Fapis/repository/commits'
    );
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({
      branch: 'bruno-link-payments-0a1b2c3d',
      // Creates the head branch as part of the commit. Without it the commit
      // lands on `main` — the branch the merge request is meant to target.
      start_branch: 'main',
      commit_message: 'Link api:default/payments to Bruno collection',
      actions: [
        {
          action: 'update',
          file_path: 'collections/payments/catalog-info.yaml',
          content: base64('kind: Bruno\n'),
          encoding: 'base64',
          // The concurrency guard. Without it the commit silently overwrites
          // whatever landed since the descriptor was read.
          last_commit_id: 'abc123'
        }
      ]
    });

    expect(calls[1].url).toBe(
      'https://gitlab.com/api/v4/projects/acme%2Fteam%2Fapis/merge_requests'
    );
    expect(calls[1].body).toEqual({
      source_branch: 'bruno-link-payments-0a1b2c3d',
      target_branch: 'main',
      title: 'Link api:default/payments to Bruno collection',
      description: 'Opened from Backstage.'
    });
  });

  it('commits a new descriptor as a create, with no last_commit_id', async () => {
    const { calls, fetch } = stubFetch([
      { body: {} },
      { body: { web_url: 'https://gitlab.com/acme/team/apis/-/merge_requests/8' } }
    ]);
    const adapter = createGitlabPrAdapter({ token: 'tok', fetch });

    await adapter.openPullRequest({
      repo: REPO,
      path: 'collections/payments/catalog-info.yaml',
      branch: 'bruno-add-payments-0a1b2c3d',
      baseBranch: 'main',
      content: 'kind: Bruno\n',
      commitMessage: 'Add catalog-info.yaml',
      title: 'Add catalog-info.yaml',
      body: 'Opened from Backstage.'
    });

    expect((calls[0].body as { actions: unknown[] }).actions).toEqual([
      {
        action: 'create',
        file_path: 'collections/payments/catalog-info.yaml',
        content: base64('kind: Bruno\n'),
        encoding: 'base64'
      }
    ]);
  });

  it('surfaces a rejected commit rather than opening a merge request anyway', async () => {
    const { calls, fetch } = stubFetch([
      { status: 400, body: { message: 'A file with this name already exists' } }
    ]);
    const adapter = createGitlabPrAdapter({ token: 'tok', fetch });

    await expect(
      adapter.openPullRequest({
        repo: REPO,
        path: 'catalog-info.yaml',
        branch: 'bruno-add-payments-0a1b2c3d',
        baseBranch: 'main',
        content: 'kind: Bruno\n',
        commitMessage: 'Add catalog-info.yaml',
        title: 'Add catalog-info.yaml',
        body: 'Opened from Backstage.'
      })
    ).rejects.toThrow('A file with this name already exists');
    expect(calls).toHaveLength(1);
  });
});
