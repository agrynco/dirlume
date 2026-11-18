import { useEffect, useRef, useState, type FormEvent } from "react";
import { describeError, placePath, type Place } from "./api";
import { Dialog } from "./Dialog";
import { childPlace, readPlace } from "./panes";

interface Match {
  directory: Place;
  name: string;
  relativePath: string;
}

const resultLimit = 1000;

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

export function SearchDialog({ root, showHidden, onClose, onReveal }: {
  root: Place;
  showHidden: boolean;
  onClose: () => void;
  onReveal: (directory: Place, name: string) => void;
}) {
  const [mask, setMask] = useState("*");
  const [results, setResults] = useState<Match[]>([]);
  const [selected, setSelected] = useState("");
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const active = useRef<AbortController | null>(null);
  const maskField = useRef<HTMLInputElement>(null);
  const current = results.find((result) => result.relativePath === selected) ?? results[0];

  useEffect(() => () => active.current?.abort(), []);

  function stop() {
    active.current?.abort();
    active.current = null;
    setRunning(false);
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
    const includes = fileMask(mask);
    const pending = [{ place: root, prefix: "" }];
    const found: Match[] = [];
    let skipped = 0;
    let truncated = false;
    try {
      while (pending.length && !truncated && !controller.signal.aborted) {
        const folder = pending.pop()!;
        const result = await readPlace(folder.place).catch((failure: unknown) => {
          if (folder.prefix === "") throw failure;
          skipped++;
          return null;
        });
        if (controller.signal.aborted || !result) continue;
        skipped += result.listing.omitted;
        const count = found.length;
        for (const entry of result.listing.entries) {
          if (entry.hidden && !showHidden) continue;
          const relativePath = folder.prefix + entry.name;
          if (entry.directory) {
            if (!entry.link) pending.push({ place: childPlace(result.place, entry.name), prefix: relativePath + "/" });
          } else if (includes(entry.name)) {
            if (found.length === resultLimit) {
              truncated = true;
              break;
            }
            found.push({ directory: result.place, name: entry.name, relativePath });
          }
        }
        if (found.length > count) setResults([...found]);
      }
      if (controller.signal.aborted) return;
      const summary = truncated ? `Showing the first ${resultLimit} matches. Narrow the mask for fewer results.` :
        found.length === 0 ? "No matching files." : `${found.length} ${found.length === 1 ? "match" : "matches"}.`;
      setStatus(skipped ? `${summary} Some items could not be searched.` : summary);
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

  function reveal(result: Match | undefined) {
    if (result) onReveal(result.directory, result.name);
  }

  return (
    <Dialog title="Find files" onClose={onClose}>
      <form className="dialog-form" onSubmit={(event) => { void search(event); }}>
        <div className="dialog-body search-body">
          <label className="field">File mask
            <input ref={maskField} data-initial-focus type="text" value={mask} required spellCheck={false} autoComplete="off"
              disabled={running} maxLength={512} onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setMask(event.target.value)} />
          </label>
          <p className="search-hint">Use * for any number of characters and ? for one character.</p>
          <p className="search-location"><strong>Folder and subfolders</strong><span>{placePath(root) || root.kind === "kswitcher" && root.address}</span></p>
          {status && <p role="status">{status}</p>}
          {error && <p role="alert" className="dialog-error">{error}</p>}
          {current && (
            <select aria-label="Search results" size={8} value={current.relativePath}
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
          <button type="button" onClick={onClose}>Close</button>
          {current && <button type="button" onClick={() => reveal(current)}>Go to file</button>}
          {running ? <button type="button" onClick={stop}>Stop</button> :
            <button type="submit" className="primary" disabled={!mask.trim()}>Search</button>}
        </footer>
      </form>
    </Dialog>
  );
}
