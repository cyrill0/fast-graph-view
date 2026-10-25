# Fast Graph View

A standalone alternative to Obsidian's graph view, built to stay responsive in vaults where the built-in view drops to a slideshow.

Its defining rule: **a folder holding more than a configurable number of files (default 20) is drawn as one metadata node instead of one node per note.** Everything else behaves the way the built-in graph view does — same filters, same forces, same colour groups, same right-click menus, same hover preview rules, familiar controls, its own saved configuration, and the same app language.

Measured on a 27,266-note vault (desktop Obsidian 1.14.4):
**1,546 drawn nodes · 4,795 links · 24 folder clusters holding 26,942 notes · model build 42 ms · one frame 0.4–0.5 ms.**

For a complete user-focused walkthrough, see the **[Fast Graph View User Guide](docs/USER_GUIDE.md)**.

---

## Table of contents

- [Getting started](#getting-started)
- [Folder aggregation](#folder-aggregation)
- [Interactions and search](#interactions-and-search)
- [Settings](#settings)
- [Standalone Obsidian integration](#standalone-obsidian-integration)
- [Privacy and data access](#privacy-and-data-access)
- [Why it is fast](#why-it-is-fast)
- [Design decisions](#design-decisions)
- [Build, development, and release](#build-development-and-release)
- [License](#license)

---

## Getting started

### 1. Install the plugin

Install **Fast Graph View** from **Settings → Community plugins**, or copy `main.js`, `styles.css`, and `manifest.json` from a release (or local build) into:

```text
<vault>/.obsidian/plugins/fast-graph-view/
```

Then enable **Fast Graph View** under **Settings → Community plugins**.

### 2. Enable vault metadata access

Open **Settings → Fast Graph View** and turn on **Allow vault-wide metadata access**. Vault-wide enumeration is **off by default** (including after upgrades) until explicitly enabled.

### 3. Open a graph

- **Global graph**: click the **Open clustered graph** ribbon icon or run **Fast Graph View: Open clustered graph** from the command palette (`Ctrl`/`⌘`+`P`).
- **Local graph**: open a note and run **Fast Graph View: Open clustered local graph**, or right-click a Markdown note and choose **Open clustered local graph** from the file menu.
- **Timelapse**: run **Start graph timelapse animation** (or click **Animate** under **Display** in the graph control panel) to reveal the global graph progressively; press `Escape`, click **Stop**, or run **Stop graph timelapse animation** to halt it.

---

## Folder aggregation

Folders over the threshold collapse into a single node sized by what it stands for and labelled `<name> (<count>)`. Hovering a cluster node shows a summary card with rolled-up counts: files directly in the folder and in subfolders, incoming links, outgoing links, internal links not drawn, and total file size.

- **Left-click** reveals a batch of that folder's notes (25 at a time) and reheats the layout; the graph leaf stays open.
- **Right-click** folds the folder back up. It does not open the file menu — a cluster is not a file.
- **Budget folding (`maxVisibleNodes`, default `2500`)**: acts as a hard ceiling. After the threshold rule runs, the heaviest remaining folders fold until the drawn node count fits, so a 100k-note vault still opens cleanly.
- **Counting modes (`mode`)**: `direct` counts only files immediately inside the folder; `recursive` counts the entire subtree, which works better for deeply nested vaults.
- **Metadata node cap (`maxMetadataNodes`, default `1200`)**: tag and unresolved-link nodes are capped separately, since in large vaults they are the other two ways a graph becomes unreadable.

---

## Interactions and search

### Desktop controls

| Action | Behaviour |
| --- | --- |
| **Mouse wheel** | Zooms anchored under the cursor |
| **Drag empty canvas** | Pans the viewport |
| **Drag a node** | Pins the node for the duration of the drag and releases it on `pointerup` so it rejoins the layout (matching native `forceNode` behaviour) |
| **Hover a node** | Highlights connected neighbours and dims the rest of the graph |
| **`Ctrl`/`⌘` + hover a note** | Opens Obsidian's page preview via the registered hover source (`defaultMod: true`) |
| **Click a note** | Opens the note in the same leaf (with navigation history back to the graph) |
| **`Ctrl`/`⌘`-click or middle-click a note** | Opens the note in a new tab |
| **`Ctrl`/`⌘`+`Alt`-click a note** | Opens the note in a split pane |
| **`Ctrl`/`⌘`+`Alt`+`Shift`-click a note** | Opens the note in a new window |
| **Click a folder cluster** | Expands up to 25 notes from that folder into the graph |
| **Right-click a folder cluster** | Folds expanded notes back into the cluster |
| **Click a tag node** | Filters the current graph to that tag |
| **Control panel** | Filters, colour groups (including drag-to-reorder), display options, and force sliders matching the built-in graph view |

### Mobile controls and adaptive performance

On Obsidian Mobile (Android, iPhone, and iPad):

- **One-finger swipe** pans, **tap** opens a note or expands a folder cluster, **two-finger pinch** zooms, and **long-press** triggers the node's context action (or folds a cluster). Colour groups can also be reordered by touch.
- **Adaptive frame-time budgeting**: the view starts with a performance profile chosen from the device's CPU, reported memory, screen size, and pixel density, then monitors actual frame cost. If a device falls behind, it progressively reduces labels, arrows, canvas resolution, physics frequency, and worker-to-screen updates. Quality restores only after a sustained stable period to prevent visible oscillation.
- **Interaction & lifecycle handling**: active pan and pinch gestures temporarily switch to a lighter profile, with an emergency topology budget reserved as a final fallback. These adjustments apply only to the active mobile session and never overwrite saved desktop settings (folder folding remains enabled on mobile even if turned off in saved desktop settings).
- **Deferred shared indexing**: initial vault indexing is shared across graph panes and deferred until the pane has painted its controls and loading indicator. Physics pauses while Obsidian is backgrounded and resumes on return; orientation changes and recoverable WebGL context loss rebuild the canvas automatically.

### Search operators

The filter box supports the native graph's query syntax plus `is:cluster` for folder nodes:

- `"exact phrase"` — exact substring match
- `tag:#name` or `#name` — notes with the given tag
- `path:folder` or `folder:folder` — notes under a folder path
- `file:name` or `name:name` — match file name
- `ext:md` — match file extension
- `link:target` or `to:target` — notes linking to `target`
- `backlink:source` or `from:source` — notes linked from `source`
- `is:orphan` — notes with no links
- `is:cluster` — folded folder cluster nodes
- `-term` — negate any term or operator

---

## Settings

Configure clustering and rendering budgets in **Settings → Fast Graph View**:

| Setting | Option key | Default | Description |
| --- | --- | --- | --- |
| **Allow vault-wide metadata access** | `allowVaultEnumeration` | `false` | Required opt-in before the plugin lists vault file paths or reads cached links, tags, sizes, and dates. |
| **Fold up large folders** | `cluster.enabled` | `true` | Collapse folders above the file threshold into single metadata nodes. |
| **Files per folder before folding** | `cluster.threshold` | `20` | Minimum number of notes in a folder before it collapses into a cluster node (`1`–`200` on the slider). |
| **Count notes** | `cluster.mode` | `direct` | Count notes directly inside the folder (`direct`) or across its entire subtree (`recursive`). |
| **Node budget** | `cluster.maxVisibleNodes` | `2500` | Hard ceiling on drawn nodes; the largest remaining folders fold until the graph fits. |
| **Tag and unresolved link limit** | `cluster.maxMetadataNodes` | `1200` | Maximum number of non-file metadata nodes (tags and unresolved links) shown at once. |
| **Shorten long names** | `cluster.maxLabelChars` | `24` | Truncate drawn canvas labels to this many characters (`0` disables truncation; hovered nodes always show their full name). |
| **Show folder details on hover** | `cluster.showMetadata` | `true` | Display the summary card with note counts, link weights, and folder size when hovering a cluster. |
| **Show node and frame counts** | `cluster.showStats` | `true` | Show the status line in the bottom corner with drawn node/link counts and build/draw timings. |

---

## Standalone Obsidian integration

Fast Graph View registers its own `fast-graph-view` and `fast-localgraph` view types through Obsidian's public plugin API. It does not unregister, replace, or modify the built-in graph plugin.

- The ribbon button and **Open clustered graph** command open the global view.
- The **Open clustered local graph** command and Markdown file-menu entry open a local view rooted on the selected note.
- Global graph and clustering options are saved in this plugin's `data.json`.
- Local graph options and the fixed root file are saved in the workspace leaf state, so restored local panes return to the same note.
- Option names, ranges, and defaults remain familiar, without reading or writing the built-in graph plugin's private configuration.

---

## Privacy and data access

- **Vault-wide metadata access is off by default**, including after upgrading from a version without this setting. Enable **Allow vault-wide metadata access** in **Settings → Fast Graph View** to use either graph. Building a complete graph requires enumerating all vault file paths (including attachments) and inspecting cached links, tags, file sizes, and timestamps. This is intentional functionality, not a permission bypass; a static security scanner may still report vault enumeration even though it is guarded by explicit user consent.
- **Metadata cache only**: no note bodies are read from disk to build the graph, and no vault data is ever sent over the network. Automatic indexing runs only while a graph pane is open. Disabling access cancels pending builds, drops the shared snapshot, and clears open graphs.
- **No clipboard or vault writes**: the plugin does not read or write the system clipboard. Choosing **Save screenshot** from the graph pane menu downloads a PNG directly through the browser/window; it does not create files inside the vault.

---

## Why it is fast

| Layer | What it does |
| --- | --- |
| `src/graph/source.ts` | Reads links out of `metadataCache` only. No file is ever read from disk, so a cold build costs one pass over cached frontmatter/link lists. |
| `src/graph/build.ts` | Produces a structure-of-arrays model (`Float32Array` positions, `Int32Array` kinds/paths, CSR adjacency). Nothing per-node is allocated while drawing. |
| `src/layout/*` | Barnes-Hut force simulation running in a blob worker, with an inline time-sliced fallback when workers are unavailable. The main thread receives position buffers and never touches the quadtree. |
| `src/render/renderer.ts` | One WebGL2 instanced draw call per primitive: SDF discs for nodes, segments for links, arrowheads, selection rings. Labels are a separate 2D overlay that only redraws when the visible set changes. |
| `src/view/engine.ts` | The frame loop stops. Once the layout alpha is under `0.001` and 60 frames have painted nothing, `requestAnimationFrame` is unscheduled; the next wheel, pointer, or filter event wakes it. Idle cost is zero, not 60 fps of nothing. |

---

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

---

## Build, development, and release

### Prerequisites and scripts

Requires **Node.js `>=22.0.0`** and **pnpm**.

```bash
pnpm install
pnpm build          # esbuild production bundle + tsc --noEmit
pnpm test           # unit & security regression tests
pnpm lint           # ESLint check (including eslint-plugin-obsidianmd)
pnpm check:release  # verify manifest.json, package.json, versions.json, and API rules
```

The built plugin consists of the three files at the repository root: `main.js`, `styles.css`, and `manifest.json`. `pnpm watch` rebuilds on change.

### Local development vault

For a ready-to-run local vault, use the checked-in `test-vault`:

```bash
pnpm install
pnpm build
pnpm deploy
```

Open `test-vault` in Obsidian, enable the plugin, and start the live development loop:

```bash
pnpm dev:vault
```

Launch Obsidian with `--remote-debugging-port=9223` for automatic plugin reloads after each build. Set `OBSIDIAN_VAULT=/path/to/another/vault` to deploy to a different vault.

### Verification harness (`tools/`)

`tools/` is a verification harness and is not bundled into the plugin. `tools/obs-cdp.mjs` drives a running Obsidian renderer over the Chrome DevTools Protocol (`--remote-debugging-port=9223`) with trusted `Input` events, and `tools/harness/*.mjs` contains the test scenarios:

- `trusted.mjs` — hover, click, right-click, wheel, pan, node drag, idle-loop, click navigation
- `panel.mjs` — control panel interactions
- `local.mjs` — local graph behaviour
- `standalone.mjs` — standalone registration and teardown
- `crash-watch.mjs` — renderer reload journaling

Launch Obsidian with background throttling disabled so Chromium keeps producing frames even when another window covers it (otherwise `requestAnimationFrame` pauses and timing measurements reflect frame-sink starvation):

```bash
flatpak run md.obsidian.Obsidian \
  --user-data-dir=<harness profile> --remote-debugging-port=9223 \
  --disable-backgrounding-occluded-windows --disable-renderer-backgrounding \
  --disable-background-timer-throttling --disable-features=CalculateNativeWinOcclusion
```

### Publish a GitHub release

Version bumps synchronize `package.json`, `manifest.json`, and `versions.json` via the `version` script in `package.json` (with `tag-version-prefix=""` in `.npmrc` so tags match Obsidian's `1.2.3` format):

```bash
pnpm version patch   # Bug fixes (e.g. 1.0.1 -> 1.0.2)
pnpm version minor   # New features (e.g. 1.0.1 -> 1.1.0)
pnpm version major   # Breaking changes (e.g. 1.0.1 -> 2.0.0)
```

Verify the release metadata and built assets locally, push the commit and tag to GitHub, and publish the release with the three plugin files (`main.js`, `manifest.json`, and `styles.css`):

```bash
pnpm check:release
pnpm build
pnpm test
git push && git push --tags
gh release create <version> main.js manifest.json styles.css --title "<version>" --generate-notes
```

---

## License

This plugin is licensed under the **GNU General Public License v3.0 (GPLv3)** with an additional linking exception under Section 7 allowing it to be linked with and run inside the proprietary Obsidian application. See the [LICENSE](LICENSE) file for full details.
