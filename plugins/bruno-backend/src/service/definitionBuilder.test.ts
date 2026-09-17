/**
 * The determinism contract of `spec.definition`, which nothing else can see.
 *
 * `DefaultCatalogProcessingEngine` decides whether to write a processed entity
 * by hashing `stableStringify(completedEntity)` and comparing it with the
 * stored `result_hash`. `stableStringify` sorts object KEYS but PRESERVES ARRAY
 * ORDER, so two things here are load-bearing and neither is visible to a
 * typecheck: the generated YAML bytes, and the order of `spec.environments`.
 * If either moves for the same input — between two replicas, between two Node
 * builds, or between two runs — every Bruno entity in every adopter's catalog
 * is rewritten and re-stitched every 100-150 seconds, forever and silently.
 * That is R8 in `docs/TECHNICAL-DESIGN.md` §14.2.
 *
 * The golden document is the half of this that a self-comparison cannot catch:
 * a converter upgrade or a `js-yaml` bump can move the bytes without any change
 * of ours, and the golden is what surfaces that at review time rather than in
 * an adopter's database.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import type { LoggerService } from '@backstage/backend-plugin-api';
import { selectCollectionFiles } from '../scm/treeFilter';
import { compareEnvironmentNames } from './collectionParser';
import { buildDefinition } from './definitionBuilder';

const FIXTURE_DIR = join(__dirname, '__fixtures__', 'checkout-collection');
const GOLDEN_PATH = join(
  __dirname,
  '__fixtures__',
  'checkout-collection.definition.yaml'
);

const COLLECTION_URL
  = 'https://github.com/acme/collections/tree/main/checkout';

/** The whole point of the fixture: these four sort one way by code unit and
 *  another way under every locale collation. See `compareEnvironmentNames`. */
const ENVIRONMENTS_IN_CODE_UNIT_ORDER = [
  'Dev-EU',
  'dev',
  'développement',
  'staging'
];

function silentLogger(): LoggerService {
  const logger: LoggerService = {
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
    child: () => logger
  };
  return logger;
}

/** Every file under the fixture, as repo-relative POSIX paths. */
function fixturePaths(dir: string = FIXTURE_DIR): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      out.push(...fixturePaths(abs));
    } else {
      out.push(relative(FIXTURE_DIR, abs).split('\\').join('/'));
    }
  }
  return out;
}

/**
 * Builds the tree the way `scm/readTree.ts` does — admission and ORDER both
 * decided by `selectCollectionFiles`, never by the order the paths arrived in.
 * `paths` is the arrival order, which is what the caller varies.
 */
function treeFrom(paths: string[]): Map<string, string> {
  const tree = new Map<string, string>();
  for (const rel of selectCollectionFiles(paths)) {
    tree.set(rel, readFileSync(join(FIXTURE_DIR, rel), 'utf8'));
  }
  return tree;
}

function build(paths: string[] = fixturePaths()) {
  return buildDefinition({
    tree: treeFrom(paths),
    url: COLLECTION_URL,
    logger: silentLogger(),
    options: { maxBytes: 1048576 }
  });
}

/**
 * Compares against the committed golden, or rewrites it when the operator
 * asked for that explicitly. Regeneration is deliberate and reviewable: the
 * diff it produces IS the change to the bytes stored on every Bruno entity.
 */
function expectMatchesGolden(actual: string): void {
  if (process.env.UPDATE_GOLDEN) {
    writeFileSync(GOLDEN_PATH, actual, 'utf8');
    return;
  }
  const expected = readFileSync(GOLDEN_PATH, 'utf8');
  if (actual === expected) {
    return;
  }
  const actualLines = actual.split('\n');
  const expectedLines = expected.split('\n');
  let i = 0;
  while (
    i < actualLines.length
    && i < expectedLines.length
    && actualLines[i] === expectedLines[i]
  ) {
    i++;
  }
  throw new Error(
    'The generated OpenCollection definition no longer matches '
    + '`__fixtures__/checkout-collection.definition.yaml`.\n\n'
    + `First divergence at line ${i + 1}:\n`
    + `  golden:    ${JSON.stringify(expectedLines[i])}\n`
    + `  generated: ${JSON.stringify(actualLines[i])}\n\n`
    + 'If NOTHING in this repo changed, a dependency bump (@usebruno/converters,\n'
    + '@usebruno/lang, js-yaml) has silently moved the bytes stored on every\n'
    + 'Bruno entity — every one of them will be rewritten and re-stitched on the\n'
    + 'next reprocess cycle.\n\n'
    + 'If the change IS intended, regenerate the golden and review its diff as\n'
    + 'part of the change:\n\n'
    + '  UPDATE_GOLDEN=1 yarn test --watchAll=false '
    + '--testPathPatterns definitionBuilder\n'
  );
}

describe('buildDefinition byte stability', () => {
  it('produces byte-identical output from two independent generations', () => {
    const first = build();
    const second = build();

    expect(first.definition).toBeDefined();
    // `toBe`, not `toEqual`: object equality would pass on two YAML documents
    // that differ in whitespace, and whitespace is exactly what the catalog
    // hashes.
    expect(second.definition).toBe(first.definition);
  });

  it('matches the committed golden document', () => {
    expectMatchesGolden(build().definition!);
  });

  it('carries no exportedAt stamp', () => {
    const { definition } = build();

    expect(definition).not.toContain('exportedAt');
    // The sibling key is present, which is what makes the assertion above
    // meaningful rather than vacuous — the extensions block really is emitted.
    expect(definition).toContain('exportedUsing: bruno-for-backstage');
  });

  it('is unaffected by the order the tree entries arrive in', () => {
    const paths = fixturePaths();
    const shuffled = [...paths].reverse();
    expect(shuffled).not.toEqual(paths);

    // Not an assumption about `Map` — `selectCollectionFiles` is what imposes
    // the order, and `scm/readTree.ts` routes the one remote read through it.
    // Item order within a folder otherwise falls back to insertion index.
    expect(build(shuffled).definition).toBe(build(paths).definition);
  });
});

describe('compareEnvironmentNames', () => {
  it('orders the fixture environments by code unit', () => {
    const shuffled = ['staging', 'développement', 'Dev-EU', 'dev'];

    expect([...shuffled].sort(compareEnvironmentNames)).toEqual(
      ENVIRONMENTS_IN_CODE_UNIT_ORDER
    );
  });

  it('does not agree with locale collation, which is the whole point', () => {
    // A regression to `localeCompare` would make this order locale-dependent.
    // Both locales are asserted rather than one because a small-icu Node folds
    // every locale onto `en-US`: the test then still holds, instead of passing
    // for the wrong reason on one build and failing on another.
    for (const locale of ['en-US', 'de-DE']) {
      const collated = [...ENVIRONMENTS_IN_CODE_UNIT_ORDER].sort(
        new Intl.Collator(locale).compare
      );
      expect(collated).not.toEqual(ENVIRONMENTS_IN_CODE_UNIT_ORDER);
    }
  });

  it('is a total order — antisymmetric and reflexive', () => {
    expect(compareEnvironmentNames('dev', 'dev')).toBe(0);
    expect(compareEnvironmentNames('Dev-EU', 'dev')).toBeLessThan(0);
    expect(compareEnvironmentNames('dev', 'Dev-EU')).toBeGreaterThan(0);
  });

  it('is what the built definition actually reports', () => {
    expect(build().environments).toEqual(ENVIRONMENTS_IN_CODE_UNIT_ORDER);
  });
});
