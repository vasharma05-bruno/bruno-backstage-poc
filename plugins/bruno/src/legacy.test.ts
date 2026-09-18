import fs from 'fs';
import path from 'path';

/**
 * Module specifiers that must never appear in the `./legacy` entry point's
 * module graph.
 *
 * Both belong to the NEW frontend system. A legacy app importing
 * `@usebruno/bruno-plugin-poc/legacy` must not be handed blueprints, extension
 * registration or the new system's routing — and the way that leaks back in is
 * not a deliberate decision but an innocent-looking `import { X } from
 * '../../extensions'` added years later, which drags every blueprint in this
 * plugin behind it.
 *
 * Note what this does NOT claim. `@backstage/core-plugin-api` itself depends on
 * (and re-exports from) `@backstage/frontend-plugin-api`, so the package cannot
 * be absent from the built bundle and this is not a bundle-size assertion. What
 * it asserts is a SOURCE property: nothing a legacy consumer reaches writes
 * against the new system's API, and in particular nothing reaches `plugin.ts`
 * or `extensions.tsx`.
 */
const FORBIDDEN = [
  '@backstage/frontend-plugin-api',
  '@backstage/plugin-catalog-react/alpha'
];

/** Every `from '…'`, `import('…')` and bare `import '…'` specifier in a file. */
function specifiersOf(source: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s+['"]([^'"]+)['"]/g
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      found.add(match[1]);
    }
  }
  return [...found];
}

/**
 * Resolves a relative specifier the way TypeScript would, trying the bare path
 * and then the directory's index. Returns undefined for anything unresolvable,
 * which is a real possibility only for asset imports — the walk is over the
 * plugin's own sources, where a miss would otherwise silently shrink the graph.
 */
function resolveRelative(fromFile: string, specifier: string): string {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx')
  ];
  const resolved = candidates.find(
    (candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()
  );
  if (!resolved) {
    throw new Error(
      `Unresolvable relative import '${specifier}' from ${fromFile}`
    );
  }
  return resolved;
}

/** The transitive closure of relative imports reachable from `entry`. */
function moduleGraph(entry: string): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (graph.has(file)) {
      continue;
    }
    const specifiers = specifiersOf(fs.readFileSync(file, 'utf8'));
    graph.set(file, specifiers);
    for (const specifier of specifiers) {
      if (specifier.startsWith('.')) {
        queue.push(resolveRelative(file, specifier));
      }
    }
  }
  return graph;
}

describe('the ./legacy entry point', () => {
  const entry = path.join(__dirname, 'legacy.ts');
  const graph = moduleGraph(entry);

  it('reaches enough of the plugin for this guard to mean anything', () => {
    // A resolution bug that walked nothing would make every assertion below
    // pass. The entry point pulls in the dashboard, the API entity card and
    // three Bruno entity cards, so the real closure is dozens of files deep.
    expect(graph.size).toBeGreaterThan(20);
  });

  it.each(FORBIDDEN)('never imports %s', (forbidden) => {
    const offenders = [...graph]
      .filter(([, specifiers]) => specifiers.includes(forbidden))
      .map(([file]) => path.relative(__dirname, file));
    expect(offenders).toEqual([]);
  });

  it('never reaches the new frontend system registration layer', () => {
    const registration = ['plugin.ts', 'extensions.tsx', 'api/extension.ts'];
    const reached = [...graph.keys()]
      .map((file) => path.relative(__dirname, file))
      .filter((file) => registration.includes(file));
    expect(reached).toEqual([]);
  });
});
