import { isWritableServerPlace, type Entry, type FilePlace, type Place, type WritableServerPlace } from "./api";

type CreatablePlace = Exclude<FilePlace, { kind: "server" }> | WritableServerPlace;

export function fileSourceActions(place: Place | null) {
  switch (place?.kind) {
    case "local":
    case "ftp":
    case "ssh":
    case "googleDrive": return { copy: true, create: true, rename: true, remove: true, renameLink: true };
    case "archive": return { copy: true, create: place.canAdd, rename: place.canAdd, remove: place.writable, renameLink: false };
    case "server": {
      const writable = isWritableServerPlace(place);
      return { copy: true, create: writable, rename: writable, remove: writable, renameLink: false };
    }
    case "kswitcher": return { copy: !!place.path, create: !!place.path, rename: !!place.capabilities?.write,
      remove: !!place.capabilities?.delete, renameLink: false };
    case "connections":
    case "smbRoot":
    case undefined: return { copy: false, create: false, rename: false, remove: false, renameLink: false };
  }
}

export function canCreateIn(place: Place | null): place is CreatablePlace {
  return fileSourceActions(place).create;
}

export function canRenameItem(place: FilePlace, entry: Entry) {
  const actions = fileSourceActions(place);
  return actions.rename && (!entry.link || actions.renameLink);
}
