# Fast Graph View User Guide

Fast Graph View replaces Obsidian's built-in graph views with a WebGL-powered graph that
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

### Build from this repository

If you are working from the source repository:

```bash
pnpm install
pnpm build
```

The build produces the three plugin files at the repository root. Copy them to the plugin
folder above, then reload Obsidian or enable the plugin.

## 2. Choose how the plugin integrates with Obsidian

Open **Settings -> Fast Graph View**.

### Take over the built-in graph views

By default, **Replace the built-in graph view** is enabled. With takeover enabled:

- The normal **Graph view** command opens Fast Graph View.
- The normal ribbon button opens Fast Graph View.
- Existing graph keybindings continue to work.
- File-menu actions such as **Open in graph view** use the replacement view.
- The optional **Replace the built-in local graph** setting applies the same behavior to
  local graphs.

Existing graph panes are migrated when this setting changes. You do not need to close and
reopen every pane manually.

### Run alongside the built-in views

Disable takeover when you want to compare the two implementations. The plugin then exposes
separate view types named `fast-graph-view` and `fast-localgraph`, while Obsidian restores
its native graph view creators.

Use takeover mode for normal daily use. Use standalone mode when comparing behavior or
diagnosing a problem.

## 3. Open your first graph

1. Open the command palette with `Ctrl/Cmd+P`.
2. Run **Open graph view** for the global graph, or open a note and run **Open local graph**.
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
- **Counting mode**: `direct` counts files immediately inside a folder; `recursive` counts
  the complete subtree.
- **Node budget**: the maximum number of visible graph nodes, defaulting to 2,500.
- **Metadata-node budget**: the separate limit for tags and unresolved links.
- **Cluster hover details**: show or hide the cluster information card.
- **Node/frame status line**: show or hide performance information.

Use `recursive` counting for deeply nested project folders. Use `direct` counting when
only the files immediately inside each folder should determine whether it folds.

The node budget can fold additional heavy folders even when they are below the normal
threshold. This keeps the rendered graph within a practical size for very large vaults.

## 5. Use the graph control panel

Open the graph's control panel using the graph view's normal controls. The panel contains
the same broad groups as Obsidian's native graph view:

- **Search**: filter visible nodes with a graph query.
- **Groups**: assign colors using ordered query rules.
- **Display**: configure tags, attachments, unresolved links, orphans, arrows, text fade,
  node size, and line size.
- **Forces**: tune center force, repulsion, link force, and link distance.
- **Local graph**: configure depth and link directions when viewing a local graph.

Color groups are evaluated from top to bottom. The first matching group determines a node's
color. Drag groups to reorder them when a more specific rule should take precedence.

Graph options use Obsidian's native option names and ranges. They are saved with the graph
view and are compatible with Obsidian's normal graph configuration.

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

- Click a tag node to open a global tag search.
- Unresolved-link nodes do not open a file menu.
- Right-click a folder cluster to collapse it.

## 8. Preview notes by hovering

Hovering a file or attachment fades unrelated nodes and keeps adjacent nodes and links
emphasized. To open Obsidian's page preview, hold the configured Mod key while hovering.

Tags and unresolved-link nodes do not open page previews. Folder clusters instead display
their metadata card.

## 9. Work with local graphs

1. Open a note.
2. Open its local graph from the command palette, file menu, or normal Obsidian graph
   controls.
3. Set **Local graph depth** from 1 to 5.
4. Enable or disable backlinks, forelinks, and interlinks as needed.

The local graph can follow the active file. When it is pinned, changing the active note does
not change its root. Folder clustering can also be enabled for local graphs with the
**Cluster local graphs** setting.

Use a shallow depth to inspect immediate dependencies. Use a larger depth to explore a
topic neighborhood, then turn off interlinks or backlinks if the view becomes too dense.

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

Use the graph pane menu and choose **Copy screenshot**. The plugin combines the rendered
graph and its label overlay, creates a PNG, and copies it to the clipboard.

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

## 13. Troubleshooting

### The normal Graph command still opens the native view

Check **Settings -> Fast Graph View -> Replace the built-in graph view**. After changing it,
close and reopen the graph if Obsidian has not migrated the pane automatically.

### The graph is empty

Wait for Obsidian's metadata cache to finish resolving. Confirm that the vault contains
files and links, then check whether the search field or display settings are filtering every
node.

### A local graph has the wrong root

Check whether the local graph is pinned. An unpinned local graph follows the active file;
a pinned graph keeps its saved root.

### The graph reports that WebGL is unavailable

The plugin requires WebGL or WebGL2 for rendering. Try a desktop Obsidian window with
hardware acceleration enabled. The force simulation can fall back to the main thread, but
the graph renderer itself does not have a Canvas fallback.

### The graph contains too many cluster nodes

Increase the node budget, lower the folder threshold, or switch from recursive to direct
counting. The node budget may also fold additional folders to keep the visible graph small.

### Tags or unresolved links are missing

They are subject to the metadata-node limit. Increase that limit if those nodes are needed,
or disable them when the graph should focus on file relationships.

## 14. What the plugin does not do

- It does not search note body text or properties.
- It does not provide inline search autocomplete.
- It does not show a loading spinner for model rebuilds.
- It does not localize its UI strings; the shipped UI is English.
- It aggregates folders, but does not hierarchically fold tags or unresolved links.
- It requires WebGL for display, even though physics has a worker and main-thread fallback.

These limitations are deliberate parts of the metadata-cache and large-vault performance
design.