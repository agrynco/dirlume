import type { FtpPlace, NamedFile, Place } from "./api";
import { reportFrontendError } from "./diagnostics";
import { closeSearchResults, emptyPane, type PaneState, type Side } from "./panes";

export type DocumentWindow = { id: number; file: NamedFile; editing: boolean };
type LocalPlace = Extract<Place, { kind: "local" }>;
export type SavedFtpLocation = Pick<FtpPlace, "profileId" | "segments">;
type SavedPane = Pick<PaneState, "selected" | "marked" | "filter" | "sort" | "position"> & {
  place: LocalPlace | null;
  history: LocalPlace[];
  ftp?: SavedFtpLocation;
};

interface Workspace {
  panels: Record<Side, SavedPane>;
  active: Side;
  split: number;
  terminalHeightStep?: number;
  terminalHeight?: number;
  documents: DocumentWindow[];
  activeDocument: number | null;
}

const storageKey = "dirlume.workspace.v1";

function isLocal(place: Place | null | undefined): place is LocalPlace {
  return place?.kind === "local" && typeof place.path === "string" && !!place.path;
}

export function readWorkspace(): Workspace | null {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? "null") as Workspace | null;
    if (!value || !value.panels?.left || !value.panels.right || !Array.isArray(value.documents)) return null;
    for (const pane of Object.values(value.panels)) {
      const ftp = pane.ftp;
      if (typeof ftp?.profileId !== "string" || !Array.isArray(ftp.segments) ||
          ftp.segments.some((segment) => typeof segment !== "string")) delete pane.ftp;
    }
    value.documents = value.documents.filter((document) => typeof document?.id === "number" &&
      typeof document.file?.name === "string" && isLocal(document.file.place));
    if (!value.documents.some(({ id }) => id === value.activeDocument)) value.activeDocument = null;
    return value;
  } catch (error) {
    reportFrontendError("load_workspace", error);
    return null;
  }
}

export function restorePane(saved?: SavedPane): PaneState {
  if (!saved || !isLocal(saved.place)) return emptyPane;
  const history = Array.isArray(saved.history) ? saved.history.filter(isLocal) : [saved.place];
  const position = Number.isInteger(saved.position) && saved.position >= 0 && saved.position < history.length
    ? saved.position : history.findIndex(({ path }) => path === saved.place?.path);
  return {
    ...emptyPane, place: saved.place, history: position < 0 ? [saved.place] : history, position: Math.max(position, 0),
    selected: typeof saved.selected === "string" ? saved.selected : null,
    marked: Array.isArray(saved.marked) ? saved.marked.filter((name) => typeof name === "string") : [],
    filter: typeof saved.filter === "string" ? saved.filter : "",
    sort: ["name", "size", "modified", "time"].includes(saved.sort?.column) ? saved.sort : emptyPane.sort,
  };
}

function savePane(pane: PaneState, failedFtp?: SavedFtpLocation): SavedPane {
  const { place: shown, history, position, selected, marked, filter, sort } = closeSearchResults(pane);
  const catalog = shown?.kind === "connections";
  const place = catalog ? shown.from : shown;
  const localHistory = history.filter(isLocal);
  const local = isLocal(place);
  const localPosition = local ? history.slice(0, position + 1).filter(isLocal).length - 1 : localHistory.length - 1;
  return {
    place: local ? place : localHistory[localPosition] ?? null,
    history: localHistory, position: localPosition, selected: local && !catalog ? selected : null,
    marked: local && !catalog ? marked : [], filter: local && !catalog ? filter : "", sort,
    ftp: place?.kind === "ftp" ? { profileId: place.profileId, segments: place.segments } : failedFtp,
  };
}

export function saveWorkspace(panes: Record<Side, PaneState>, active: Side, split: number, terminalHeight: number,
  documents: DocumentWindow[], activeDocument: number | null, failedFtp: Partial<Record<Side, SavedFtpLocation>>) {
  const workspace: Workspace = {
    panels: { left: savePane(panes.left, failedFtp.left), right: savePane(panes.right, failedFtp.right) }, active, split, terminalHeight,
    documents: documents.filter(({ file }) => isLocal(file.place)).map(({ id, file, editing }) => ({ id, file, editing })), activeDocument,
  };
  try { localStorage.setItem(storageKey, JSON.stringify(workspace)); }
  catch (error) { reportFrontendError("save_workspace", error); }
}
