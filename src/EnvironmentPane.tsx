import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ArrowUp, Braces } from "lucide-react";
import {
  api, windowsClient, type EnvironmentEdit, type EnvironmentInfo, type EnvironmentKind, type EnvironmentOutcome,
  type EnvironmentRow, type EnvironmentSave, type EnvironmentScope, type EnvironmentValue,
} from "./api";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { t } from "./i18n";
import type { Side } from "./panes";
import { bindingMatches, eventShortcut, type Bindings, type Command } from "./preferences";

export type EnvironmentMode = "root" | EnvironmentScope;
const scopes: Readonly<Record<EnvironmentScope, string>> = {
  user: "User variables", system: "System variables", process: "Dirlume process environment",
};
const scopeModes = Object.keys(scopes) as EnvironmentScope[];
const outcomes: Readonly<Record<EnvironmentOutcome, string>> = {
  saved: "Saved", conflict: "Changed since review", invalid: "Invalid name or value",
  denied: "Authorization declined or access denied", failed: "Could not save",
};
const pathName = (name: string) => windowsClient ? name.toUpperCase() === "PATH" : name === "PATH";
const scopeName = (mode: EnvironmentMode) => t(mode === "root" ? "Environment variables" : scopes[mode]);

type ScopeListing = Awaited<ReturnType<typeof api.environmentScope>>;
type DialogState = { kind: "inspect" | "edit"; name: string } | { kind: "new" | "integrate" }
  | { kind: "copy"; names: string[]; to: EnvironmentScope };

function Source({ scope, info, value }: { scope: EnvironmentScope; info: EnvironmentInfo; value?: EnvironmentValue | null }) {
  return <dl className="environment-source">
    <dt>{t("Scope")}</dt><dd>{scopeName(scope)}</dd>
    <dt>{t("Definition source")}</dt><dd>{value?.source ?? info.target}</dd>
    {value?.overriddenBy && <><dt>{t("Overridden by")}</dt><dd>{value.overriddenBy}</dd></>}
    <dt>{t("Applies to")}</dt><dd>{t(info.activation)}</dd>
  </dl>;
}

function ValueDialog({ scope, info, kind, name, close, changed }: {
  scope: EnvironmentScope;
  info: EnvironmentInfo;
  kind: "inspect" | "edit" | "new";
  name: string;
  close: () => void;
  changed: () => void;
}) {
  const form = useId();
  const [draftName, setName] = useState(name);
  const [draft, setDraft] = useState("");
  const [valueKind, setKind] = useState<EnvironmentKind>("literal");
  const [expected, setExpected] = useState<EnvironmentValue | null>(null);
  const [loaded, setLoaded] = useState(kind === "new");
  const [review, setReview] = useState<EnvironmentValue | null>(null);
  const [replacePath, setReplacePath] = useState(false);
  const [confirmReplacement, setConfirmReplacement] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const nameField = useRef<HTMLInputElement>(null);
  const valueField = useRef<HTMLTextAreaElement>(null);
  const editable = kind !== "inspect";
  const pathReplacement = !!expected && pathName(draftName);

  useLayoutEffect(() => {
    if (kind === "edit" && loaded && document.activeElement === nameField.current) {
      valueField.current?.focus();
    }
  }, [kind, loaded]);

  useEffect(() => {
    if (kind === "new") return;
    let ignored = false;
    void api.environmentValue(scope, name).then((value) => {
      if (ignored) return;
      if (!value) {
        setError(t("The variable is no longer available."));
        return;
      }
      setExpected(value);
      setDraft(value.value);
      setKind(value.kind);
      setLoaded(true);
    }, () => { if (!ignored) setError(t("Could not read the environment variable.")); });
    return () => { ignored = true; };
  }, [scope, kind, name]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !editable || !loaded || !draftName || pathReplacement && !replacePath ||
        kind === "new" && expected && !confirmReplacement) return;
    setError("");
    setBusy(true);
    try {
      const result = await api.saveEnvironment(scope, [{ name: draftName, value: draft, kind: valueKind, expected, replacePath }]);
      const outcome = result.outcomes[0]?.result ?? "failed";
      if (outcome === "saved") {
        changed();
        close();
        return;
      }
      setError(t(outcomes[outcome]));
      if (outcome === "conflict") {
        const latest = await api.environmentValue(scope, draftName);
        setReview(latest);
        setReplacePath(false);
        if (!latest) setExpected(null);
      }
    } catch {
      setError(t("Could not save the environment variable."));
    } finally {
      setBusy(false);
    }
  }

  return <Dialog title={t(kind === "inspect" ? "Inspect environment variable" : kind === "edit" ? "Edit environment variable" : "New environment variable")}
    onClose={busy ? undefined : close} helpTopic="terminal" footer={<>
      <Button onClick={close} disabled={busy}>{t(editable ? "Cancel" : "Close")}</Button>
      {editable && <Button className="primary" type="submit" form={form} disabled={!loaded || busy || !draftName || !!review ||
        pathReplacement && !replacePath || kind === "new" && !!expected && !confirmReplacement}>{t("Save")}</Button>}
    </>}>
    <form id={form} className="dialog-body environment-form" onSubmit={(event) => void submit(event)}>
      <div className="environment-field-row">
        <label className="field">{t("Variable name")}<input ref={nameField} value={draftName} readOnly={kind !== "new" || busy}
          data-initial-focus={editable || undefined}
          onChange={(event) => {
            setName(event.target.value);
            setReview(null);
            setExpected(null);
            setConfirmReplacement(false);
            setReplacePath(false);
          }} /></label>
        {info.expandable && loaded && <label className="field">{t("Value type")}<select value={valueKind} disabled={!editable || busy}
          onChange={(event) => setKind(event.target.value as EnvironmentKind)}>
          <option value="literal">{t("String")}</option><option value="expandable">{t("Expandable string")}</option>
        </select></label>}
      </div>
      {loaded && <label className="field">{t("Value")}<textarea ref={valueField} spellCheck={false} value={draft} readOnly={!editable || busy}
        onChange={(event) => setDraft(event.target.value)} /></label>}
      <Source scope={scope} info={info} value={expected} />
      {review && <div className="environment-review">
        <label className="field">{t("Current saved value")}<textarea readOnly value={review.value} /></label>
        <Button type="button" onClick={() => {
          setExpected(review); setReview(null); setConfirmReplacement(true); setError("");
        }}>{t("Use current definition for review")}</Button>
      </div>}
      {pathReplacement && editable && <label className="environment-check"><input type="checkbox" checked={replacePath}
        onChange={(event) => setReplacePath(event.target.checked)} />{t("Replace the entire destination PATH definition.")}</label>}
      {error && <p className="dialog-error" role="alert">{error}</p>}
      {!loaded && !error && <p role="status">{t("Loading environment variable…")}</p>}
    </form>
  </Dialog>;
}

type CopyRow = {
  source: EnvironmentValue;
  destination: EnvironmentValue | null;
  choice: "copy" | "replace" | "skip" | "pending";
  replacePath: boolean;
};

function sameValue(left: EnvironmentValue | null, right: EnvironmentValue) {
  return !!left && left.name === right.name && left.source === right.source && left.value === right.value && left.kind === right.kind;
}

function CopyDialog({ scope, to, names, close, changed }: {
  scope: EnvironmentScope;
  to: EnvironmentScope;
  names: string[];
  close: () => void;
  changed: () => void;
}) {
  const [rows, setRows] = useState<CopyRow[] | null>(null);
  const [destination, setDestination] = useState<EnvironmentInfo | null>(null);
  const [error, setError] = useState("");
  const [result, setResult] = useState<EnvironmentSave | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let ignored = false;
    void Promise.all([api.environmentScope(to), Promise.all(names.map(async (name): Promise<CopyRow> => {
      const [source, destination] = await Promise.all([api.environmentValue(scope, name), api.environmentValue(to, name)]);
      if (!source) throw new Error();
      return { source, destination, choice: destination ? "pending" : "copy", replacePath: false };
    }))]).then(([listing, rows]) => {
      if (ignored) return;
      setRows(rows);
      setDestination(listing.info);
    }, () => { if (!ignored) setError(t("Could not read the variables for review.")); });
    return () => { ignored = true; };
  }, [scope, to, names, reload]);

  function update(name: string, patch: Partial<CopyRow>) {
    setRows((rows) => rows?.map((row) => row.source.name === name ? { ...row, ...patch } : row) ?? null);
  }

  async function copy() {
    if (!rows || busy) return;
    setBusy(true);
    setError("");
    try {
      const edits: EnvironmentEdit[] = [];
      const changedSources: EnvironmentSave["outcomes"] = [];
      for (const row of rows) {
        if (row.choice !== "copy" && row.choice !== "replace") continue;
        const latest = await api.environmentValue(scope, row.source.name);
        if (!sameValue(latest, row.source)) {
          changedSources.push({ name: row.source.name, result: "conflict" });
        } else {
          edits.push({ name: row.source.name, value: row.source.value, kind: row.source.kind,
            expected: row.destination, replacePath: row.replacePath });
        }
      }
      const saved = edits.length ? await api.saveEnvironment(to, edits) : { outcomes: [], integration: null };
      setResult({ ...saved, outcomes: [...saved.outcomes, ...changedSources] });
      if (saved.outcomes.some(({ result }) => result === "saved")) changed();
    } catch {
      setError(t("Could not copy the selected environment variables."));
    } finally {
      setBusy(false);
    }
  }

  return <Dialog title={t("Copy environment variables")} onClose={busy ? undefined : close} helpTopic="terminal" wide footer={<>
    <Button onClick={close} disabled={busy}>{t(result ? "Close" : "Cancel")}</Button>
    {result ? result.outcomes.some(({ result }) => result !== "saved") && <Button onClick={() => {
      setRows(null); setError(""); setResult(null); setReload((value) => value + 1);
    }}>{t("Review current definitions")}</Button> :
      <Button disabled={!rows || busy || rows.some((row) => row.choice === "pending" ||
        row.choice === "replace" && pathName(row.source.name) && !row.replacePath)} onClick={() => void copy()}>{t("Copy")}</Button>}
  </>}>
    <p>{t("{0} → {1}", scopeName(scope), scopeName(to))}</p>
    {destination && <Source scope={to} info={destination} />}
    {rows && <ul className="environment-copy">
      {rows.map((row) => {
        const outcome = result?.outcomes.find(({ name }) => name === row.source.name)?.result;
        return <li key={row.source.name}>
          <strong>{row.source.name}</strong>
          {!result && row.destination && <select aria-label={t("Action for {0}", row.source.name)} value={row.choice}
            disabled={busy} onChange={(event) => update(row.source.name, { choice: event.target.value as CopyRow["choice"] })}>
            <option value="pending">{t("Choose an action")}</option>
            <option value="replace">{t("Replace")}</option><option value="skip">{t("Skip")}</option>
          </select>}
          {!result && !row.destination && <label className="environment-check">
            <input type="checkbox" checked={row.choice === "copy"} disabled={busy}
              onChange={(event) => update(row.source.name, { choice: event.target.checked ? "copy" : "skip" })} />{t("Copy")}
          </label>}
          {result && <span role="status">{t(outcome === "saved" ? "Copied" : outcome ? outcomes[outcome] : "Skipped")}</span>}
          <details><summary>{t("Inspect values")}</summary>
            <label>{t("Source value")}<textarea readOnly value={row.source.value} /></label>
            {row.destination && <label>{t("Destination value")}<textarea readOnly value={row.destination.value} /></label>}
          </details>
          {!result && row.choice === "replace" && pathName(row.source.name) && <label className="environment-check">
            <input type="checkbox" checked={row.replacePath} disabled={busy} onChange={(event) =>
              update(row.source.name, { replacePath: event.target.checked })} />{t("Replace the entire destination PATH definition.")}
          </label>}
        </li>;
      })}
    </ul>}
    {error && <p role="alert">{error}</p>}
    {!rows && !error && <p role="status">{t("Loading environment variables…")}</p>}
  </Dialog>;
}

function IntegrationDialog({ scope, info, close, changed }: {
  scope: EnvironmentScope;
  info: EnvironmentInfo;
  close: () => void;
  changed: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function enable() {
    setBusy(true);
    setError("");
    try {
      const { integration } = await api.saveEnvironment(scope, [], true);
      if (integration === "saved") { changed(); close(); }
      else setError(t(outcomes[integration ?? "failed"]));
    } catch {
      setError(t("Could not enable login shell integration."));
    } finally {
      setBusy(false);
    }
  }
  return <Dialog title={t("Enable login shell integration")} onClose={busy ? undefined : close} helpTopic="terminal" footer={<>
    <Button onClick={close} disabled={busy}>{t("Cancel")}</Button>
    <Button onClick={() => void enable()} disabled={busy}>{t("Enable")}</Button>
  </>}>
    <Source scope={scope} info={info} />
    <p>{t("Dirlume will add a startup hook to this file.")}</p>
    <p><code>{info.startupFile}</code></p>
    {error && <p role="alert">{error}</p>}
  </Dialog>;
}

export default function EnvironmentPane({ side, active, mode, oppositeMode, shortcuts, revision, onMode, onFocus, onClose, onChanged }: {
  side: Side;
  active: boolean;
  mode: EnvironmentMode;
  oppositeMode: EnvironmentMode | null;
  shortcuts: Bindings;
  revision: number;
  onMode: (mode: EnvironmentMode) => void;
  onFocus: () => void;
  onClose: () => void;
  onChanged: () => void;
}) {
  const title = useId();
  const list = useRef<HTMLDivElement>(null);
  const scope = mode === "root" ? null : mode;
  const [listing, setListing] = useState<ScopeListing | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState("");
  const [rootSelection, setRootSelection] = useState<EnvironmentScope>("user");
  const [marked, setMarked] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const rows = listing?.rows.filter(({ name }) => name.toLocaleLowerCase().includes(filter.toLocaleLowerCase())) ?? [];
  const chosen = rows.find(({ name }) => name === selected) ?? rows[0];
  const copyTo = scope && scope !== "process" && (oppositeMode === "user" || oppositeMode === "system") &&
    oppositeMode !== scope ? oppositeMode : null;

  useLayoutEffect(() => { list.current?.focus(); }, [mode]);
  useEffect(() => {
    if (!scope) return;
    let ignored = false;
    setError("");
    void api.environmentScope(scope).then((listing) => {
      if (ignored) return;
      setListing(listing);
      setMarked((marked) => marked.filter((name) => listing.rows.some((row) => row.name === name)));
    }, () => { if (!ignored) setError(t("Could not read the selected environment scope.")); });
    return () => { ignored = true; };
  }, [scope, refresh, revision]);

  function navigate(mode: EnvironmentMode) {
    setListing(null);
    setFilter("");
    setSelected("");
    setMarked([]);
    setError("");
    onMode(mode);
  }

  function inspect(kind: "inspect" | "edit", row: EnvironmentRow) {
    if (kind === "edit" && scope === "process") return;
    setDialog({ kind, name: row.name });
  }

  function copy() {
    const names = marked.length ? marked : chosen ? [chosen.name] : [];
    if (copyTo && names.length) setDialog({ kind: "copy", names, to: copyTo });
  }

  function keyDown(event: KeyboardEvent) {
    if (event.defaultPrevented || event.nativeEvent.isComposing || dialog || event.target instanceof HTMLInputElement) return;
    const key = eventShortcut(event);
    const matches = (command: Command) => bindingMatches(shortcuts[command], key);
    if (!scope) {
      const index = scopeModes.indexOf(rootSelection);
      if (matches("open")) navigate(rootSelection);
      else if (matches("upRow")) setRootSelection(scopeModes[Math.max(0, index - 1)]);
      else if (matches("downRow")) setRootSelection(scopeModes[Math.min(scopeModes.length - 1, index + 1)]);
      else return;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const index = rows.indexOf(chosen);
    if (matches("refresh")) setRefresh((value) => value + 1);
    else if (matches("parent") || matches("back")) navigate("root");
    else if (matches("newFile") && scope !== "process" && listing) setDialog({ kind: "new" });
    else if (matches("copy")) copy();
    else if (chosen && (matches("open") || matches("view"))) inspect("inspect", chosen);
    else if (chosen && matches("edit")) inspect("edit", chosen);
    else if (chosen && matches("mark") && scope !== "process") {
      setMarked((marked) => marked.includes(chosen.name) ? marked.filter((name) => name !== chosen.name) : [...marked, chosen.name]);
    } else {
      const next = matches("upRow") ? index - 1 : matches("downRow") ? index + 1 :
        matches("firstRow") ? 0 : matches("lastRow") ? rows.length - 1 : null;
      if (next === null || !rows.length) return;
      const target = Math.min(rows.length - 1, Math.max(0, next));
      setSelected(rows[target].name);
      list.current?.querySelectorAll("[data-variable]")[target]?.scrollIntoView({ block: "nearest" });
    }
    event.preventDefault();
    event.stopPropagation();
  }

  return <section className={"pane environment-pane environment-" + side + (active ? " active" : "")}
    aria-labelledby={title} data-help-topic="terminal" onFocus={onFocus} onKeyDown={keyDown}>
    <header className="pane-heading"><span className="pane-title" id={title}><Braces />{scopeName(mode)}</span>
      {scope && <Button className="icon-button" aria-label={t("Parent folder")} onClick={() => navigate("root")}><ArrowUp /></Button>}
      <Button onClick={onClose}>{t("Back to files")}</Button>
    </header>
    {scope && <input className="environment-filter" type="search" aria-label={t("Filter variables")} placeholder={t("Filter variables")}
      value={filter} onChange={(event) => setFilter(event.target.value)} />}
    <div className="environment-list" id={side + "-environment"} tabIndex={0} ref={list}>
      {!scope ? scopeModes.map((scope) => <Button key={scope} aria-pressed={scope === rootSelection}
        onFocus={() => setRootSelection(scope)} onClick={() => navigate(scope)}>{scopeName(scope)}</Button>) :
        error ? <p className="pane-empty" role="alert">{error}</p> :
          listing ? rows.length ? <div role="listbox" aria-label={scopeName(scope)}>
            {rows.map((row) => <Button key={row.name} role="option" aria-selected={chosen === row}
              data-variable={row.name} data-marked={marked.includes(row.name) || undefined} tabIndex={-1}
              onClick={() => { setSelected(row.name); list.current?.focus({ preventScroll: true }); }}
              onDoubleClick={() => inspect("inspect", row)}>
              <strong>{row.name}</strong><span>{row.source}
                {row.overriddenBy && <> · {t("Overridden by")} {row.overriddenBy}</>}</span>
            </Button>)}
          </div> : <p className="pane-empty">{t(filter ? "No matching variables." : "No variables in this scope.")}</p> :
            <p className="pane-empty" role="status">{t("Loading environment variables…")}</p>}
    </div>
    {scope && <div className="environment-actions">
      <Button onClick={() => setRefresh((value) => value + 1)}>{t("Refresh")}</Button>
      <Button disabled={!chosen} onClick={() => chosen && inspect("inspect", chosen)}>{t("Inspect")}</Button>
      {scope !== "process" && <>
        <Button disabled={!chosen} onClick={() => chosen && inspect("edit", chosen)}>{t("Edit")}</Button>
        <Button disabled={!listing} onClick={() => setDialog({ kind: "new" })}>{t("New variable")}</Button>
        <Button disabled={!copyTo || !chosen && !marked.length} onClick={copy}>{t("Copy")}</Button>
      </>}
      {listing?.info.startupFile && !listing.info.integrationEnabled &&
        <Button onClick={() => setDialog({ kind: "integrate" })}>{t("Enable login shell integration")}</Button>}
    </div>}
    {dialog && scope && listing && (dialog.kind === "copy" ?
      <CopyDialog scope={scope} to={dialog.to} names={dialog.names} close={() => setDialog(null)} changed={onChanged} /> :
      dialog.kind === "integrate" ? <IntegrationDialog scope={scope} info={listing.info} close={() => setDialog(null)} changed={onChanged} /> :
        <ValueDialog scope={scope} info={listing.info} kind={dialog.kind} name={"name" in dialog ? dialog.name : ""}
          close={() => setDialog(null)} changed={onChanged} />)}
  </section>;
}
