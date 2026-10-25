# Fast Graph View User Guide

Fast Graph View adds a standalone WebGL-powered graph alongside Obsidian's built-in views and
stays usable in large vaults. Its main difference is folder aggregation: instead of drawing
every file in a large folder, it can draw one expandable folder cluster and summarize the
files represented by that cluster.

This guide is for people using the plugin in a vault. For building and testing the plugin,
see the project [README](../README.md).

## 1. Install and enable the plugin

### Install from a release

1. Install the plugin using your normal Obsidian community-plugin workflow, or copy the
   release files into:

   ```text
   <your-vault>/.obsidian/plugins/fast-graph-view/
   ```

2. Make sure the folder contains `main.js`, `styles.css`, and `manifest.json`.
3. Open **Settings -> Community plugins**.
4. Enable **Fast Graph View**.
5. To use a graph, open **Settings → Fast Graph View** and enable **Allow vault-wide metadata
   access**. This is off by default, including on upgrade. It allows the plugin to list all
   vault file paths and inspect cached links, tags, sizes and dates for both global and local
   graphs. Note bodies are not read and no vault data is sent over the network. You can turn
   it off at any time to cancel pending builds and clear open graphs.

### Build from this repository

If you are working from the source repository:

```bash
pnpm install
pnpm build
```

The build produces the three plugin files at the repository root. Copy them to the plugin
folder above, then reload Obsidian or enable the plugin.

### Display language

The plugin's UI follows Obsidian's own language setting; there is no separate language picker
in its settings tab. English, German, French, Spanish, Italian, Brazilian Portuguese,
Russian, Polish, Japanese, Simplified Chinese and Korean are built in. Every other language,
including Traditional Chinese, falls back to English rather than to a lookalike script.

Change the language under **Settings -> General**, then reload Obsidian. Already-open graph
panes keep the labels they were built with, because the panel reads them once when it is
drawn.

The names quoted in this guide are the English ones.

## 2. How the plugin integrates with Obsidian

The plugin always runs alongside the built-in graph. It uses its own `fast-graph-view` and
`fast-localgraph` view types and never replaces Obsidian's graph creators or configuration.

- The Fast Graph View ribbon icon opens its global graph.
- **Open clustered graph** opens the global graph from the command palette.
- **Open clustered local graph** opens a local graph for the active note.
- The Markdown file menu includes the same local-graph action for the selected note.

Open **Settings -> Fast Graph View** to configure folder aggregation and rendering budgets.

## 3. Open your first graph

1. Open the command palette with `Ctrl/Cmd+P`.
2. Run **Open clustered graph** for the global graph, or open a note and run **Open clustered local graph**.
3. Wait for the layout to settle.
4. Drag empty space to pan and use the mouse wheel to zoom.

The graph reads links, tags, unresolved links, file metadata, and timestamps from
Obsidian's metadata cache. It does not read every note body to build the graph.

The optional status line reports model-build and rendering information. It is useful when
adjusting budgets for a large vault.

## 4. Understand folder clusters

When a folder passes the configured threshold, the graph represents it with one cluster
node. A label such as `Projects (25)` means the cluster represents 25 files according to
the selected counting mode.

Hover a cluster to inspect:

- Files directly in the folder.
- Files in the recursive subtree.
- Number of child folders.
- Incoming and outgoing link weights.
- Internal links hidden by aggregation.
- Total recursive file size.
- High-degree files.
- Frequently used tags.
- Why the folder was folded.

### Expand a cluster

Left-click the cluster. The plugin reveals a batch of files, reheats the force layout, and
leaves the graph open. Repeat the click to reveal more files.

### Collapse a cluster

Right-click the cluster. It folds back into one node. A cluster is not a file, so the
right-click does not open the normal file context menu.

### Configure clustering

The clustering settings control:

- **Fold up large folders**: enable or disable folder aggregation.
- **Files per folder before folding**: the direct or recursive threshold.
- **Count notes**: **Directly inside the folder** counts only the notes in a folder;
  **Including subfolders** counts the complete subtree.
- **Node budget**: the maximum number of visible graph nodes, defaulting to 2,500.
- **Tag and unresolved link limit**: the separate limit for tags and unresolved links.
- **Shorten long names**: how many characters a name may use on the canvas, 24 by default. An
  unresolved link also loses the folder path its linktext carries. The node under the cursor
  always shows its complete name, and **0** stops shortening anything.
- **Show folder details on hover**: show or hide the cluster information card.
- **Show node and frame counts**: show or hide performance information.

Use **Including subfolders** for deeply nested project folders. Use **Directly inside the
folder** when only the files immediately inside each folder should determine whether it folds.

The node budget can fold additional heavy folders even when they are below the normal
threshold. This keeps the rendered graph within a practical size for very large vaults.

## 5. Use the graph control panel

Open the graph's control panel using the graph view's normal controls. The panel contains
the same broad groups as Obsidian's native graph view:

- **Filters**: the query field, plus **Tags**, **Attachments**, **Existing files only** and
  **Orphans**. On a local graph this section also holds **Depth** and the **Incoming links**,
  **Outgoing links** and **Neighbor links** switches.
- **Groups**: assign colors using ordered query rules.
- **Display**: **Arrows**, **Text fade threshold**, **Node size** and **Link thickness**, plus
  the timelapse control.
- **Forces**: **Center force**, **Repel force**, **Link force** and **Link distance**.

Color groups are evaluated from top to bottom. The first matching group determines a node's
color. Drag groups to reorder them when a more specific rule should take precedence.

Graph options use familiar names and ranges. Global options are saved in this plugin's data;
local options are saved with their graph pane.

## 6. Search the graph

Enter a query in the graph filter. Terms separated by spaces are combined with AND:

```text
project active
```

Supported operators include:

| Operator | Example | Meaning |
| --- | --- | --- |
| Exact phrase | `"release notes"` | Match an exact phrase. |
| Tag | `tag:research` or `#research` | Match a tag. |
| Path | `path:Projects` | Match a path. |
| Folder | `folder:Projects` | Match a folder. |
| File name | `file:Alpha` or `name:Alpha` | Match a file name. |
| Extension | `ext:md` | Match a file extension. |
| Outgoing link | `link:Dashboard` or `to:Dashboard` | Match files linking to a target. |
| Backlink | `backlink:Alpha` or `from:Alpha` | Match files linked from a source. |
| Orphan | `is:orphan` | Match orphan files. |
| Cluster | `is:cluster` | Match folder clusters. |
| File type | `is:file` | Match file nodes. |
| Attachment | `is:attachment` | Match attachment nodes. |
| Tag type | `is:tag` | Match tag nodes. |
| Unresolved type | `is:unresolved` | Match unresolved-link nodes. |
| OR | `alpha or beta` or `alpha \| beta` | Match either expression. |
| Negation | `-tag:archive` or `NOT tag:archive` | Exclude matching nodes. |
| Grouping | `(alpha or beta) project` | Combine expressions explicitly. |

Examples:

```text
tag:research -tag:archive
folder:Projects is:file
is:cluster or is:orphan
(link:Home or backlink:Home) -path:Archive
```

Search is metadata-based. It does not search note body text, properties, lines, or
sections. This is intentional: reading every file would undermine the performance model
used to make large vaults responsive.

## 7. Navigate from graph nodes

For a file node:

- Click to open the file in the current leaf.
- Middle-click to open it in a new tab.
- `Ctrl/Cmd`-click to open it in a new tab.
- `Ctrl/Cmd+Alt`-click to open it in a split.
- `Ctrl/Cmd+Alt+Shift`-click to open it in a new window.
- Right-click to open the normal file context menu.

For other node types:

- Click a tag node to filter the current graph to that tag.
- Unresolved-link nodes do not open a file menu.
- Right-click a folder cluster to collapse it.

## 8. Preview notes by hovering

Hovering a file or attachment fades unrelated nodes and keeps adjacent nodes and links
emphasized. To open Obsidian's page preview, hold the configured Mod key while hovering.

Tags and unresolved-link nodes do not open page previews. Folder clusters instead display
their metadata card.

## 9. Work with local graphs

1. Open a note.
2. Open its local graph from the Fast Graph View command or Markdown file menu.
3. In the panel's **Filters** section, set **Depth** from 1 to 5.
4. Enable or disable **Incoming links**, **Outgoing links** and **Neighbor links** as needed.

The local graph keeps the root it was opened with. Close it and open a new local graph to use
a different root. Folder clustering uses the same plugin settings as the global graph.

Use a shallow depth to inspect immediate dependencies. Use a larger depth to explore a
topic neighborhood, then turn off **Neighbor links** or **Incoming links** if the view
becomes too dense.

## 10. Use timelapse

Timelapse is available in the global graph. Start it from the graph's normal animate or
timelapse control.

The plugin reveals notes from oldest to newest using note dates. Playback speed is derived
from link counts, and the visible model is rebuilt as the animation progresses.

While a reveal is running, its start control turns into a stop control: the **Animate**
button under Display reads **Stop**, and the animate icon of a collapsed panel becomes a
stop icon. `Escape` also halts the reveal, and **Stop graph timelapse animation** appears in
the command palette only while one is running, so you can give it a hotkey. Stopping shows
every note your filters allow again.

Because that control toggles, a restart comes from **Start graph timelapse animation**, which
begins the reveal again from the oldest note while one is running. Local graphs do not support
timelapse.

## 11. Save a graph screenshot

Use the graph pane menu and choose **Save screenshot**. The plugin combines the rendered
graph and its label overlay and downloads a PNG. It does not read or write the system
clipboard or save the image inside your vault.

## 12. Tune a large vault

Start with these settings:

1. Enable folder aggregation.
2. Set the folder threshold around 20, then raise or lower it based on how much detail you
   want.
3. Keep the node budget near 2,500 unless the device can comfortably render more.
4. Use recursive counting when many folders contain nested subfolders.
5. Cap tags and unresolved links if metadata nodes dominate the view.
6. Hide the status line after tuning is complete.

If the graph is still too dense, reduce the node budget, increase the folder threshold, or
disable tags and unresolved links. If it is too abstract, lower the threshold and expand
clusters as needed.

### Mobile behavior

On Android, iPhone, and iPad:

- Swipe with one finger to pan, tap a node to open or expand it, pinch with two fingers to
  zoom, and long-press for the node's context action.
- The first open can briefly show a centered loading indicator while the shared metadata
  snapshot is prepared. Opening another graph pane reuses that snapshot.
- The plugin selects a conservative starting profile from the device and then adapts to real
  frame time. Labels and arrows may disappear, motion may update less often, and the canvas
  may become slightly softer when the device is under pressure. These are temporary session
  changes and do not alter the graph settings synchronized with desktop.
- Direct pan and pinch temporarily use lower detail. Quality returns slowly after interaction
  so that the view does not alternate rapidly between levels.
- Obsidian backgrounding pauses physics. Returning to the app, rotating the device, or
  recovering a WebGL context restores and resizes the graph automatically.

For the best result on a very low-memory phone, keep tags and unresolved links hidden and
leave large-folder aggregation enabled. If iOS or Android kills Obsidian while the graph is
open, reopen the app with fewer graph panes; that indicates an operating-system memory limit,
not a saved quality setting.

## 13. Troubleshooting

### The normal Graph command still opens the native view

This is expected. Fast Graph View is standalone; use its ribbon icon or **Open clustered
graph** command instead.

### The graph is empty

Wait for Obsidian's metadata cache to finish resolving. Confirm that the vault contains
files and links, then check whether the search field or display settings are filtering every
node.

### A local graph has the wrong root

Close the pane, activate the intended note, and run **Open clustered local graph** again. Each
local pane keeps the root it was opened with.

### The graph reports that WebGL is unavailable

The plugin requires WebGL or WebGL2 for rendering. On mobile, close other graph panes and
restart Obsidian; on desktop, verify that hardware acceleration is enabled. Recoverable mobile
WebGL context loss is handled automatically. The force simulation can fall back to the main
thread, but the graph renderer itself does not have a Canvas fallback.

### The graph contains too many cluster nodes

Increase the node budget, lower the folder threshold, or switch from recursive to direct
counting. The node budget may also fold additional folders to keep the visible graph small.

### Tags or unresolved links are missing

They are subject to the metadata-node limit. Increase that limit if those nodes are needed,
or disable them when the graph should focus on file relationships.

## 14. What the plugin does not do

- It does not search note body text or properties.
- It does not provide inline search autocomplete.
- It does not show a loading spinner for routine model rebuilds; the initial shared mobile
  vault snapshot has one because the pane is intentionally painted before indexing starts.
- It does not offer its own language picker; the UI language is always Obsidian's.
- It aggregates folders, but does not hierarchically fold tags or unresolved links.
- It requires WebGL for display, even though physics has a worker and main-thread fallback.

These limitations are deliberate parts of the metadata-cache and large-vault performance
design.
