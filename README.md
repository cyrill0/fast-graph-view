# Fast Graph View

A standalone alternative to Obsidian's graph view, built to stay responsive in vaults
where the built-in view drops to a slideshow. Its defining rule: **a folder holding more
than a configurable number of files (default 20) is drawn as one metadata node instead of
one node per note.** Everything else behaves the way the built-in graph view does — same
filters, same forces, same colour groups, same right-click menus, same hover preview rules,
familiar controls, its own saved configuration, and the same app language.

For a user-focused walkthrough, see the [Fast Graph View user guide](docs/USER_GUIDE.md).

## Build and install

```bash
pnpm install
pnpm build          # esbuild production bundle + tsc --noEmit
pnpm test           # unit & security regression tests
```

The plugin is the three files at the repository root: `main.js`, `styles.css`,
`manifest.json`. Copy them to `<vault>/.obsidian/plugins/fast-graph-view/` and enable
"Fast Graph View" in Settings → Community plugins. `pnpm watch` rebuilds on change.

### Publish a GitHub release

Set the same stable version in `manifest.json` and `package.json`, and map that version
directly to its minimum app-version string in `versions.json`. After committing those changes, push a matching tag
such as `v1.2.3`. GitHub Actions checks the version metadata, builds the plugin, and creates
a release with the three files Obsidian needs (`main.js`, `manifest.json`, and `styles.css`).
Run `pnpm check:release` before tagging to check the metadata locally.

For a ready-to-run local vault, use the checked-in `test-vault`:

```bash
pnpm install
pnpm build
pnpm deploy
```

Open `test-vault` in Obsidian, enable the plugin, and use the live development loop:

```bash
pnpm dev:vault
```

Launch Obsidian with `--remote-debugging-port=9223` for automatic plugin reloads after
each build. Set `OBSIDIAN_VAULT=/path/to/another/vault` to deploy to a different vault.

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
desktop Obsidian 1.14.4).

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

## Standalone Obsidian integration

Fast Graph View registers its own `fast-graph-view` and `fast-localgraph` view types through
Obsidian's public plugin API. It does not unregister, replace, or modify the built-in graph
plugin. The ribbon button and **Open clustered graph** command open the global view. The
**Open clustered local graph** command and Markdown file-menu entry open a local view rooted
on the selected note.

Graph and clustering options are saved in this plugin's `data.json`. Local graph options and
the fixed root file are saved in the leaf state, so restored local panes return to the same
note. The option names, ranges, and defaults intentionally remain familiar, but the plugin no
longer reads or writes the built-in plugin's private configuration.

## Interactions

Wheel zoom anchors under the cursor, drag pans, drag on a node pins it for the duration of
the drag and releases it on pointerup so it rejoins the layout — the same thing the built-in
view does, verified against its `forceNode` messages — plain click on a note opens it in the
same leaf with history that takes you back to the graph, `Ctrl`/`⌘`-click and middle-click
open a new tab, `Ctrl`/`⌘`+`Alt` splits, `Ctrl`/`⌘`+`Alt`+`Shift` opens a new window, tag
nodes filter the current graph to that tag, and the control panel — filter, colour groups,
display, forces — matches the native one including drag-to-reorder groups. Hovering a note
opens Obsidian's page preview through this plugin's registered hover source (`defaultMod`), so
plain hover dims the rest of the graph and Mod-held hover previews.

On Obsidian Mobile, a one-finger swipe pans, tapping a node opens it, a two-finger pinch zooms,
and a long press performs the node's context action. Colour groups can also be reordered with
touch. The view starts with a performance profile selected from the phone's available CPU,
memory (when the WebView reports it), screen size and pixel density, then watches actual frame
cost. If a low-end Android device or iPhone falls behind, it quickly reduces labels, arrows,
canvas resolution, physics frequency and worker-to-screen updates. Quality comes back only
after a longer stable period, preventing visible oscillation. Pan and pinch temporarily use an
even cheaper profile, while an emergency topology budget is reserved as the final fallback.

These reductions apply only to the open mobile view. They never overwrite desktop graph
settings. Folder folding stays enabled on mobile even if disabled in the saved desktop settings.
Initial vault indexing is shared by all graph panes and deferred until the pane has painted its
controls and loading indicator. Physics pauses while Obsidian is in the background and resumes
on return; orientation changes and recoverable WebGL context loss rebuild the canvas safely.

Search supports the operators the native graph has: `"exact"`, `tag:`/`#`, `path:`/`folder:`,
`file:`/`name:`, `ext:`, `link:`/`to:`, `backlink:`/`from:`, `is:orphan`, and `-` negation,
plus `is:cluster` for this plugin's folder nodes.

## Design decisions

Deliberate departures from the built-in view, and why:

- **Timelapse advances by note count**, not by calendar continuity. Core's animation
  interpolates over creation dates; here the step count is derived from the link count, so
  the budget is spent on visible motion rather than on empty date gaps. Core's reveal has
  no stop path at all — `Escape` does nothing and Animate only restarts it. Here the start
  control *is* the stop control while the reveal runs: Animate becomes Stop under Display,
  the collapsed panel's wand becomes a square, `Escape` halts it, and a
  `Stop graph timelapse animation` command joins the palette for exactly as long as there is
  something to halt, so it can be bound to a hotkey. It also ends when every note has been
  shown.
- **No body-text or property search operators.** Links come from `metadataCache`, which
  does not index search over content; adding it would mean reading every file, which is the
  thing this plugin exists to avoid.
- **The UI language is Obsidian's, with no picker of its own.** Catalogues for English,
  German, French, Spanish, Italian, Brazilian Portuguese, Russian, Polish, Japanese,
  Simplified Chinese and Korean ship inside `main.js`, so the three-file install contract is
  unchanged and the panel, settings tab, hover card, status line, commands and canvas folder
  labels all follow the app language. Counts are pluralised per language through
  `Intl.PluralRules`, which matters for Russian and Polish and for French treating zero as
  singular. A traditional-Chinese Obsidian falls back to English rather than to Simplified,
  since the two are not interchangeable scripts. The few diagnostics interpolated into a
  fallback status message — a WebGL failure reason, a worker crash — stay in English, as does
  any exception text the browser itself supplies.
- **No inline search autocomplete and no `is-loading` spinner** in the filter field. The
  model rebuild is 42 ms at 27k notes, which is not a wait worth a spinner.
- **Panel sections snap collapsed/expanded** instead of animating their height.
- `theme-dark`/`theme-light` is read from the `body` class, matching how the native view
  picks its palette.
- **Options are per-view clones** of the global settings, exactly as core does it, so
  changing forces in one graph leaf does not move another.
- **The status line and the cluster hover card are additions** with no native equivalent.
- **Drawn labels are cut to `maxLabelChars` (default 24)**, which native does not do. A vault
  whose median title is 37 characters — and whose unresolved links are labelled with their
  whole linktext, path included — otherwise overlaps 900 px strings across the graph. Only the
  canvas sees the cut: filters, node identity, hover preview and the file menu keep the full
  label, and the hovered node is always drawn whole. `0` turns shortening off.
- `isModEvent` is reimplemented locally as `modEventPaneType` (the helper is not exported).
- **Zoom and pan persist when the loop idles**, not on every frame — one write per settle.
- **A restored local-graph leaf falls back to the active file only when its saved state
  carries no `file`**, so reopening a saved local graph does not silently re-root.
- **Hover preview on a note requires the Mod key** because this plugin registers its hover
  source with `defaultMod: true`; plain hover only emphasizes graph neighbors.
- Folders are the only aggregation. Tags and unresolved links are capped by count, not
  folded, because they have no natural hierarchy to fold along.

## Development tools

`tools/` is a verification harness, not part of the plugin — it is not bundled.
`tools/obs-cdp.mjs` drives the running Obsidian renderer over the DevTools protocol
(`--remote-debugging-port=9223`) with trusted `Input` events, and `tools/harness/*.mjs`
are the scenarios it runs: `trusted.mjs` (hover, click, right-click, wheel, pan, node drag,
idle-loop, click navigation), `panel.mjs` (control panel), `local.mjs` (local graph),
`standalone.mjs` (standalone registration and teardown), and `crash-watch.mjs` (renderer reload journaling).

The instance has to be launched so that it keeps producing frames while another window is on
top of it — otherwise Chromium stops its frame sink, `requestAnimationFrame` freezes, and
every timing measurement in a scenario reads as starvation rather than as behaviour:

```bash
flatpak run md.obsidian.Obsidian \
  --user-data-dir=<harness profile> --remote-debugging-port=9223 \
  --disable-backgrounding-occluded-windows --disable-renderer-backgrounding \
  --disable-background-timer-throttling --disable-features=CalculateNativeWinOcclusion
```

## License

[MIT](LICENSE)
