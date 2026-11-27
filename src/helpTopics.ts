import { colorGroups } from "./appearance";
import { featureOptions } from "./featureOptions";
import type { Command } from "./preferences";

const controlHelpTopics = {
  workspace: { title: "Workspace controls", keys: ["menu", "swap", "hidden", "settings"] },
  paneNavigation: { title: "Pane navigation", keys: ["parent", "refresh"] },
  paneAddress: { title: "Address and breadcrumbs", keys: ["address"] },
  paneSources: { title: "Drives and pane sources", keys: ["leftLocations", "rightLocations"] },
  paneFilter: { title: "Filter folder", keys: ["filter", "search", "quickSearch"] },
  paneColumns: { title: "Columns and panel modes", keys: [] },
  paneSelection: { title: "Current row and marks", keys: ["mark", "selectUpRow", "selectDownRow"] },
  paneStatus: { title: "Pane details and progress", keys: [] },
  paneViews: { title: "File pane view", keys: [] },
  fileBookmarks: { title: "File bookmarks", keys: ["bookmarkLine", "fileBookmarks"] },
  spaceAnalyzer: { title: "Space Analyzer", keys: ["analyzeSpace"] },
  diskInformation: { title: "Disk information", keys: ["diskInformation"] },
  spaceScope: { title: "Analysis scope", keys: [] },
  spacePath: { title: "Scan path", keys: [] },
  spaceTree: { title: "Tree", keys: [] },
  spaceTreemap: { title: "Treemap", keys: [] },
  spaceSunburst: { title: "Sunburst", keys: [] },
  spaceMetric: { title: "Size metric", keys: [] },
  spaceActions: { title: "Scan controls and results", keys: [] },
  quickView: { title: "Quick View", keys: ["quickView"] },
  gitView: { title: "Git View", keys: ["gitView"] },
  environment: { title: "Environment variables", keys: [] },
  actionDialogs: { title: "File operation dialogs", keys: [] },
} as const satisfies Record<string, { title: string; keys: readonly Command[] }>;

export type ControlTopic = keyof typeof controlHelpTopics;

const { filePanels, viewer, editor, terminal } = featureOptions;

export const helpTopics = {
  ...controlHelpTopics,
  files: { title: filePanels.label, keys: ["switchPane", "open", "parent", "mark", "selectUpRow", "selectDownRow", "hidden", "leftLocations", "rightLocations", "addFolderShortcut"] },
  operations: { title: "File operations", keys: ["copy", "move", "mkdir", "recycle", "delete", "copyClipboard", "pasteClipboard"] },
  archives: { title: "Archives", keys: ["createArchive", "open", "parent", "copy", "view", "edit", "recycle"] },
  search: { title: "Find files", keys: ["quickSearch", "search"] },
  viewer: { title: viewer.label, keys: ["view", "viewAsHex", "switchDocumentMode", "nextDocument", "previousDocument", "cancelText", "zoomFont"] },
  editor: { title: editor.label, keys: ["edit", "newFile", "switchDocumentMode", "saveText", "cancelText", "closeText", "zoomFont"] },
  terminal: { title: terminal.label, keys: ["toggleTerminal", "expandTerminal", "collapseTerminal", "terminal", "commandPath", "commandName", "previousCommand", "commandHistory"] },
  terminalShortcuts: { title: "File shortcuts in the terminal", keys: [] },
  compare: { title: "Compare files", keys: ["compare", "previousChange", "nextChange"] },
  remote: { title: "Remote connection", keys: ["leftLocations", "rightLocations", "netboxSources", "addNetBoxProfile", "editNetBoxProfile",
    "netboxPreviousPage", "netboxNextPage", "remoteSources"] },
  googleDrive: { title: "Google Drive", keys: ["leftLocations", "rightLocations", "googleDriveSources",
    "addGoogleDriveProfile", "editGoogleDriveProfile", "newFile", "mkdir", "view", "edit", "rename", "copy", "move", "recycle", "delete"] },
  processes: { title: "Processes", keys: ["leftLocations", "rightLocations"] },
  general: { title: "General", keys: ["settings"] },
  profiles: { title: "Profiles", keys: [] },
  appearance: { title: "Appearance", keys: [] },
  window: { title: colorGroups.window.label, keys: [] },
  panels: { title: colorGroups.panels.label, keys: [] },
  fileTypes: { title: colorGroups.files.label, keys: [] },
  dialogs: { title: colorGroups.dialogs.label, keys: [] },
  textTools: { title: colorGroups.text.label, keys: [] },
  fonts: { title: "Fonts", keys: [] },
  viewFonts: { title: "View font sizes", keys: ["zoomFont"] },
  shortcuts: { title: "Keyboard shortcuts", keys: ["help", "searchHelp", "settings"] },
} as const satisfies Record<string, { title: string; keys: readonly Command[] }>;

export type HelpTopic = keyof typeof helpTopics;

export const helpGroups: readonly { title?: string; topics: readonly HelpTopic[] }[] = [
  { topics: ["workspace", "files", "operations", "archives", "search", "quickView", "viewer", "fileBookmarks", "editor", "terminal", "terminalShortcuts", "compare", "remote", "googleDrive", "processes", "gitView", "environment"] },
  { title: "File pane controls", topics: ["paneNavigation", "paneAddress", "paneSources", "paneFilter", "paneViews", "paneColumns", "paneSelection", "paneStatus", "actionDialogs"] },
  { title: "Space Analyzer controls", topics: ["diskInformation", "spaceAnalyzer", "spaceScope", "spacePath", "spaceTree", "spaceTreemap", "spaceSunburst", "spaceMetric", "spaceActions"] },
  { title: "Options", topics: ["general", "profiles", "appearance", "window", "panels", "fileTypes", "dialogs", "textTools", "fonts", "viewFonts", "shortcuts"] },
];

export const overviewTopics: Partial<Record<HelpTopic, readonly HelpTopic[]>> = {
  files: ["paneNavigation", "paneAddress", "paneSources", "paneFilter", "paneViews", "paneColumns", "paneSelection", "paneStatus", "spaceAnalyzer"],
  operations: ["paneSelection", "actionDialogs"],
  general: ["profiles", "appearance", "shortcuts"],
  terminal: ["terminalShortcuts", "environment"],
};
