import { useEffect, useState, type FormEvent } from "react";
import { api, describeError, placePath, type Entry, type FileAttributes, type FileFlag, type Place } from "./api";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { errorText, t } from "./i18n";
import { formatDate } from "./panes";

const labels: Record<FileFlag, string> = {
  readOnly: "Read-only",
  archive: "Archive",
  hidden: "Hidden",
  system: "System attribute",
  compressed: "Compressed",
  encrypted: "Encrypted",
  notIndexed: "Not indexed",
  ownerWritable: "Owner writable",
};

function listingAttributes(entry: Entry): FileAttributes {
  const flags: FileAttributes["flags"] = [{ flag: "hidden", enabled: entry.hidden, writable: false }];
  if (entry.system !== undefined) flags.push({ flag: "system", enabled: entry.system, writable: false });
  return { flags, created: null, accessed: null, modified: entry.modified, owner: null, mode: null };
}

export function AttributesDialog({ item, onClose, onApplied }: {
  item: { place: Place; entry: Entry };
  onClose: () => void;
  onApplied: () => void;
}) {
  const directory = item.place.kind === "local" ? item.place.path : null;
  const { name } = item.entry;
  const [attributes, setAttributes] = useState<FileAttributes | null>(() => directory ? null : listingAttributes(item.entry));
  const [draft, setDraft] = useState<Partial<Record<FileFlag, boolean>>>({});
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (!directory) return;
    let open = true;
    void api.fileAttributes(directory, name).then(
      (result) => { if (open) setAttributes(result); },
      (failure: unknown) => { if (open) setError(describeError(failure)); },
    );
    return () => { open = false; };
  }, [directory, name]);
  const loading = Boolean(directory && !attributes && !error);

  const changes = (attributes?.flags ?? []).flatMap(({ flag, enabled, writable }) => {
    const next = draft[flag];
    return writable && next !== undefined && next !== enabled ? [{ flag, enabled: next }] : [];
  });

  async function apply(event: FormEvent) {
    event.preventDefault();
    if (!directory || !changes.length || busy) return;
    setBusy(true);
    setStatus("");
    setError("");
    try {
      setAttributes(await api.updateFileAttributes(directory, name, changes));
      setStatus(t("Attributes saved."));
    } catch (failure) {
      setError(describeError(failure));
      setAttributes(await api.fileAttributes(directory, name).catch(() => null));
    } finally {
      setDraft({});
      setBusy(false);
      onApplied();
    }
  }

  const metadata: [string, string | null][] = attributes ? [
    ["Created", attributes.created === null ? null : formatDate(attributes.created)],
    ["Last accessed", attributes.accessed === null ? null : formatDate(attributes.accessed)],
    ["Modified", attributes.modified === null ? null : formatDate(attributes.modified)],
    ["Owner", attributes.owner],
  ] : [];
  if (attributes?.mode) metadata.push(["Permissions", attributes.mode]);

  return (
    <Dialog title={t("Attributes")} onClose={() => { if (!busy) onClose(); }}>
      <form className="dialog-form" onSubmit={(event) => void apply(event)}>
        <div className="dialog-body attributes-body" aria-busy={busy || loading}>
          <div className="attribute-target"><strong>{name}</strong><p>{placePath(item.place)}</p></div>
          {attributes && <>
            <fieldset>
              <legend>{t("File attributes")}</legend>
              <div className="attribute-flags">
                {(Object.keys(labels) as FileFlag[]).map((flag) => {
                  const value = attributes.flags.find((value) => value.flag === flag);
                  if (flag === "ownerWritable" && !value) return null;
                  return <label key={flag} className="attribute-flag">
                    <input type="checkbox" checked={draft[flag] ?? value?.enabled ?? false}
                      disabled={busy || !value?.writable} onChange={(event) => {
                        setDraft({ ...draft, [flag]: event.target.checked });
                        setStatus("");
                      }} />
                    <span>{t(labels[flag])}</span>
                    {!value && <small>{t("Unavailable")}</small>}
                  </label>;
                })}
              </div>
            </fieldset>
            <dl className="attribute-metadata">
              {metadata.map(([label, value]) => <div key={label}>
                <dt>{t(label)}</dt><dd>{value ?? t("Unavailable")}</dd>
              </div>)}
            </dl>
          </>}
          {loading && <p role="status">{t("Reading attributes…")}</p>}
          {status && <p role="status">{status}</p>}
          {error && <p role="alert" className="dialog-error">{errorText(error)}</p>}
        </div>
        <footer className="dialog-footer">
          <Button type="button" onClick={onClose} disabled={busy}>{t("Cancel")}</Button>
          <Button type="submit" className="primary" disabled={busy || !changes.length}>{t("Apply")}</Button>
        </footer>
      </form>
    </Dialog>
  );
}
