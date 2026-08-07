# N4-P2 — Entity-page card polish (LOCKED plan)

Repo: /Users/vasharma05_bruno/Projects/usebruno-backstage · Branch: feat/next-steps-runtime-connect
Backstage 1.53 (NEW frontend system) · Yarn 4 · MUI v4 (`@material-ui/core@4.12.4`).
Feature code only in `plugins/bruno` (frontend). No app tests.
All node_modules line anchors read against the installed packages listed below.

Installed versions (verified):
- `@backstage/plugin-catalog@2.0.7`
- `@backstage/plugin-catalog-react@3.2.0`
- `@backstage/frontend-app-api@0.16.6`
- `@material-ui/core@4.12.4` (`node_modules/@material-ui/core/package.json` `"version": "4.12.4"`)

Three changes, all on the API-catalog entity Overview page. All are presentation/ordering
only — no behavior/logic changes.

---

## Issue 5 — Put Collection Overview (README) card ABOVE Collection Tree card

### The ordering mechanism (definitive, with node_modules evidence)

Both bruno cards are `EntityCardBlueprint` extensions with `type` UNSET
(`plugins/bruno/src/extensions.tsx:44-51` tree, `:58-67` overview). In the installed blueprint the
ONLY card ordering-relevant param is `type?: 'info' | 'content'` — there is NO `priority`, `order`,
`area`, or card `group` param:
- `EntityCardBlueprint` params = `{ loader; filter?; type? }`
  (`node_modules/@backstage/plugin-catalog-react/dist/alpha.d.ts:104-108`); `EntityCardType = 'info' | 'content'`
  (`:96`). (The `group`/`contentOrder` machinery at `:57-94,153` belongs to entity *content*
  tabs, NOT cards.)

The default Overview page collects card extensions and renders them **in attachment order with NO
sort**:
1. `catalogOverviewEntityContent` declares a `cards` extension input and builds the card array as a
   plain `inputs.cards.map(...)` then `.filter(...)` — no `.sort`
   (`node_modules/@backstage/plugin-catalog/dist/alpha/entityContents.esm.js:16-21` input decl,
   `:56-63` map, `:73` filter).
2. The default layout `DefaultEntityContentLayout` splits by `type` into
   `infoCards`/`summaryCards`/`contentCards` and `.map`s each group preserving order — again no sort
   (`node_modules/@backstage/plugin-catalog/dist/alpha/DefaultEntityContentLayout.esm.js:110-116`
   split, `:145` contentCards map). Because both bruno cards have `type` UNSET they both fall into
   `contentCards` (`!card.type || card.type === 'content'`, `:114-116`) — same column, ordered purely
   by attachment order.

Attachment order = the order children are pushed onto the parent input's attachment array, which is
the order of the resolved extension spec list:
- `resolveAppTree` iterates `for (const node of nodes.values())` and `setParent` **pushes** each
  child into `parent.edges.attachments.get(input)` in that iteration order
  (`node_modules/@backstage/frontend-app-api/dist/tree/resolveAppTree.esm.js:16-24` setParent/push,
  `:60-65` nodes Map populated from `specs` in order, `:90-138` iteration).
- The spec list is `resolveAppNodeSpecs`'s `orderedExtensions`
  (`node_modules/@backstage/frontend-app-api/dist/tree/resolveAppNodeSpecs.esm.js:202-215`), built as:
  extensions named in `app.extensions` config **hoisted to the front in config order**
  (`:165-205`, the `order` Map from `parameters`), then all remaining extensions in **natural
  registration order** — which for a plugin is the `extensions:` array order
  (`:54-67` `plugins.flatMap(...internalPlugin.extensions.map...)`).
- `app.extensions` config maps 1:1 in array order to `parameters`
  (`node_modules/@backstage/frontend-app-api/dist/tree/readAppExtensionsConfig.esm.js:3-11,29`),
  each entry carrying an `id` (and optional `attachTo`/`disabled`/`config`).

Extension IDs are `${kind}:${namespace}/${name}` where namespace defaults to the pluginId `bruno`
(`node_modules/@backstage/frontend-plugin-api/dist/wiring/resolveExtensionDefinition.esm.js:6-13`
`resolveExtensionId`). So:
- tree card  → `entity-card:bruno/collection-tree`
- overview card → `entity-card:bruno/collection-overview`

**Conclusion:** card order IS deterministically controllable from plugin code alone. Because neither
bruno card appears in `app.extensions`, their relative order is exactly their order in the
`brunoPlugin` `extensions:` array (`plugins/bruno/src/plugin.ts:30-37`). Today that array lists
`brunoCollectionTreeCard` (`:33`) before `brunoCollectionOverviewCard` (`:34`), so the tree renders
above the overview. Swapping them fixes it. (`brunoCard` — `entity-card:bruno/collection`,
`extensions.tsx:30-37` — should stay FIRST so "Bruno Collection" remains the top card.)

### Primary change (plugin-only, MINIMAL) — reorder the array in plugin.ts

In `plugins/bruno/src/plugin.ts`, the `extensions:` array (`:30-37`), swap lines `:33` and `:34` so
the order becomes:

```
brunoApi,
brunoCard,
brunoCollectionOverviewCard,   // was line :34 — now before tree
brunoCollectionTreeCard,       // was line :33 — now after overview
brunoDocsContent,
brunoPage
```

Also update the two ordering-narrative comment lines (`plugin.ts:22-23`) to reflect that overview is
now registered before tree (comment only; no functional effect).

No other file changes are required for Issue 5. Do NOT set a card `type` — leaving both `type` unset
keeps both in the same `contentCards` column, which is what the ordering relies on. (Setting one to
`info` would move it into the separate right-hand `infoArea` column,
`DefaultEntityContentLayout.esm.js:112,134-135` — undesired.)

### Fallback (only if the array reorder proves unreliable in practice)

Add explicit `app.extensions` entries to hoist the two cards to the front of resolution in the
desired order. The existing `app.extensions` block is `app-config.yaml:8-12` (currently one entry,
`page:catalog`). Append the two card IDs in overview-before-tree order (thin config glue, allowed):

```yaml
app:
  extensions:
    - page:catalog:
        config:
          path: /
    - entity-card:bruno/collection-overview
    - entity-card:bruno/collection-tree
```

This works because `readAppExtensionsConfig` turns those bare-string entries into `parameters`
(`readAppExtensionsConfig.esm.js:29` `id: arrayEntry`) and `resolveAppNodeSpecs` hoists them to the
front of `orderedExtensions` in listed order (`resolveAppNodeSpecs.esm.js:165-205`). Note this
front-hoists them ahead of `brunoCard` too, so if the fallback is used, also add
`- entity-card:bruno/collection` as the FIRST of the three to keep "Bruno Collection" on top.
Prefer the plugin-only reorder; only fall back to YAML if a real render shows the array order not
taking effect.

---

## Issue 6 — Collection Tree Card: folders as expand/collapse accordions

File: `plugins/bruno/src/components/CollectionTree/CollectionTreeCard.tsx`.
Only the `CompactTree` function (`:39-79`) changes. `CollectionTreeCard` (`:88-167`), all data
fetching, the empty-state (`:158-161`), `InfoCard` usage (`:157`), and `MethodBadge` (`:69`) are
untouched.

### Confirmed MUI component set — use `Accordion`, NOT `ExpansionPanel`

`@material-ui/core@4.12.4` ships BOTH families, but `Accordion*` is the current (non-deprecated) set;
`ExpansionPanel*` is the pre-4.9 deprecated alias. Verified present:
- Component dirs exist: `Accordion/`, `AccordionSummary/`, `AccordionDetails/` (and
  `ExpansionPanel/` etc.) under `node_modules/@material-ui/core/`.
- Named exports exist in the barrel: `node_modules/@material-ui/core/index.d.ts:61-71`
  (`Accordion`, `AccordionActions`, `AccordionDetails`, `AccordionSummary`).
- Prop types confirmed:
  - `AccordionProps`: `defaultExpanded?: boolean`, `expanded?: boolean`,
    `onChange?`, `TransitionProps?` (`node_modules/@material-ui/core/Accordion/Accordion.d.ts`
    `defaultExpanded` doc + `AccordionProps` interface).
  - `AccordionSummary`: accepts `expandIcon?: React.ReactNode`
    (`node_modules/@material-ui/core/AccordionSummary/AccordionSummary.d.ts`, `expandIcon` in
    `AccordionSummaryTypeMap.props`).
  - `AccordionDetails`: `children` only (`node_modules/@material-ui/core/AccordionDetails/AccordionDetails.d.ts`).

Imports to ADD (default-import style, matching the file's existing per-component imports at `:6-12`):

```ts
import Accordion from '@material-ui/core/Accordion';
import AccordionSummary from '@material-ui/core/AccordionSummary';
import AccordionDetails from '@material-ui/core/AccordionDetails';
import ExpandMoreIcon from '@material-ui/icons/ExpandMore';
```

`@material-ui/icons/ExpandMore` is the standard MUI accordion chevron and is present in the icons
package used elsewhere (same icons package that supplies `FolderIcon` at `:11`,
`@material-ui/icons/Folder`). `FolderIcon` (`:11,53`) stays — it moves into the AccordionSummary next
to the folder name.

### Default expand state — TOP-LEVEL COLLAPSED

Recommendation: render every folder Accordion with `defaultExpanded={false}` (i.e. omit
`defaultExpanded`, MUI default is collapsed). Justification: the card is a compact read-only summary
in the entity Overview column; Bruno collections can be deep/wide, and defaulting everything expanded
reproduces today's fully-expanded wall while adding accordion chrome. Collapsed-by-default keeps the
card short and lets the reader drill in. This is an uncontrolled Accordion (`defaultExpanded`, no
`expanded`/`onChange` state) — no new React state, preserving the read-only, stateless nature.

### `CompactTree` rewrite approach (structure only — no code here)

Replace the folder branch (`:48-63`) so each folder renders as:

```
<Accordion  (key=id, uncontrolled, defaultExpanded omitted → collapsed,
             elevation={0}, TransitionProps={{ unmountOnExit: true }})>
  <AccordionSummary expandIcon={<ExpandMoreIcon fontSize="small" />}
                    className={classes.folderSummary}>
    <Box className={classes.folderRow}>            // existing folderRow class :32-36 reused
      <FolderIcon fontSize="small" color="action" />
      <Typography variant="body2"><strong>{item.name}</strong></Typography>
    </Box>
  </AccordionSummary>
  <AccordionDetails className={classes.folderDetails}>
    <CompactTree items={item.items} prefix={`${id}.`} />   // recursion preserved
  </AccordionDetails>
</Accordion>
```

- The request branch (`:65-74`) is UNCHANGED (still `ListItem` + `Box.requestRow` + `MethodBadge` +
  `ListItemText`).
- The outer `<List dense disablePadding>` (`:45`) stays as the container so a folder-and-request
  mixed level renders both accordions and list items in one list.
- Remove the old `<Box pl={2}>` indentation wrapper (`:59-61`) — indentation now comes from
  AccordionDetails padding (see styling), not manual `pl`.
- `TransitionProps={{ unmountOnExit: true }}` means collapsed folders do not mount their (recursive)
  children — this bounds the render cost of deep trees so nested accordions are only realized on
  expand.

### Styling (theme.spacing via the existing `useStyles`)

Extend the existing `makeStyles` object (`:26-37`, currently `requestRow` + `folderRow`) with:
- `accordion`: `{ boxShadow: 'none', '&:before': { display: 'none' }, background: 'transparent' }` —
  strips the default Paper elevation/divider so nested accordions don't stack shadows.
- `folderSummary`: `{ minHeight: 0, padding: 0, '& .MuiAccordionSummary-content': { margin: theme.spacing(0.5, 0) } }` —
  removes the ~48px default summary height so folder rows stay compact like today's `ListItem dense`.
- `folderDetails`: `{ display: 'block', padding: 0, paddingLeft: theme.spacing(2) }` — replaces the
  old `Box pl={2}` (`:59`) with a single controlled left indent and drops MUI's default 8px x /16px y
  details padding so nesting depth does not compound (avoids the deep-indent blowup called out in the
  brief). Use `theme.spacing(2)` per level (matches today's `pl={2}`).

Also set `elevation={0}` on the Accordion in addition to the `accordion` class (belt-and-braces
against the Paper shadow). Keep all spacing in `theme.spacing(...)` — no raw pixels.

### Keys

Keep the existing index-based composite key scheme: `id = `${prefix}${idx}`` (`:47`) with recursive
`prefix=`${id}.`` (`:60`). It is stable for a read-only, non-reordering tree and yields unique keys
per node path. Apply `key={id}` to the top-level `<Accordion>` (folder) and keep `key={id}` on the
request `<ListItem>` (as today, `:67`). No functional regression; no improvement needed given the
tree never mutates in place.

---

## Issue 7 — Backstage-theme consistency pass (SCOPED to the 3 card files only)

Audit limited to the three card files. `CollectionPickerFields` (rendered by BrunoCard at
`BrunoCard.tsx:185`) is SHARED with the dashboard LinkPanel and is OUT OF SCOPE — do not touch its
styling. Only style that lives inside the three card files is changed. Behavior/logic unchanged.

### `plugins/bruno/src/components/BrunoCard/BrunoCard.tsx`

Off-theme spots found:

1. **Inline pixel gap (Disconnect / Change-collection row).** `BrunoCard.tsx:263`
   `<Box display="flex" style={{ gap: 8 }}>`. Replace the hardcoded `style={{ gap: 8 }}` with a
   `makeStyles` class using `theme.spacing(1)` (8px == `theme.spacing(1)`). BrunoCard currently has
   NO `makeStyles`/`useStyles` (imports at `:1-16` have none) — add a minimal
   `const useStyles = makeStyles((theme) => ({ actionRow: { display: 'flex', gap: theme.spacing(1) } }))`
   plus `import { makeStyles } from '@material-ui/core/styles';`, and change `:263` to
   `<Box className={classes.actionRow}>` (drop the inline `display="flex"` too, now in the class).

2. **All-caps button labels `SCAN` and `LINK`.** `BrunoCard.tsx:204` (`LINK`) and `:221` (`SCAN`).
   These are shouty vs Backstage's sentence-case convention. Recommendation: sentence-case to `Scan`
   and `Link` for consistency with the sibling `Connect GitHub` (`:193,210`), `Disconnect` (`:264`),
   `Change collection` (`:278`) buttons — the copy stays meaningful and these are still the picker
   actions. Text-only change; no logic change. (MUI `Button` already uppercases visually via
   `textTransform` unless the app theme disables it; using sentence-case source keeps our copy
   consistent regardless and matches the other buttons.)

3. **Button labels already fine.** `Connect GitHub` (`:193,210`), `Disconnect` (`:264`),
   `Change collection` (`:278`) are already sentence case — leave as-is.

4. **Typography variants** in the connected block (`subtitle1` `:230`, `caption` `:237,245`,
   `h6` `:240`, `body2` `:248`) are standard MUI/Backstage InfoCard content variants — no change.
   `InfoCard` usage (`:158`) stays.

No other inline styles / rgba / hex in this file (the only inline `style` is `:263`).

### `plugins/bruno/src/components/CollectionTree/CollectionTreeCard.tsx`

- No hardcoded pixels, rgba, or hex: the two style classes already use `theme.spacing(1)` and
  `theme.spacing(0.5)` (`:26-37`). The new accordion classes from Issue 6 must likewise use
  `theme.spacing` (specified above) — do not introduce raw px.
- No all-caps labels; empty-state copy `No requests in this collection.` (`:159-160`) uses
  `variant="body2" color="textSecondary"` — on-theme, keep.
- `InfoCard title="Collection Tree"` (`:157`) — on-theme, keep.
- Net: Issue 7 adds nothing here beyond ensuring the Issue-6 accordion styles use `theme.spacing`.

### `plugins/bruno/src/components/CollectionOverview/CollectionOverviewCard.tsx`

- Fully clean: no inline styles, no colors, no makeStyles, no buttons. It is
  `InfoCard title="Collection Overview"` (`:98`) wrapping `MarkdownContent` (`:99`). No change needed
  for Issue 7. (Its only N4-P2 change is being moved above the tree via Issue 5's plugin.ts reorder —
  no edit to this file.)

### Issue 7 summary table

| File:line | Off-theme spot | Theme-aligned replacement |
|---|---|---|
| `BrunoCard.tsx:263` | `style={{ gap: 8 }}` inline px | `makeStyles` `actionRow` class, `gap: theme.spacing(1)` |
| `BrunoCard.tsx:204` | `LINK` all-caps label | `Link` (sentence case) |
| `BrunoCard.tsx:221` | `SCAN` all-caps label | `Scan` (sentence case) |
| CollectionTreeCard.tsx | (none pre-existing) | ensure new accordion styles use `theme.spacing` |
| CollectionOverviewCard.tsx | (none) | no change |

---

## Risk list & mitigations

1. **Ordering not taking effect from the array reorder.**
   Evidence (resolveAppTree push order + no-sort overview map) says plugin `extensions:` order
   controls it, but resolution order across features can be perturbed by future config. Mitigation:
   verify visually after the reorder; if wrong, apply the `app.extensions` YAML fallback (exact YAML
   above) which deterministically front-hoists in listed order.

2. **Card accidentally lands in the wrong column.** If someone sets `type: 'info'` on one card it
   jumps to the right-hand `infoArea` and the two cards no longer share a column, defeating the
   reorder (`DefaultEntityContentLayout.esm.js:112,134-135`). Mitigation: keep `type` UNSET on both
   cards (do not add it).

3. **MUI component-name mismatch (Accordion vs ExpansionPanel).** Resolved: `Accordion*` confirmed
   exported at `index.d.ts:61-71` in 4.12.4; use it (not the deprecated `ExpansionPanel*`). Import
   from the deep paths `@material-ui/core/Accordion` etc. to match the file's existing import style
   and keep tree-shaking.

4. **Accordion nesting / performance blowup on deep trees.** Nested `Accordion` inside
   `AccordionDetails` is supported but default details padding compounds per level and shadows stack.
   Mitigations: `folderDetails` sets a single `theme.spacing(2)` left indent + `padding: 0`;
   `accordion` class + `elevation={0}` strip shadows and the `&:before` divider;
   `TransitionProps={{ unmountOnExit: true }}` keeps collapsed subtrees unmounted so deep trees don't
   all render at once.

5. **Theme regressions in BrunoCard from adding makeStyles.** Adding a `useStyles` hook + class must
   not alter the connected/picking layouts. Mitigation: the class only encapsulates the exact
   `display:flex; gap:8px` currently inline at `:263`; scope the change to that one `Box`, leave all
   `Grid`/`spacing={2}` untouched. Verify the Disconnect/Change-collection row still sits on one line
   with an 8px gap.

6. **Sentence-casing buttons perceived as a copy change.** `SCAN`/`LINK` → `Scan`/`Link` is cosmetic
   and matches sibling buttons; if reviewers prefer preserving the shout, it is a 1-line revert with
   no logic impact. Left as a recommendation, not a hard requirement.

7. **Comment drift in plugin.ts.** After swapping `:33/:34`, the doc comment block (`:22-23`) would
   otherwise misdescribe order. Mitigation: update those comment lines in the same edit.
