import { useId, useLayoutEffect, useRef, useState } from "react";
import { Bookmark, Pencil, Trash2 } from "lucide-react";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { bookmarkFile, bookmarkKey, fileBookmarkKey, maxBookmarkNameLength, type FileBookmark } from "./fileBookmarks";
import { t } from "./i18n";

function bookmarkTitle(bookmark: FileBookmark) {
  if (bookmark.name) return bookmark.name;
  if ("line" in bookmark) return bookmarkFile(bookmark.path)?.name;
  const quote = bookmark.anchor.quote;
  return quote.length > maxBookmarkNameLength ? quote.slice(0, maxBookmarkNameLength) + "…" : quote;
}

function compareBookmarks(a: FileBookmark, b: FileBookmark) {
  const path = a.path.localeCompare(b.path);
  if (path) return path;
  if ("line" in a && "line" in b) return a.line - b.line;
  if ("anchor" in a && "anchor" in b) return a.anchor.offset - b.anchor.offset;
  return "line" in a ? -1 : 1;
}

export function FileBookmarksDialog({ bookmarks, path, addKey, onOpen, onRename, onRemove, onClose }: {
  bookmarks: readonly FileBookmark[];
  path?: string;
  addKey: string;
  onOpen: (bookmark: FileBookmark) => void;
  onRename: (bookmark: FileBookmark, name: string) => void;
  onRemove: (bookmark: FileBookmark) => void;
  onClose: () => void;
}) {
  const id = useId();
  const list = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState(0);
  const [rename, setRename] = useState<{ bookmark: FileBookmark; value: string } | null>(null);
  const items = bookmarks.filter((item) => !path || bookmarkKey(item.path) === bookmarkKey(path))
    .sort(compareBookmarks);
  const selected = Math.min(cursor, items.length - 1);
  const current = items[selected];
  useLayoutEffect(() => {
    if (selected >= 0) document.getElementById(`${id}-${selected}`)?.scrollIntoView({ block: "nearest" });
  }, [selected, id]);

  function open() { if (current) onOpen(current); }
  function beginRename() { if (current) setRename({ bookmark: current, value: current.name ?? "" }); }
  function remove() {
    if (!current) return;
    onRemove(current);
    list.current?.focus({ preventScroll: true });
  }

  return <>
    <Dialog title={t("File bookmarks")} helpTopic="fileBookmarks" wide resizeKey="file-bookmarks" onClose={onClose} footer={<>
      <Button type="button" disabled={!current} onClick={beginRename}><Pencil aria-hidden="true" />{t("Rename")}</Button>
      <Button type="button" disabled={!current} onClick={remove}><Trash2 aria-hidden="true" />{t("Remove")}</Button>
      <Button type="button" onClick={onClose}>{t("Close")}</Button>
      <Button type="button" className="primary" disabled={!current} onClick={open}>{t("Open")}</Button>
    </>}>
      <div className="dialog-body file-bookmarks">
        {path && !items.length && <p className="file-bookmarks-path">{path}</p>}
        {items.length ? <div ref={list} className="file-bookmark-list" role="listbox" tabIndex={0} data-initial-focus
          aria-label={t("File bookmarks")} aria-activedescendant={`${id}-${selected}`} onKeyDown={(event) => {
            if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
            if (event.key === "Enter") open();
            else if (event.key === "Home") setCursor(0);
            else if (event.key === "End") setCursor(items.length - 1);
            else if (event.key === "ArrowDown") setCursor(Math.min(items.length - 1, selected + 1));
            else if (event.key === "ArrowUp") setCursor(Math.max(0, selected - 1));
            else return;
            event.preventDefault();
          }}>
          {items.map((item, index) => <div key={fileBookmarkKey(item)} id={`${id}-${index}`} role="option" aria-selected={index === selected}
            className="file-bookmark-row" onClick={() => { setCursor(index); list.current?.focus({ preventScroll: true }); }}
            onDoubleClick={() => onOpen(item)}>
            <Bookmark aria-hidden="true" />
            <span><strong>{bookmarkTitle(item)}</strong><small>{item.path}</small></span>
            <span>{"line" in item ? t("Line {0}", item.line) : t("Preview")}</span>
          </div>)}
        </div> : <p role="status">{addKey ? t("Click beside a line number in the text Viewer or press {0} to bookmark a line.", addKey) :
          t("Click beside a line number in the text Viewer to bookmark a line.")}</p>}
      </div>
    </Dialog>
    {rename && <Dialog title={t("Rename bookmark")} onClose={() => setRename(null)}>
      <form className="dialog-form" onSubmit={(event) => {
        event.preventDefault();
        onRename(rename.bookmark, rename.value.trim());
        setRename(null);
      }}>
        <div className="dialog-body"><label className="field">{t("Bookmark name")}
          <input autoComplete="off" data-initial-focus maxLength={maxBookmarkNameLength} value={rename.value}
            onChange={(event) => setRename({ ...rename, value: event.target.value })} />
        </label></div>
        <footer className="dialog-footer">
          <Button type="button" onClick={() => setRename(null)}>{t("Cancel")}</Button>
          <Button type="submit" className="primary">{t("Save")}</Button>
        </footer>
      </form>
    </Dialog>}
  </>;
}
