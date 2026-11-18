import { useEffect, useState } from "react";
import { placePath, type Place } from "./api";
import { t } from "./i18n";
import type { Side } from "./panes";
import { PathField } from "./PathField";

export function AddressField({ side, place, showHidden, onNavigate, focusFiles }: {
  side: Side;
  place: Place | null;
  showHidden: boolean;
  onNavigate: (path: string) => void;
  focusFiles: () => void;
}) {
  const path = place ? placePath(place) : "";
  const ftp = place?.kind === "ftp" ? place.id : undefined;
  const editable = !place || place.kind === "local" || place.kind === "ftp";
  const addressKey = JSON.stringify([side, place?.kind, ftp, path]);
  const [draft, setDraft] = useState<{ key: string; value: string }>();
  useEffect(() => { setDraft(undefined); }, [addressKey]);

  return <div className="address">
    <PathField key={addressKey} id={side + "-address"} label={t(side === "left" ? "left path" : "right path")}
      suggestionLabel={t(side === "left" ? "left path suggestions" : "right path suggestions")}
      value={draft?.key === addressKey ? draft.value : path} suggestOnFocus={draft?.key === addressKey}
      readOnly={!editable} showHidden={showHidden} ftp={ftp} browse="folder"
      onChange={(value) => setDraft({ key: addressKey, value })}
      onCommit={(value) => {
        if (value === path) return;
        setDraft({ key: addressKey, value });
        onNavigate(value);
        focusFiles();
      }}
      onEscape={() => { setDraft(undefined); focusFiles(); }} />
  </div>;
}
