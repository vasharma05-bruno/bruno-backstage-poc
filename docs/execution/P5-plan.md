# P5 — Bruno entries in the entity Links card (PROVIDER-side) — Execution Plan (LOCKED)

> Scope: **`plugins/bruno-backend/src/provider/BrunoEntityProvider.ts` only.** No tests. No frontend changes. No new catalog processor (that's NEXT-STEPS-2). No cross-plugin import. Minimal diff; match existing style.
>
> Validated by the orchestrator against the tree: `buildEntity` (:79-119), annotations block (:89-97) with the `if (source.type === 'url')` guard (:95-97), metadata literal (:102-110), `ApiEntity` imported from `@backstage/catalog-model` (:3), full-mutation `type:'full'` rebuild each tick (no dedup needed). Deep-link format in `plugins/bruno/src/lib/brunoLink.ts:31-34` = `bruno://open?url=${encodeURIComponent(sourceUrl)}` (replicate, do not import).

## Locked decisions
1. **B1** — always set `metadata.links` (empty array for `local` sources; `EntityLinksCard` renders nothing for `[]`).
2. **Consolidate** the link construction into the existing `if (source.type === 'url')` block (:95-97) — same guard as the `bruno.dev/source-url` annotation. Local sources get no links (their `target` is a filesystem path).
3. Two links for `url` sources: `{ url: brunoDeepLink(source.target), title: 'Open in Bruno', icon: 'code' }` and `{ url: source.target, title: 'Bruno collection (source)', icon: 'github' }`.
4. **Backend-local helper** `brunoDeepLink(sourceUrl)` at the file bottom (next to `sanitizeName`), with a comment cross-referencing `plugins/bruno/src/lib/brunoLink.ts` so the format stays in sync. No import from the frontend plugin.
5. `EntityLink` added to the existing `import type { ApiEntity } from '@backstage/catalog-model'` (:3).

## Exact changes to `BrunoEntityProvider.ts`
- **Import (:3):** `import type { ApiEntity, EntityLink } from '@backstage/catalog-model';`
- **Inside `buildEntity`**, declare `const links: EntityLink[] = [];` alongside `annotations`, and inside the existing `if (source.type === 'url')` block (:95-97) also push the two links:
  ```ts
  if (source.type === 'url') {
    annotations['bruno.dev/source-url'] = source.target;
    links.push({
      url: brunoDeepLink(source.target),
      title: 'Open in Bruno',
      icon: 'code'
    });
    links.push({
      url: source.target,
      title: 'Bruno collection (source)',
      icon: 'github'
    });
  }
  ```
- **metadata literal (:102-110):** add `links,` (after `tags`).
- **Helper (file bottom, near `sanitizeName`):**
  ```ts
  // Mirrors buildBrunoDeepLink in plugins/bruno/src/lib/brunoLink.ts — keep the
  // format (scheme `bruno`, verb `open`, encoded `url` param) in sync.
  function brunoDeepLink(sourceUrl: string): string {
    return `bruno://open?url=${encodeURIComponent(sourceUrl)}`;
  }
  ```

## Out of scope / documented limitation
Runtime-connected (externally-owned) entities cannot be annotated by this `type:'full'` provider (R5); their Bruno links require the NEXT-STEPS-2 catalog processor — **not built here**. Until then, only provider-materialized (config `bruno.sources[]`) entities show Bruno links. `bruno://open` desktop verb is aspirational (Q3/G7) — the link is still a useful source pointer.

## Executor watch-list
- Empty `links` for local sources; do not build an "Open in Bruno" link from a filesystem path.
- Verify: `yarn workspace @usebruno/bruno-backend-plugin-poc build`. No tests.
