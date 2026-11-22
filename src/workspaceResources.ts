import type { NamedFile, Place } from "./api";
import type { PaneState, Side } from "./panes";
import type { Transfer } from "./TransferDialog";

export type Resource = { kind: "archive" | "server" | "ssh" | "ftp"; id: number };
type Comparison = { left: NamedFile; right: NamedFile };
type DocumentOwner = { file: NamedFile; back?: { file: NamedFile }[]; forward?: { file: NamedFile }[] };
interface WorkspaceOwners {
  panes: Record<Side, Pick<PaneState, "place" | "history">>;
  connections: Record<Side, Resource | null>;
  documents: DocumentOwner[];
  comparisons: Comparison[];
  transfer?: Transfer;
  analyzers?: readonly (Place | undefined)[];
}

export function workspaceResources(owners: WorkspaceOwners) {
  const resources = new Map<string, Resource>();
  function retain(place?: Place | Resource | null) {
    if (place?.kind === "connections") retain(place.from);
    else if (place?.kind === "archive" || place?.kind === "server" || place?.kind === "ftp" || place?.kind === "ssh") {
      resources.set(place.kind + ":" + place.id, place);
    }
  }
  for (const pane of Object.values(owners.panes)) { retain(pane.place); pane.history.forEach(retain); }
  Object.values(owners.connections).forEach(retain);
  for (const tab of owners.documents) {
    retain(tab.file.place);
    tab.back?.forEach(({ file }) => retain(file.place));
    tab.forward?.forEach(({ file }) => retain(file.place));
  }
  for (const pair of owners.comparisons) { retain(pair.left.place); retain(pair.right.place); }
  owners.analyzers?.forEach(retain);
  if (owners.transfer) {
    retain(owners.transfer.source); retain(owners.transfer.remoteDestination);
    owners.transfer.items.forEach(({ place }) => retain(place));
  }
  return resources;
}
