import { HistoryField } from "./HistoryField";
import { countText, errorText, t } from "./i18n";
import { Button } from "./Button";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Channel } from "@tauri-apps/api/core";
import { api, describeError, placePath, type FileLocation, type FtpSearchEvent } from "./api";
import { Dialog } from "./Dialog";
import { childPlace, readPlace, type SearchMatch } from "./panes";

const previewLimit = 1000;
let nextFtpSearchId = 0;

async function findFtp(
  root: Extract<FileLocation, { kind: "ftp" }>, mask: string, showHidden: boolean, signal: AbortSignal,
  append: (matches: SearchMatch[]) => void,
) {
  const id = ++nextFtpSearchId;
  const output = new Channel<FtpSearchEvent>();
  let stop: () => void = () => {};
  try {
    return await new Promise<number>((resolve, reject) => {
      stop = () => {
        void api.cancelFtpSearch(id).catch(() => {});
        resolve(0);
      };
      signal.addEventListener("abort", stop, { once: true });
      output.onmessage = (event) => {
        if (signal.aborted) return;
        if (event.kind === "done") resolve(event.omitted);
        else {
          const directory = { ...root, segments: event.segments };
          append(event.entries.map((entry) => ({ directory, entry, relativePath: event.prefix + entry.name })));
        }
      };
      void api.searchFtp(id, { connection: root.id, segments: root.segments, mask, showHidden }, output).catch(reject);
    });
  } finally {
    signal.removeEventListener("abort", stop);
    output.onmessage = () => {};
  }
}

function fileMask(mask: string) {
  const pattern = [...mask.toLowerCase()];
  return (name: string) => {
    const letters = [...name.toLowerCase()];
    let fileIndex = 0;
    let maskIndex = 0;
    let wildcard = -1;
    let wildcardEnd = 0;
    // Only the most recent '*' can consume another character.
    while (fileIndex < letters.length) {
      if (pattern[maskIndex] === "*") {
        wildcard = maskIndex++;
        wildcardEnd = fileIndex;
      } else if (pattern[maskIndex] === "?" || pattern[maskIndex] === letters[fileIndex]) {
        fileIndex++;
        maskIndex++;
      } else if (wildcard >= 0) {
        maskIndex = wildcard + 1;
        fileIndex = ++wildcardEnd;
      } else {
        return false;
      }
    }
    while (pattern[maskIndex] === "*") maskIndex++;
    return maskIndex === pattern.length;
  };
}

export async function findFiles(root: FileLocation, mask: string, showHidden: boolean, signal: AbortSignal, append: (matches: SearchMatch[]) => void) {
  if (root.kind === "ftp") return findFtp(root, mask, showHidden, signal, append);
  const includes = fileMask(mask);
  const pending: { place: FileLocation; prefix: string }[] = [{ place: root, prefix: "" }];
  let skipped = 0;
  while (pending.length && !signal.aborted) {
    const folder = pending.pop()!;
    const result = await readPlace(folder.place).catch((failure: unknown) => {
      if (folder.prefix === "") throw failure;
      skipped++;
      return null;
    });
    if (signal.aborted || !result) continue;
    skipped += result.listing.omitted;
    const found: SearchMatch[] = [];
    for (const entry of result.listing.entries) {
      if (entry.hidden && !showHidden) continue;
      const relativePath = folder.prefix + entry.name;
      if (entry.directory) {
        if (!entry.link) pending.push({ place: childPlace(result.place, entry.name), prefix: relativePath + "/" });
      } else if (includes(entry.name)) found.push({ directory: result.place, entry, relativePath });
    }
    if (found.length) append(found);
  }
  return skipped;
}

export function SearchDialog({ root, showHidden, onClose, onReveal, onShowResults }: {
  root: FileLocation;
  showHidden: boolean;
  onClose: () => void;
  onReveal: (directory: FileLocation, name: string) => void;
  onShowResults: (mask: string, matches: readonly SearchMatch[], incomplete: boolean, selected: string) => void;
}) {
  const [mask, setMask] = useState("*");
  const [results, setResults] = useState<SearchMatch[]>([]);
  const [selected, setSelected] = useState("");
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const active = useRef<AbortController | null>(null);
  const snapshot = useRef({ mask: "", matches: [] as SearchMatch[], incomplete: false });
  const maskField = useRef<HTMLInputElement>(null);
  const current = results.find((result) => result.relativePath === selected) ?? results[0];

  useEffect(() => () => active.current?.abort(), []);

  function stop() {
    active.current?.abort();
    active.current = null;
    setRunning(false);
    snapshot.current.incomplete = true;
    setStatus("Search stopped.");
    requestAnimationFrame(() => maskField.current?.focus());
  }

  async function search(event: FormEvent) {
    event.preventDefault();
    if (!mask.trim() || active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setResults([]);
    setSelected("");
    setError("");
    setStatus("Searching…");
    setRunning(true);
    const found: SearchMatch[] = [];
    snapshot.current = { mask, matches: found, incomplete: false };
    try {
      const skipped = await findFiles(root, mask, showHidden, controller.signal, (matches) => {
        const count = found.length;
        for (const match of matches) found.push(match);
        if (count < previewLimit) setResults(found.slice(0, previewLimit));
      });
      if (controller.signal.aborted) return;
      snapshot.current.incomplete = skipped > 0;
      const summary = found.length > previewLimit ? t("{0} matches. Open the results panel to see all matches.", found.length) :
        found.length === 0 ? t("No matching files.") : `${countText(found.length, "match")}.`;
      setStatus(skipped ? t("{0} Some items could not be searched.", summary) : summary);
    } catch (failure) {
      if (!controller.signal.aborted) {
        setStatus("");
        setError(describeError(failure));
      }
    } finally {
      if (active.current === controller) {
        active.current = null;
        if (!controller.signal.aborted) setRunning(false);
      }
    }
  }

  function reveal(result: SearchMatch | undefined) {
    if (result) onReveal(result.directory, result.entry.name);
  }

  return (
    <Dialog title={t("Find files")} onClose={onClose}>
      <form className="dialog-form" onSubmit={(event) => { void search(event); }}>
        <div className="dialog-body search-body">
          <label className="field">{t("File mask")}
            <HistoryField historyKey="file-mask" aria-label={t("File mask")} ref={maskField} data-initial-focus type="text" value={mask} required spellCheck={false}
              disabled={running} maxLength={512} onFocus={(event) => event.currentTarget.select()}
              onValueChange={setMask} />
          </label>
          <p className="search-hint">{t("Use * for any number of characters and ? for one character.")}</p>
          <p className="search-location"><strong>{t("Folder and subfolders")}</strong><span>{placePath(root) || root.kind === "kswitcher" && root.address}</span></p>
          {status && <p role="status">{t(status)}</p>}
          {error && <p role="alert" className="dialog-error">{errorText(error)}</p>}
          {current && (
            <select aria-label={t("Search results")} size={8} value={current.relativePath}
              onChange={(event) => setSelected(event.currentTarget.value)}
              onDoubleClick={(event) => reveal(results.find((result) => result.relativePath === event.currentTarget.value))}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  reveal(current);
                }
              }}>
              {results.map(({ relativePath }) => <option key={relativePath} value={relativePath}>{relativePath}</option>)}
            </select>
          )}
        </div>
        <footer className="dialog-footer">
          <Button type="button" onClick={onClose}>{t("Close")}</Button>
          {current && <Button type="button" onClick={() => reveal(current)}>{t("Go to file")}</Button>}
          {current && !running && <Button type="button" onClick={() => {
            const { mask, matches, incomplete } = snapshot.current;
            onShowResults(mask, matches, incomplete, current.relativePath);
          }}>{t("Show in panel")}</Button>}
          {running ? <Button type="button" onClick={stop}>{t("Stop")}</Button> :
            <Button type="submit" className="primary" disabled={!mask.trim()}>{t("Search")}</Button>}
        </footer>
      </form>
    </Dialog>
  );
}
