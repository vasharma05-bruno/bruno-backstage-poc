import type {
  LoggerService,
  UrlReaderService
} from '@backstage/backend-plugin-api';
import { isCollectionFile } from './treeFilter';
import type { ScmFileTree } from './types';

/**
 * Reads a collection tree through Backstage's `UrlReaderService`, keeping only
 * the files the parser needs.
 *
 * Credential isolation: credentials come from the host's `integrations.*` config
 * and are applied server-side by the reader. `userToken`, when given, is the
 * caller's own OAuth token, forwarded as the reader's per-call `options.token`.
 * Neither is ever logged or returned — the only egress is Backstage -> the SCM
 * host.
 *
 * `options.token` is honoured by the GitHub and GitLab readers and IGNORED by
 * every other one (verified; docs/MULTI-SCM-PLAN.md §1.4), so only providers
 * whose adapter opts in via `readTreeWithUserToken` should pass it. Passing it
 * to a reader that ignores it would read anonymously and look like success.
 *
 * A `readTree` response is single-consumption: `files()` is called exactly once
 * here, and callers wanting a second view must read again.
 */
export async function readTreeViaUrlReader(args: {
  reader: UrlReaderService;
  url: string;
  logger: LoggerService;
  userToken?: string;
}): Promise<ScmFileTree> {
  const { reader, url, logger, userToken } = args;
  logger.info(`Reading Bruno collection tree via UrlReader: ${url}`);
  const response = await reader.readTree(
    url,
    userToken ? { token: userToken } : undefined
  );
  const treeFiles = await response.files();

  const files: ScmFileTree = new Map();
  for (const file of treeFiles) {
    // `file.path` is relative to the tree root, and the reader has already
    // stripped both the archive root and the requested subpath.
    const rel = file.path.split('\\').join('/');
    if (isCollectionFile(rel)) {
      const buffer = await file.content();
      files.set(rel, buffer.toString('utf8'));
    }
  }
  return files;
}
