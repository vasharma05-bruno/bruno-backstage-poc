import { Octokit } from '@octokit/rest';
import type { Document } from 'yaml';
import { parseDocument, parseAllDocuments, isMap, isSeq } from 'yaml';
import { normaliseApiRef } from './apiRef';

/**
 * Composes and submits the pull requests that add an API reference to, or remove
 * one from, a Bruno collection's `spec.partOf`.
 *
 * Why a pull request and not a write. Catalog relations are DERIVED: they are
 * recomputed by the processors on every stitch and rewritten wholesale, and
 * `plugin-catalog-backend`'s router exposes no relation-mutation endpoint. A
 * relation row written or deleted at runtime would be silently reverted within
 * one processing cycle. `spec.partOf` in the collection's `catalog-info.yaml` is
 * the only place the link actually exists, so linking and unlinking both mean
 * editing that file — and source control stays the single source of truth.
 *
 * Both directions live here because they are the same operation with a different
 * sign: same descriptor resolution, same GitHub read/branch/commit/PR sequence,
 * same failure modes. Only the YAML edit and the wording differ.
 *
 * Why not `catalogImportApi.submitPullRequest`. Three independent blockers, all
 * properties of `plugin-catalog-import/dist/api/GitHub.esm.js`: it writes to
 * `catalog.import.entityFilename` at the REPOSITORY ROOT rather than at the
 * descriptor's real path; it calls `createOrUpdateFileContents` with no `sha`,
 * so it can only CREATE a file, never update one; and it uses a single fixed
 * branch name, so a second unlink collides with the first.
 *
 * Credentials. The caller resolves an SCM token through
 * `scmAuthApi.getCredentials({ url, additionalScope: { repoWrite: true } })` —
 * the same path Backstage's own importer uses — so the pull request is authored
 * by the ACTUAL USER: correct attribution, correct audit trail, and no
 * server-side write credential. The token is passed in, held in a local, handed
 * to exactly one `new Octokit({ auth })`, and is never logged, stored, or put
 * into a URL.
 *
 * Comment preservation is why this uses `yaml`'s `parseDocument` rather than
 * `js-yaml` (which the backend uses): a round-trip through `js-yaml` strips
 * every comment from the file, and an unlink PR that silently deletes a team's
 * comments will not get merged.
 */

/** Which way a planned `spec.partOf` edit goes. Part of the exported
 *  {@link PartOfPlan} shape, so it stays public with it. */
export type PartOfDirection = 'link' | 'unlink';

/** Everything a dialog needs to show a preview and then submit. */
export interface PartOfPlan {
  /** Whether this plan adds the reference or removes it. */
  direction: PartOfDirection;
  /** The `catalog-info.yaml` URL, as taken from `backstage.io/managed-by-location`. */
  descriptorUrl: string;
  /** `https://<host>/<owner>/<repo>` — shown in the dialog. */
  repoUrl: string;
  owner: string;
  repo: string;
  /** Repo-relative path of the descriptor. */
  path: string;
  /** The head branch this attempt will create. Unique per attempt. */
  branch: string;
  /** The repository's default branch: what we read, and the PR base. */
  baseBranch: string;
  /** Blob sha of the descriptor as read. Required to UPDATE rather than create. */
  fileSha: string;
  /** The descriptor exactly as it is today. */
  before: string;
  /** The descriptor with the reference removed. */
  after: string;
  /** The API entity references being added or removed, normalised. */
  apiRefs: string[];
}

/**
 * The unlink flow's name for {@link PartOfPlan}. Kept so the existing unlink
 * call sites read in their own vocabulary now that the shape serves both
 * directions.
 */
export type UnlinkPlan = PartOfPlan;

/** Why a `spec.partOf` edit could not be composed. */
type PartOfEditReason
  = | 'not-present'
    | 'already-present'
    | 'multi-document'
    | 'unparseable';

/**
 * A typed failure of the YAML edit itself, as opposed to a network or
 * permission failure. Both dialogs surface `message` verbatim; `reason` is the
 * machine-readable discriminant a caller would key a distinct blocked state
 * off, and every `message` below is written to stand on its own without it.
 */
class PartOfEditError extends Error {
  readonly reason: PartOfEditReason;

  constructor(reason: PartOfEditReason, message: string) {
    super(message);
    this.name = 'PartOfEditError';
    this.reason = reason;
  }
}

/**
 * Parses a descriptor for editing, rejecting the two shapes we must not touch.
 *
 * A multi-document descriptor would need us to pick WHICH document declares this
 * collection, and the edit functions are deliberately given only the text.
 * Editing the first document blindly could rewrite a different entity.
 */
function parseDescriptor(yamlText: string): Document {
  if (parseAllDocuments(yamlText).length > 1) {
    throw new PartOfEditError(
      'multi-document',
      'This catalog-info.yaml holds more than one entity document, so the '
      + 'change cannot be applied automatically. Edit the file by hand.'
    );
  }

  const doc = parseDocument(yamlText);
  if (doc.errors.length > 0) {
    throw new PartOfEditError(
      'unparseable',
      `This catalog-info.yaml could not be parsed: ${doc.errors[0].message}`
    );
  }
  return doc;
}

/**
 * Index of `target` (already normalised) within a `spec.partOf` sequence, or
 * `-1`. Compares NORMALISED refs, so `github-rest-api` in the file matches
 * `api:default/github-rest-api` from the catalog.
 */
function findRefIndex(
  doc: Document,
  seq: ReturnType<Document['getIn']>,
  target: string
): number {
  if (!isSeq(seq)) {
    return -1;
  }
  return seq.items.findIndex((item) => {
    const value = doc.createNode(item).toJSON();
    if (typeof value !== 'string') {
      return false;
    }
    try {
      return normaliseApiRef(value) === target;
    } catch {
      // An unparseable ref in the file is not the one we are looking for.
      return false;
    }
  });
}

/** ``a``, ``b`` — references as inline code, for a message or a body. */
const codeList = (refs: string[]): string =>
  refs.map((ref) => `\`${ref}\``).join(', ');

/** A pull request subject names one reference, or counts several. */
const subject = (refs: string[]): string =>
  refs.length === 1 ? refs[0] : `${refs.length} APIs`;

/**
 * Adds `apiRefs` to `spec.partOf` in a `catalog-info.yaml`, preserving every
 * comment and all formatting outside the edited sequence.
 *
 * Creates the `partOf` key when the collection has none — the common case, since
 * a collection registered on its own has nothing to be part of yet. `setIn`
 * would happily conjure a `spec` map too, but a descriptor with no `spec` is not
 * a Bruno entity (`spec.url` is required), so a missing or non-map `spec` is
 * treated as "this is not the file we think it is" rather than silently rebuilt.
 *
 * References already listed are SKIPPED rather than failing the edit: with
 * several APIs selected at once, one that a colleague linked yesterday should
 * not block the rest. Only an edit that would change nothing at all throws
 * {@link PartOfEditError} with `already-present` — the relation exists in
 * source control and is merely waiting for a processing cycle, so an empty pull
 * request would help nobody.
 */
function addPartOf(yamlText: string, apiRefs: string[]): string {
  const doc = parseDescriptor(yamlText);
  const targets = apiRefs.map(normaliseApiRef);

  const spec = doc.getIn(['spec']);
  if (spec !== undefined && spec !== null && !isMap(spec)) {
    throw new PartOfEditError(
      'unparseable',
      'This catalog-info.yaml has no `spec` mapping to add `partOf` to.'
    );
  }

  const seq = doc.getIn(['spec', 'partOf']);
  if (seq === undefined || seq === null) {
    doc.setIn(['spec', 'partOf'], doc.createNode(targets));
    return doc.toString();
  }
  if (!isSeq(seq)) {
    throw new PartOfEditError(
      'unparseable',
      'The `spec.partOf` value in this catalog-info.yaml is not a list, so the '
      + 'reference cannot be appended. Edit the file by hand.'
    );
  }

  const missing = targets.filter((t) => findRefIndex(doc, seq, t) === -1);
  if (missing.length === 0) {
    throw new PartOfEditError(
      'already-present',
      `${codeList(targets)} ${targets.length === 1 ? 'is' : 'are'} already `
      + `listed in this collection's \`spec.partOf\`. The relation may just be `
      + 'waiting for Backstage to re-read the descriptor.'
    );
  }

  for (const target of missing) {
    seq.add(doc.createNode(target));
  }
  return doc.toString();
}

/**
 * Removes `apiRefs` from `spec.partOf` in a `catalog-info.yaml`, preserving
 * every comment and all formatting outside the edited sequence.
 *
 * Drops the `partOf` key entirely when the sequence empties — an empty list is
 * schema-legal but reads as "someone forgot to finish this", and re-adding the
 * key is what {@link addPartOf} does anyway.
 *
 * Throws a {@link PartOfEditError} rather than returning the input unchanged
 * when none of the references are there: that means the link was already
 * removed upstream, and opening an empty pull request would be worse than
 * saying so.
 */
function removePartOf(yamlText: string, apiRefs: string[]): string {
  const doc = parseDescriptor(yamlText);
  const targets = apiRefs.map(normaliseApiRef);

  const seq = doc.getIn(['spec', 'partOf']);
  if (!isSeq(seq)) {
    throw new PartOfEditError(
      'not-present',
      'This catalog-info.yaml has no `spec.partOf` list, so there is nothing to '
      + 'unlink. The relation may already have been removed upstream.'
    );
  }

  // Re-found per removal: `deleteIn` shifts every later index along.
  let removed = 0;
  for (const target of targets) {
    const index = findRefIndex(doc, seq, target);
    if (index !== -1) {
      seq.deleteIn([index]);
      removed += 1;
    }
  }
  if (removed === 0) {
    throw new PartOfEditError(
      'not-present',
      `${codeList(targets)} ${targets.length === 1 ? 'is' : 'are'} not listed `
      + `in this collection's \`spec.partOf\`. The relation may already have `
      + 'been removed upstream.'
    );
  }

  if (seq.items.length === 0) {
    doc.deleteIn(['spec', 'partOf']);
  }
  return doc.toString();
}

/**
 * `https://<host>/<owner>/<repo>/blob/<ref>/<path>` → its parts.
 *
 * `repoUrl` is rebuilt from the descriptor's OWN origin rather than from a
 * `https://github.com/` literal: on GitHub Enterprise that literal named a
 * repository on the public host, which is not where the pull request is going.
 * Exported so the shapes below can be asserted without a network.
 */
export function parseGitHubDescriptorUrl(
  descriptorUrl: string
): { repoUrl: string; owner: string; repo: string; path: string } | undefined {
  let url: URL;
  try {
    url = new URL(descriptorUrl);
  } catch {
    return undefined;
  }
  // `<owner>/<repo>/(blob|raw|tree)/<ref>/<path…>` — the catalog stores GitHub
  // locations in the browser `blob` form, and `raw` shows up in hand-written
  // ones.
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length < 5 || !['blob', 'raw', 'tree'].includes(segments[2])) {
    return undefined;
  }
  return {
    repoUrl: `${url.origin}/${segments[0]}/${segments[1]}`,
    owner: segments[0],
    repo: segments[1],
    path: segments.slice(4).join('/')
  };
}

/** Base64-decodes GitHub's file content, which is UTF-8 and newline-wrapped. */
function decodeBase64(content: string): string {
  const binary = atob(content.replace(/\s/g, ''));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
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

/** A short random suffix, so two edits in a row never collide on a branch name. */
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
 * The per-direction wording, in one place so the two flows cannot drift.
 *
 * `branchPrefix` differs as well as the prose: a link and an unlink of the same
 * collection are different pull requests, and identical branch prefixes would
 * make them indistinguishable in a branch list.
 */
const DIRECTIONS: Record<
  PartOfDirection,
  {
    branchPrefix: string;
    edit: (yamlText: string, apiRefs: string[]) => string;
    title: (apiRefs: string[]) => string;
    body: (apiRefs: string[], path: string) => string;
  }
> = {
  link: {
    branchPrefix: 'bruno-link',
    edit: addPartOf,
    title: (refs) => `Link ${subject(refs)} to Bruno collection`,
    body: (refs, path) =>
      `Adds ${codeList(refs)} to \`spec.partOf\` in \`${path}\`.\n\n`
      + 'Opened from Backstage. The catalog relation appears once this pull '
      + 'request is merged and Backstage re-reads the descriptor.'
  },
  unlink: {
    branchPrefix: 'bruno-unlink',
    edit: removePartOf,
    title: (refs) => `Unlink ${subject(refs)} from Bruno collection`,
    body: (refs, path) =>
      `Removes ${codeList(refs)} from \`spec.partOf\` in \`${path}\`.\n\n`
      + 'Opened from Backstage. The catalog relation disappears once this pull '
      + 'request is merged and Backstage re-reads the descriptor.'
  }
};

/**
 * Reads the descriptor and composes the edit, WITHOUT writing anything.
 *
 * Split from {@link submitPartOfEdit} so the dialog can show a real before/after
 * of the file the user is about to change, and so every failure that can be
 * detected before a branch exists (not present, not parseable, no permission to
 * read) happens while nothing has been created yet.
 */
async function planPartOfEdit(opts: {
  direction: PartOfDirection;
  descriptorUrl: string;
  apiRefs: string[];
  collectionName: string;
  token: string;
  /**
   * The matched integration's `apiBaseUrl`, which is what makes this work on
   * GitHub Enterprise. Backstage fills it in for every configured GitHub
   * integration — `https://api.github.com` for github.com itself — so it is
   * normally set and passing it is a no-op on the public host. Undefined only
   * when no integration matches the descriptor's host, where Octokit's default
   * is the best guess available. Getting this wrong is not subtle: without it
   * a GHE flow asks the user for a token against their own host and then sends
   * every call at the public API, 404ing on a repository that exists.
   */
  apiBaseUrl?: string;
}): Promise<PartOfPlan> {
  const {
    direction,
    descriptorUrl,
    apiRefs,
    collectionName,
    token,
    apiBaseUrl
  } = opts;
  const parsed = parseGitHubDescriptorUrl(descriptorUrl);
  if (!parsed) {
    throw new PartOfEditError(
      'unparseable',
      `Could not work out the repository and path from ${descriptorUrl}.`
    );
  }
  const { repoUrl, owner, repo, path } = parsed;

  const octokit = new Octokit({ auth: token, ...(apiBaseUrl ? { baseUrl: apiBaseUrl } : {}) });
  const repoInfo = await octokit.repos.get({ owner, repo });
  const baseBranch = repoInfo.data.default_branch;

  const file = await octokit.repos.getContent({
    owner,
    repo,
    path,
    ref: baseBranch
  });
  // `getContent` returns a directory listing for a folder path and a submodule
  // / symlink shape for those; only the file shape carries `content`.
  const data = file.data;
  if (Array.isArray(data) || data.type !== 'file' || !('content' in data)) {
    throw new PartOfEditError(
      'unparseable',
      `${path} is not a file in ${owner}/${repo}.`
    );
  }

  const before = decodeBase64(data.content);
  const spec = DIRECTIONS[direction];
  const after = spec.edit(before, apiRefs);

  return {
    direction,
    descriptorUrl,
    repoUrl,
    owner,
    repo,
    path,
    branch:
      `${spec.branchPrefix}-${slugify(collectionName)}-${branchSuffix()}`,
    baseBranch,
    fileSha: data.sha,
    before,
    after,
    apiRefs: apiRefs.map(normaliseApiRef)
  };
}

/**
 * Creates the branch, commits the edited descriptor and opens the pull request.
 *
 * `createOrUpdateFileContents` is called WITH `sha`, which is what makes it an
 * update rather than a create — the distinction `catalogImportApi` gets wrong
 * and the reason this module exists.
 */
async function submitPartOfEdit(
  plan: PartOfPlan,
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

  const message = DIRECTIONS[plan.direction].title(plan.apiRefs);
  await octokit.repos.createOrUpdateFileContents({
    owner: plan.owner,
    repo: plan.repo,
    path: plan.path,
    branch: plan.branch,
    sha: plan.fileSha,
    message,
    content: encodeBase64(plan.after)
  });

  const pr = await octokit.pulls.create({
    owner: plan.owner,
    repo: plan.repo,
    head: plan.branch,
    base: plan.baseBranch,
    title: message,
    body: DIRECTIONS[plan.direction].body(plan.apiRefs, plan.path)
  });

  return { link: pr.data.html_url };
}

/**
 * The two directions under their flow-specific names.
 *
 * Thin wrappers rather than call sites passing `direction` themselves: a dialog
 * that can only unlink should not be able to express a link by getting one
 * string argument wrong.
 */
export function planUnlink(opts: {
  descriptorUrl: string;
  apiRefs: string[];
  collectionName: string;
  token: string;
  apiBaseUrl?: string;
}): Promise<UnlinkPlan> {
  return planPartOfEdit({ ...opts, direction: 'unlink' });
}

export function submitUnlink(
  plan: UnlinkPlan,
  token: string,
  apiBaseUrl?: string
): Promise<{ link: string }> {
  return submitPartOfEdit(plan, token, apiBaseUrl);
}

export function planLink(opts: {
  descriptorUrl: string;
  apiRefs: string[];
  collectionName: string;
  token: string;
  apiBaseUrl?: string;
}): Promise<PartOfPlan> {
  return planPartOfEdit({ ...opts, direction: 'link' });
}

export function submitLink(
  plan: PartOfPlan,
  token: string,
  apiBaseUrl?: string
): Promise<{ link: string }> {
  return submitPartOfEdit(plan, token, apiBaseUrl);
}
