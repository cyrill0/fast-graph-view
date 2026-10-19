# Fast Graph View

A from-scratch replacement for Obsidian's graph view, built to stay responsive in vaults
where the built-in view drops to a slideshow. Its defining rule: **a folder holding more
than a configurable number of files (default 20) is drawn as one metadata node instead of
one node per note.** Everything else behaves the way the built-in graph view does — same
filters, same forces, same colour groups, same right-click menus, same hover preview rules,
same saved configuration.

## Build and install

```bash
pnpm install
pnpm build          # esbuild production bundle + tsc --noEmit
```

The plugin is the three files at the repository root: `main.js`, `styles.css`,
`manifest.json`. Copy them to `<vault>/.obsidian/plugins/fast-graph-view/` and enable
"Fast Graph View" in Settings → Community plugins. `pnpm watch` rebuilds on change.

## Why it is fast

| Layer | What it does |
| --- | --- |
| `src/graph/source.ts` | Reads links out of `metadataCache` only. No file is ever read from disk, so a cold build costs one pass over cached frontmatter/link lists. |
| `src/graph/build.ts` | Produces a structure-of-arrays model (`Float32Array` positions, `Int32Array` kinds/paths, CSR adjacency). Nothing per-node is allocated while drawing. |
| `src/layout/*` | Barnes-Hut force simulation running in a blob worker, with an inline time-sliced fallback when workers are unavailable. The main thread receives position buffers and never touches the quadtree. |
| `src/render/renderer.ts` | One WebGL2 instanced draw call per primitive: SDF discs for nodes, segments for links, arrowheads, selection rings. Labels are a separate 2D overlay that only redraws when the visible set changes. |
| `src/view/engine.ts` | The frame loop stops. Once the layout alpha is under `0.001` and 60 frames have painted nothing, `requestAnimationFrame` is unscheduled; the next wheel, pointer or filter event wakes it. Idle cost is zero, not 60 fps of nothing. |

Measured on a 27,266-note vault: **1,546 drawn nodes · 4,795 links · 24 folder clusters
holding 26,942 notes, model build 42 ms, one frame 0.4–0.5 ms** (status line of the view,
takeover mode, desktop Obsidian 1.14.4).

## Folder aggregation

Folders over the threshold collapse to a single node sized by what it stands for, labelled
`<name> (<count>)`. Hovering one shows a card with the rolled-up numbers: files here and
below, links in, links out, internal links that are not drawn, and total size.

- **Left click** reveals a batch of that folder's notes (25 at a time) and re-heats the
  layout; the graph leaf stays open.
- **Right click** folds it back. It does not open the file menu — a cluster is not a file.
- **Budget folding**: `maxVisibleNodes` (default 2,500) is a hard ceiling. After the
  threshold rule, the heaviest remaining folders fold until the drawn node count fits, so a
  100k-note vault still opens.
- **Modes**: `direct` counts files immediately in the folder; `recursive` counts the whole
  subtree, which is the better rule for deeply nested vaults.
- Tag and unresolved nodes are capped separately (`maxMetadataNodes`, default 1,200) — in a
  large vault those are the other two ways a graph becomes unreadable.

## Taking over the built-in view

`takeover` (on by default) re-registers the `graph` and `localgraph` view creators, the
ribbon icon, the command palette entries and the "Open in graph view" file-menu items, so
every existing keybinding, ribbon click and internal link into the graph lands here. Turning
it off puts the core plugin's creators back untouched.

Flipping that toggle while panes are open re-registers those panes under the type that is valid
in the new mode - ours when takeover goes off, the core types when it comes back on - so nothing
is left behind as a placeholder the next start cannot restore.

Configuration is interchangeable: the graph options use the core plugin's keys, ranges and
defaults verbatim, so `.obsidian/graph.json` written by the built-in view reads straight
into this plugin, and per-leaf state (zoom, pan, filters) round-trips through the same
`setState` shape. The clustering options are ours and live in the plugin's `data.json`.

Local graph works the same way it does natively — rooted on the active file, following
backlinks/forelinks/interlinks, `localJumps` depth, pinned leaves keep their root — with
clustering applied inside it too (`clusterLocalGraphs`).

## Interactions

Wheel zoom anchors under the cursor, drag pans, drag on a node pins it for the duration of
the drag and releases it on pointerup so it rejoins the layout — the same thing the built-in
view does, verified against its `forceNode` messages — plain click on a note opens it in the
same leaf with history that takes you back to the graph, `Ctrl`/`⌘`-click and middle-click
open a new tab, `Ctrl`/`⌘`+`Alt` splits, `Ctrl`/`⌘`+`Alt`+`Shift` opens a new window, tag
nodes open a tag search, and the control panel — filter, colour groups, display, forces —
matches the native one including drag-to-reorder groups. Hovering a note opens the core page
preview under the same modifier rule the core plugin registers for its own graph
(`defaultMod`), so plain hover dims the rest of the graph and Mod-held hover previews.

Search supports the operators the native graph has: `"exact"`, `tag:`/`#`, `path:`/`folder:`,
`file:`/`name:`, `ext:`, `link:`/`to:`, `backlink:`/`from:`, `is:orphan`, and `-` negation,
plus `is:cluster` for this plugin's folder nodes.

## Design decisions

Deliberate departures from the built-in view, and why:

- **Timelapse advances by note count**, not by calendar continuity. Core's animation
  interpolates over creation dates; here the step count is derived from the link count, so
  the budget is spent on visible motion rather than on empty date gaps. Neither core nor
  this view has a stop control: `Escape` does nothing, and pressing Animate again restarts
  the reveal from the first note. It ends when every note has been shown.
- **No body-text or property search operators.** Links come from `metadataCache`, which
  does not index search over content; adding it would mean reading every file, which is the
  thing this plugin exists to avoid.
- **Hardcoded English** UI strings. No locale catalogues are shipped.
- **No inline search autocomplete and no `is-loading` spinner** in the filter field. The
  model rebuild is 42 ms at 27k notes, which is not a wait worth a spinner.
- **Panel sections snap collapsed/expanded** instead of animating their height.
- `theme-dark`/`theme-light` is read from the `body` class, matching how the native view
  picks its palette.
- **Options are per-view clones** of the global settings, exactly as core does it, so
  changing forces in one graph leaf does not move another.
- **The status line and the cluster hover card are additions** with no native equivalent.
- `isModEvent` is reimplemented locally as `modEventPaneType` (the helper is not exported).
- **Zoom and pan persist when the loop idles**, not on every frame — one write per settle.
- **A restored local-graph leaf falls back to the active file only when its saved state
  carries no `file`**, so reopening a pinned local graph does not silently re-root.
- **Hover preview on a note requires the Mod key**, because core registers the `graph`
  hover source with `defaultMod: true`. Plain hover is not a preview in either view.
- Folders are the only aggregation. Tags and unresolved links are capped by count, not
  folded, because they have no natural hierarchy to fold along.

## Development tools

`tools/` is a verification harness, not part of the plugin — it is not bundled.
`tools/obs-cdp.mjs` drives the running Obsidian renderer over the DevTools protocol
(`--remote-debugging-port=9223`) with trusted `Input` events, and `tools/harness/*.mjs`
are the scenarios it runs: `trusted.mjs` (hover, click, right-click, wheel, pan, node drag,
idle-loop, click navigation), `panel.mjs` (control panel), `local.mjs` (local graph),
`standalone.mjs` (running without the takeover of the built-in view, and the listener and
worker teardown when the plugin is disabled), `crash-watch.mjs` (renderer reload journaling),
plus the older perf/probe scripts.

The instance has to be launched so that it keeps producing frames while another window is on
top of it — otherwise Chromium stops its frame sink, `requestAnimationFrame` freezes, and
every timing measurement in a scenario reads as starvation rather than as behaviour:

```bash
flatpak run md.obsidian.Obsidian \
  --user-data-dir=<harness profile> --remote-debugging-port=9223 \
  --disable-backgrounding-occluded-windows --disable-renderer-backgrounding \
  --disable-background-timer-throttling --disable-features=CalculateNativeWinOcclusion
```

