/** The English catalogue: every key the plugin shows, and the type the other
 *  ten catalogues are checked against. A missing or misspelled key in any of them
 *  is a compile error, because they are declared `satisfies Messages`.
 *
 *  Placeholders are `{name}` and are filled by `t()` / `tp()` in `src/i18n.ts`.
 *  `tp()` always supplies `{count}`, formatted for the active locale.
 */

import type { PluralForms } from "./types";

const en = {
  // ------------------------------------------------------------- settings tab
  "settings.fold.name": "Fold up large folders",
  "settings.fold.desc": "Draw one metadata node for a folder instead of every note inside it.",
  "settings.threshold.name": "Files per folder before folding",
  "settings.threshold.desc":
    "Folders with more notes than this threshold collapse into a single node (default: {default}).",
  "settings.countNotes.name": "Count notes",
  "settings.countNotes.desc":
    "Whether a folder is judged on the notes in it alone, or including its subfolders.",
  "settings.mode.direct": "Directly inside the folder",
  "settings.mode.recursive": "Including subfolders",
  "settings.nodeBudget.name": "Node budget",
  "settings.nodeBudget.desc":
    "Hard ceiling on drawn nodes ({default} by default). Folders fold until it holds.",
  "settings.metadataLimit.name": "Tag and unresolved link limit",
  "settings.metadataLimit.desc": "Cap on the non-file nodes a graph may hold.",
  "settings.maxLabelChars.name": "Shorten long names",
  "settings.maxLabelChars.desc":
    "Cut names to this many characters on the canvas and drop the path a broken link carries. A limit of 0 leaves them whole; the hovered node always shows the full name.",
  "settings.showMetadata.name": "Show folder details on hover",
  "settings.showMetadata.desc":
    "Card with the note count, link weight and busiest notes of a folded folder.",
  "settings.showStats.name": "Show node and frame counts",
  "settings.showStats.desc": "The line in the corner of the pane with nodes, links, build and draw time.",

  // ------------------------------------------------- commands, ribbon, panes
  "command.open": "Open clustered graph",
  "command.openLocal": "Open clustered local graph",
  "command.animate": "Start graph timelapse animation",
  "command.stopAnimate": "Stop graph timelapse animation",
  "view.clusteredGraph": "Clustered graph view",
  "view.graph": "Graph view",
  "view.graphOfFile": "Graph of {name}",
  "view.localGraph": "Local graph",

  // --------------------------------------------------------- control panel
  "panel.filters": "Filters",
  "panel.groups": "Groups",
  "panel.display": "Display",
  "panel.forces": "Forces",
  "panel.searchFiles": "Search files...",
  "panel.clearSearch": "Clear search",
  "panel.depth": "Depth",
  "panel.depthDescription": "Show nodes this number of links away",
  "panel.incoming": "Incoming links",
  "panel.incomingDescription": "Show links from other files",
  "panel.outgoing": "Outgoing links",
  "panel.outgoingDescription": "Show links to other files",
  "panel.neighbor": "Neighbor links",
  "panel.neighborDescription": "Show links between neighbors",
  "panel.tags": "Tags",
  "panel.tagsDescription": "Tags are linked to the files that contain them",
  "panel.attachments": "Attachments",
  "panel.attachmentsDescription": "Show attachments",
  "panel.existingOnly": "Existing files only",
  "panel.existingOnlyDescription": "When enabled, links to nonexistent files are not shown",
  "panel.orphans": "Orphans",
  "panel.orphansDescription": "Show files that are not linked to any other file",
  "panel.arrows": "Arrows",
  "panel.arrowsDescription": "Show arrows when zoomed in",
  "panel.textFade": "Text fade threshold",
  "panel.nodeSize": "Node size",
  "panel.linkThickness": "Link thickness",
  "panel.centerForce": "Center force",
  "panel.repelForce": "Repel force",
  "panel.linkForce": "Link force",
  "panel.linkDistance": "Link distance",
  "panel.enterQuery": "Enter query...",
  "panel.deleteGroup": "Delete group",
  "panel.newGroup": "New group",
  "panel.swatchTooltip": "Click to change color\nDrag to reorder groups",
  "panel.animate": "Animate",
  "panel.stop": "Stop",
  "panel.close": "Close",
  "panel.openSettings": "Open graph settings",
  "panel.startTimelapse": "Start timelapse animation",
  "panel.stopTimelapse": "Stop timelapse animation",
  "panel.restoreDefaults": "Restore default settings",

  // -------------------------------------------------------- folder hover card
  "card.reason.direct": "Over the folder threshold",
  "card.reason.entities": "Over the folder threshold with its subfolders",
  "card.reason.budget": "Hidden by the node budget",
  "card.reason.manual": "Collapsed by hand",
  "card.noteCount": { one: "{count} note", other: "{count} notes" } as PluralForms,
  "card.files.label": "Files",
  "card.files.value": "{here} here, {below} below",
  "card.subfolders": "Subfolders",
  "card.linksIn": "Links in",
  "card.linksOut": "Links out",
  "card.internal.label": "Internal",
  "card.internal.value": { one: "{count} not drawn", other: "{count} not drawn" } as PluralForms,
  "card.size": "Size",
  "card.hint": "Click to show {count} · right-click to fold",
  "card.hintOverflow": "Click for {count} more · right-click to fold up",

  // ------------------------------------------------------------- status line
  "status.nodes": { one: "{count} node", other: "{count} nodes" } as PluralForms,
  "status.links": { one: "{count} link", other: "{count} links" } as PluralForms,
  "status.folders": { one: "{count} folder", other: "{count} folders" } as PluralForms,
  "status.folded": { one: "{count} note folded", other: "{count} notes folded" } as PluralForms,
  "status.buildMs": "build {ms} ms",
  "status.drawMs": "draw {ms} ms",
  "status.timelapseGlobalOnly": "Timelapse is only for the global graph",
  "status.timelapseRunning": "Timelapse running",
  "status.physicsMainThread": "Physics on the main thread: {reason}",
  "status.webglUnavailable": "WebGL unavailable: {error}",

  // ------------------------------------------------------------ menus, notices
  "menu.openLinkedView": "Open linked view",
  "menu.openInNewTab": "Open in new tab",
  "menu.deleteFile": "Delete file",
  "menu.copyScreenshot": "Copy screenshot",
  "notice.clipboardUnsupported": "Copying images to the clipboard is not supported here.",
  "notice.screenshotCopied": "Screenshot copied to the clipboard.",

  // ------------------------------------------------------- canvas node labels
  "label.vaultRoot": "Vault root",
  "label.clusterCount": "{name} ({count})",
  "label.clusterOverflow": {
    one: "{name}: {count} more",
    other: "{name}: {count} more",
  } as PluralForms,
};

export default en;

/** The key set every other catalogue must match exactly. */
export type Messages = typeof en;
