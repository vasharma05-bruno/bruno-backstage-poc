import { buildCloneInstruction } from './brunoLink';

/** The trailing line, which differs only in which folder it points the user at. */
const OPEN_CLONED = '# then in Bruno: Open Collection -> select the cloned folder';
const OPEN_THAT = '# then in Bruno: Open Collection -> select that folder';

/**
 * The instruction is COPIED AND PASTED into a shell, so it is asserted whole
 * rather than per-line: a `cd` that is right about the folder and wrong about
 * the level above it still fails, and only the exact three lines prove the
 * sequence runs.
 *
 * The target is `<cloned dir>/<collection path>` and not the repo-relative path
 * on its own, because `git clone` leaves the user in the PARENT of the
 * directory it created.
 */
describe('buildCloneInstruction', () => {
  it.each([
    [
      'a GitHub tree URL with a nested subpath',
      'https://github.com/acme/repo/tree/main/apis/payments',
      `git clone https://github.com/acme/repo.git\ncd 'repo/apis/payments'\n${OPEN_THAT}`
    ],
    [
      'a GitLab URL, past the `/-/` separator and its arbitrary-depth namespace',
      'https://gitlab.com/group/subgroup/project/-/tree/main/collections/orders',
      `git clone https://gitlab.com/group/subgroup/project.git\ncd 'project/collections/orders'\n${OPEN_THAT}`
    ],
    [
      'a Bitbucket URL, whose in-repo view segment is `src`',
      'https://bitbucket.org/team/repo/src/main/collections/orders',
      `git clone https://bitbucket.org/team/repo.git\ncd 'repo/collections/orders'\n${OPEN_THAT}`
    ],
    [
      // Percent-decoded by `collectionPathFromUrl`, so the real space reaches
      // the shell — and the quoting is the only thing keeping `cd` from
      // receiving two arguments.
      'a folder whose name contains a space',
      'https://github.com/acme/repo/tree/main/my%20collection',
      `git clone https://github.com/acme/repo.git\ncd 'repo/my collection'\n${OPEN_THAT}`
    ]
  ])('cds into the collection folder for %s', (_case, url, expected) => {
    expect(buildCloneInstruction(url)).toBe(expected);
  });

  /**
   * The unchanged cases, and the reason this half of the table exists at all: a
   * collection that IS its repository is already where the clone leaves the
   * user, and an input that cannot be reduced to a repository root has no
   * directory name to `cd` into. Both must still emit the single-line
   * instruction they emitted before the subpath was added.
   */
  it.each([
    [
      'a bare repository root',
      'https://github.com/acme/repo',
      `git clone https://github.com/acme/repo.git\n${OPEN_CLONED}`
    ],
    [
      'a tree URL with a ref but no path below it',
      'https://github.com/acme/repo/tree/main',
      `git clone https://github.com/acme/repo.git\n${OPEN_CLONED}`
    ],
    [
      // `repoRootFromCollectionUrl` hands back its input here, so `.git` is
      // never appended and the user is shown what they gave us rather than a
      // fabricated URL.
      'an input that is not a URL at all',
      'not a url',
      `git clone not a url\n${OPEN_CLONED}`
    ]
  ])('leaves the instruction as it was for %s', (_case, url, expected) => {
    expect(buildCloneInstruction(url)).toBe(expected);
  });
});
