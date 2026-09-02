import type {
  LoggerService,
  UrlReaderService
} from '@backstage/backend-plugin-api';
import { selectCollectionFiles } from './treeFilter';
import type { ScmFileTree } from './types';

/** A tree read together with the reader's identity for it. */
export interface ScmTreeRead {
  files: ScmFileTree;
  /** The reader's tree identity — the commit sha for all three providers.
   *  Feed it back as `etag` to get a NotModifiedError instead of a download. */
  etag: string;
}

/**
 * Reads a collection tree through Backstage's `UrlReaderService`, keeping only
 * the files the parser needs.
 *
 * Credential isolation: the ONLY credential is the host's `integrations.*`
 * config, applied server-side by the reader. There is deliberately no parameter
 * for a caller's own OAuth token — see `scm/types.ts` — so nothing here can be
 * made to authenticate as a user, and the only egress is Backstage -> the SCM
 * host. The credential is never logged or returned.
 *
 * Passing `etag` turns the call into a revalidation: when the target's tree
 * identity still matches, the reader throws `NotModifiedError` BEFORE
 * downloading the tarball. That error PROPAGATES to the caller — it is the cheap
 * path, not a failure, and the caller is expected to catch it and keep its
 * cached copy.
 *
 * Be precise about what "cheap" means here, because it is easy to over-read.
 * This etag is a CLIENT-SIDE commit-sha compare, not an HTTP 304: the reader
 * spends 1-2 API calls (2 on GitLab) resolving the sha before it can compare.
 * It saves the DOWNLOAD and the parse, and no rate-limit quota at all. The
 * quota-free check is `ScmProvider.checkTreeIdentity`, which `manifestProbe`
 * runs in front of this.
 *
 * A `readTree` response is single-consumption: `files()` is called exactly once
 * here, and callers wanting a second view must read again.
 */
export async function readTreeWithEtag(args: {
  reader: UrlReaderService;
  url: string;
  logger: LoggerService;
  etag?: string;
}): Promise<ScmTreeRead> {
  const { reader, url, logger, etag } = args;
  // A revalidation is still a warm path — reached whenever the probe's
  // conditional request could not answer — so it must not be an info line. A
  // cold read is the rare, expensive one and stays at info; it is also what
  // boot check 5 counts to prove the cache is doing its job.
  if (etag) {
    logger.debug(`Revalidating Bruno collection tree (ETag): ${url}`);
  } else {
    logger.info(`Reading Bruno collection tree via UrlReader: ${url}`);
  }
  const response = await reader.readTree(url, etag ? { etag } : undefined);
  const treeFiles = await response.files();

  // `file.path` is relative to the tree root, and the reader has already
  // stripped both the archive root and the requested subpath.
  const byPath = new Map(
    treeFiles.map((file) => [file.path.split('\\').join('/'), file])
  );

  // Admission is set-aware (a bare `.yaml` is only a collection file below an
  // `opencollection.yaml`), and the returned order is sorted — which is what
  // makes the generated definition byte-stable across reads.
  const files: ScmFileTree = new Map();
  for (const rel of selectCollectionFiles(byPath.keys())) {
    const buffer = await byPath.get(rel)!.content();
    files.set(rel, buffer.toString('utf8'));
  }
  return { files, etag: response.etag };
}
