import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Pencil, Play, Plus } from "lucide-react";
import { api, describeError, windowsClient } from "./api";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { errorText, t } from "./i18n";
import { changeMenuLevel, menuLevel, menuPreview, menuTokens, menuValues, menuVisible,
  type MenuContext, type MenuEntry, type MenuRun, type MenuSource, type MenuVisibility } from "./userMenu";

type Command = Extract<MenuEntry, { kind: "command" }>;
type Editable = Exclude<MenuEntry, { kind: "separator" }>;
const newCommand = (): Command => ({ kind: "command", label: "", hotkey: "", visibility: "always", mask: "", steps: [""], prompts: [] });
const separator: MenuEntry = { kind: "separator" };
const rules: Record<MenuVisibility, string> = { always: "Always", selection: "Has marked items", file: "Focused item is a file", folder: "Focused item is a folder" };
const menuChanged = "The menu definition changed on disk. Reload before continuing.";

export function UserMenuDialog({ context, onRun, onClose }: {
  context: MenuContext; onRun: (run: MenuRun) => boolean; onClose: () => void;
}) {
  const [sources, setSources] = useState<MenuSource[]>([]);
  const [path, setPath] = useState("");
  const [level, setLevel] = useState<number[]>([]);
  const [selected, setSelected] = useState<number>();
  const [showHidden, setShowHidden] = useState(false);
  const [managing, setManaging] = useState(false);
  const [draft, setDraft] = useState<MenuEntry[]>();
  const [editor, setEditor] = useState<{ index?: number; entry: Editable }>();
  const [parameters, setParameters] = useState<{ entry: Command; index: number; inputs: Record<string, string> }>();
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const sourceField = useRef<HTMLSelectElement>(null);
  const hiddenField = useRef<HTMLInputElement>(null);
  const newCommandButton = useRef<HTMLButtonElement>(null);
  const firstField = useRef<HTMLInputElement>(null);
  const stepsField = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let active = true;
    void api.userMenuSources(context.folder).then((next) => {
      if (!active) return;
      setSources(next);
      const first = next[0];
      setPath((first?.revision || first?.error) ? first.path : next.find(({ personal }) => personal)?.path ?? "");
    }, (failure) => { if (active) setError(describeError(failure)); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [context.folder]);

  const source = sources.find((candidate) => candidate.path === path);
  const entries = draft ?? source?.entries ?? [];
  const items = menuLevel(entries, level);
  const rows = items.flatMap((entry, index) => {
    const runnable = menuVisible(entry, context, windowsClient);
    return runnable || showHidden || managing ? [{ entry, index, runnable }] : [];
  });
  const selectable = rows.filter(({ entry }) => managing || entry.kind !== "separator");
  const currentIndex = selectable.some(({ index }) => selected === index) ? selected :
    (managing ? selectable[0] : selectable.find((row) => row.runnable) ?? selectable[0])?.index;
  const current = rows.find(({ index }) => index === currentIndex);
  const values = menuValues(context);
  const dirty = draft !== undefined;
  const sourceVersion = source ? { folder: context.folder, path: source.path, revision: source.revision } : undefined;
  const editable = !!source?.writable && !source.error;
  const hasEntries = selectable.length > 0;
  const hasHiddenEntries = items.some((entry) => entry.kind !== "separator" && !menuVisible(entry, context, windowsClient));
  const empty = !!source && !source.error && items.length === 0;
  const promptPreview = parameters?.entry.steps.map((step) => menuPreview(step, menuValues(context, parameters.inputs), true));

  useLayoutEffect(() => {
    if (editor || parameters) firstField.current?.focus();
    else if (!review && !busy) (list.current ?? newCommandButton.current ?? hiddenField.current ?? sourceField.current)?.focus({ preventScroll: true });
  }, [Boolean(editor), Boolean(parameters), review, path, busy, managing, level.length, hasEntries]);
  useLayoutEffect(() => {
    if (!editor && !parameters && !review && currentIndex !== undefined) {
      list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
    }
  }, [Boolean(editor), Boolean(parameters), review, path, currentIndex, level]);

  function choose(path: string) {
    setPath(path);
    setLevel([]);
    setSelected(undefined);
    setError("");
    setNotice("");
  }

  function goBack() {
    setSelected(level.at(-1));
    setLevel(level.slice(0, -1));
    setNotice("");
  }

  function close() {
    if (busy) return;
    if (parameters) setParameters(undefined);
    else if (editor) cancelEditor();
    else if (review) setReview(false);
    else if (level.length) goBack();
    else if (managing) { if (!dirty) setManaging(false); }
    else onClose();
  }

  function begin(command: Command, index: number, inputs?: Record<string, string>) {
    if (!sourceVersion || !source?.approved || managing) return;
    const argumentsByName = inputs ?? Object.fromEntries(command.prompts.map(({ name, initial }) => [name, initial]));
    const missing = command.steps.flatMap((step) => menuPreview(step, menuValues(context, argumentsByName), true).missing);
    if (missing.length) { setError(t("No value is available for {0}.", [...new Set(missing)].join(", "))); return; }
    if (command.prompts.length && inputs === undefined) {
      setError("");
      setParameters({ entry: command, index, inputs: argumentsByName });
      return;
    }
    if (!onRun({ source: sourceVersion, index: [...level, index], opposite: context.opposite,
      marked: context.marked, focused: context.focused?.path ?? null, inputs: argumentsByName })) {
      setError(t("Stop or wait for the current User Menu command."));
    }
  }

  function activate(row: typeof current) {
    if (!row || busy) return;
    setSelected(row.index);
    if (row.entry.kind === "submenu") { setLevel([...level, row.index]); setSelected(undefined); setNotice(""); }
    else if (row.entry.kind === "command" && row.runnable && !managing) {
      if (!source?.approved) setReview(true);
      else begin(row.entry, row.index);
    } else if (row.entry.kind !== "separator" && managing && editable) {
      edit(row);
    }
  }

  function change(change: (items: MenuEntry[]) => MenuEntry[]) {
    setDraft(changeMenuLevel(entries, level, change));
    setError("");
  }

  function reorder(offset: -1 | 1) {
    if (currentIndex === undefined || !editable) return;
    const next = currentIndex + offset;
    if (next < 0 || next >= items.length) return;
    change((items) => { const moved = [...items]; [moved[next], moved[currentIndex]] = [moved[currentIndex], moved[next]]; return moved; });
    setSelected(next);
  }

  function add(entry: Editable) { setError(""); setNotice(""); setEditor({ entry }); }

  function edit(row: NonNullable<typeof current>) {
    if (row.entry.kind === "separator") return;
    setError("");
    setNotice("");
    setEditor({ index: row.index, entry: row.entry });
  }

  function cancelEditor() {
    setError("");
    setNotice("");
    setEditor(undefined);
  }

  async function commitEditor() {
    if (!editor || busy || !editable) return;
    const { entry, index } = editor;
    const hotkey = entry.hotkey.trim().toUpperCase();
    if (hotkey && (!/^(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4]))$/.test(hotkey) ||
        items.some((other, i) => i !== index && other.kind !== "separator" && other.hotkey.toUpperCase() === hotkey))) {
      setError(t("Choose a unique letter, digit, or function key in this menu."));
      return;
    }
    if (!entry.label.trim() || (entry.kind === "command" && (entry.steps.some((step) => !step.trim()) ||
        entry.prompts.some((prompt, i) => !/^\w+$/.test(prompt.name) || !prompt.label.trim() ||
          entry.prompts.findIndex(({ name }) => name === prompt.name) !== i)))) {
      setError(t("Enter a label, nonempty steps, and unique named prompts."));
      return;
    }
    const next = { ...entry, label: entry.label.trim(), hotkey };
    const updated = changeMenuLevel(entries, level, (items) => index === undefined ? [...items, next] : items.map((item, i) => i === index ? next : item));
    if (managing) setDraft(updated);
    else {
      if (!await persist(updated)) return;
      setNotice(t(next.kind === "submenu" ? "Submenu saved" : menuVisible(next, context, windowsClient) ? "Command saved" :
        "Command saved. Use Show hidden entries to edit it here."));
    }
    setSelected(index ?? items.length);
    setEditor(undefined);
  }

  async function persist(next: MenuEntry[]) {
    if (!sourceVersion || busy) return false;
    setBusy(true);
    setError("");
    try {
      const saved = await api.saveUserMenu(sourceVersion, next);
      setSources((previous) => previous.map((candidate) => candidate.path === saved.path ? saved : candidate));
      return true;
    } catch (failure) { setError(describeError(failure)); return false; }
    finally { setBusy(false); }
  }

  async function save() {
    if (draft && await persist(draft)) setDraft(undefined);
  }

  async function reloadForEditor() {
    if (!editor || busy) return;
    setBusy(true);
    setError("");
    try {
      const updated = await api.userMenuSources(context.folder);
      const current = updated.find((candidate) => candidate.path === path);
      if (!current?.writable || current.error) {
        setError(current?.error ?? t("This menu source is unavailable."));
        return;
      }
      setSources(updated);
      setLevel([]);
      setSelected(undefined);
      setEditor({ entry: editor.entry });
      setNotice(t("Menu reloaded. Save your draft as a new entry."));
    } catch (failure) { setError(describeError(failure)); }
    finally { setBusy(false); }
  }

  async function approve() {
    if (!sourceVersion || busy) return;
    setError("");
    setBusy(true);
    try {
      await api.approveUserMenu(sourceVersion);
      setSources(sources.map((candidate) => candidate.path === path ? { ...candidate, approved: true } : candidate));
      setReview(false);
    } catch (failure) { setError(describeError(failure)); }
    finally { setBusy(false); }
  }

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.metaKey || event.shiftKey || busy) return;
    const key = event.key;
    if (event.ctrlKey && key.toLowerCase() === "h") setShowHidden(!showHidden);
    else if (event.ctrlKey && managing && (key === "ArrowDown" || key === "ArrowUp")) reorder(key === "ArrowDown" ? 1 : -1);
    else if (event.ctrlKey) return;
    else if (key === "ArrowDown" || key === "ArrowUp") {
      const index = selectable.findIndex((row) => row.index === currentIndex);
      setSelected(selectable[Math.max(0, Math.min(selectable.length - 1, index + (key === "ArrowDown" ? 1 : -1)))]?.index);
    } else if (key === "Enter" || (key === "ArrowRight" && current?.entry.kind === "submenu")) activate(current);
    else if (key === "ArrowLeft" && level.length) goBack();
    else if (!managing && !event.repeat) {
      const target = rows.find(({ entry, runnable }) => entry.kind !== "separator" && runnable && entry.hotkey.toUpperCase() === key.toUpperCase());
      if (!target) return;
      activate(target);
    } else return;
    event.preventDefault();
    event.stopPropagation();
  }

  const sourceLabel = (candidate: MenuSource) => candidate.personal ? t("Personal menu") :
    candidate === sources[0] ? t("Current folder menu") : candidate.path;
  const sourcePicker = <select className="user-menu-source" ref={sourceField} aria-label={t("Menu source")} title={source?.path} value={path}
    onChange={(event) => choose(event.target.value)} disabled={busy || dirty || !sources.length}>
    {sources.map((candidate) => <option key={candidate.path} value={candidate.path}>{sourceLabel(candidate)}</option>)}
  </select>;
  const currentTitle = level.length ? menuLevel(entries, level.slice(0, -1))[level.at(-1)!] : undefined;
  const title = editor ? t(editor.entry.kind === "command" ? editor.index === undefined ? "New command" : "Edit command" :
    editor.index === undefined ? "New submenu" : "Edit submenu") : parameters ? t("Command parameters") :
    review ? t("Review folder menu") : managing ? t("Manage menus") : currentTitle?.kind === "submenu" ? menuPreview(currentTitle.label, values).text : t("User Menu");
  const launch = current && current.entry.kind !== "separator" && (current.entry.kind === "submenu" || current.runnable);

  return <Dialog title={title} wide={!editor && managing} helpTopic="terminal" onClose={close}
    headingActions={editor && source ? <span className="user-menu-source" title={source.path}>{sourceLabel(source)}</span> :
      !editor && !parameters && !review ? sourcePicker : undefined}
    footer={editor ? <><Button disabled={busy} onClick={cancelEditor}>{t("Cancel")}</Button>
      <Button className="primary" disabled={busy || !editor.entry.label.trim() ||
        editor.entry.kind === "command" && editor.entry.steps.some((step) => !step.trim())} onClick={() => void commitEditor()}>
        {t(managing ? "Apply" : busy ? "Saving…" : editor.entry.kind === "command" ? "Save command" : "Save submenu")}</Button></> :
      parameters ? <><Button onClick={() => setParameters(undefined)}>{t("Cancel")}</Button><Button className="primary" disabled={promptPreview?.some(({ missing }) => missing.length > 0)}
        onClick={() => begin(parameters.entry, parameters.index, parameters.inputs)}>{t("Run")}</Button></> :
      review ? <><Button onClick={() => setReview(false)}>{t("Cancel")}</Button><Button className="primary" disabled={busy || !source?.revision} onClick={() => void approve()}>{t("Approve this version")}</Button></> :
      managing ? <><Button disabled={busy} onClick={() => { setDraft(undefined); setManaging(false); setError(""); }}>{t(dirty ? "Discard changes" : "Back")}</Button>
        <Button className="primary" disabled={!dirty || busy} onClick={() => void save()}>{t("Save menu")}</Button></> :
      <><Button className="user-menu-manage" disabled={busy || !source} onClick={() => { setManaging(true); setNotice(""); }}>{t("Manage menus")}</Button>
        {editable && <Button ref={empty ? newCommandButton : undefined} className={empty ? "primary" : undefined} disabled={busy}
          onClick={() => add(newCommand())}><Plus aria-hidden="true" />{t("New command")}</Button>}
        {editable && current && current.entry.kind !== "separator" && <Button disabled={busy} onClick={() => edit(current)}><Pencil aria-hidden="true" />{t("Edit")}</Button>}
        {launch && <Button className="primary" disabled={busy} onClick={() => activate(current)}><Play aria-hidden="true" />
          {t(current.entry.kind === "submenu" ? "Open submenu" : "Run")}</Button>}</>}>
    <div className="dialog-body user-menu-body">
      {error && <p role="alert">{errorText(error)}</p>}
      {notice && <p className="user-menu-notice" role="status">{notice}</p>}
      {editor ? <>
        {!managing && error === menuChanged && <div><Button disabled={busy} onClick={() => void reloadForEditor()}>{t("Reload menu and keep draft")}</Button></div>}
        <fieldset className="user-menu-editor" disabled={busy}>
          <label>{t("Name")}<input ref={firstField} value={editor.entry.label} onChange={(event) => setEditor({ ...editor, entry: { ...editor.entry, label: event.target.value } })} /></label>
          <EntryFields entry={editor.entry} stepsField={stepsField} update={(entry) => setEditor({ ...editor, entry })} />
        </fieldset>
      </> : parameters ? <>
        <p className="user-menu-path">{context.folder}</p>
        {parameters.entry.prompts.map(({ label, name }, index) => <label key={name}>{label}
          <input ref={index === 0 ? firstField : undefined} value={parameters.inputs[name]} onChange={(event) =>
            setParameters({ ...parameters, inputs: { ...parameters.inputs, [name]: event.target.value } })} />
        </label>)}
        <p>{t("Command preview")}</p><pre>{promptPreview?.map(({ text }) => text).join("\n")}</pre>
      </> : review ? <>
        <p className="user-menu-path">{source?.path}</p>
        <p>{t("Review the commands in this file. Approval applies to these contents for this session.")}</p>
        <ReviewEntries entries={source?.entries ?? []} />
        <details className="user-menu-advanced"><summary>{t("View menu definition")}</summary><pre>{JSON.stringify(source?.entries ?? [], null, 2)}</pre></details>
      </> : <>
        {source && (managing || source.error) && <p className="user-menu-path">{source.path}</p>}
        {source?.error && <p role="alert">{errorText(source.error)}</p>}
        {source && !source.writable && <p>{t("Read only")}</p>}
        {source?.revision && !source.approved && !source.error && <Button onClick={() => setReview(true)}>{t("Review folder menu")}</Button>}
        {level.length > 0 && <Button onClick={goBack}>{t("Back")}</Button>}
        {!managing && hasHiddenEntries && <label className="user-menu-check"><input ref={hiddenField} type="checkbox" checked={showHidden} onChange={(event) => setShowHidden(event.target.checked)} />{t("Show hidden entries")}</label>}
        {hasEntries ? <div ref={list} tabIndex={0} className="user-menu-list" role="listbox" aria-label={t("Menu entries")}
          aria-activedescendant={currentIndex === undefined ? undefined : `user-menu-entry-${currentIndex}`} onKeyDown={keyDown}>
          {rows.map((row) => row.entry.kind === "separator" && !managing ? <hr key={row.index} /> :
            <div key={row.index} id={`user-menu-entry-${row.index}`} role="option" aria-selected={currentIndex === row.index}
              aria-disabled={!row.runnable && !managing} onClick={() => setSelected(row.index)}
              onDoubleClick={() => { if (managing || row.entry.kind === "submenu") activate(row); }}>
              <span>{row.entry.kind === "separator" ? t("Separator") : menuPreview(row.entry.label, values).text}</span>
              {row.entry.kind !== "separator" && <span>{row.entry.hotkey}{row.entry.kind === "submenu" ? " ›" : ""}</span>}
            </div>)}
        </div> : busy ? <p role="status">{t("Loading…")}</p> : source && !source.error && <div className="user-menu-empty">
          {items.length ? <p>{t("No commands match the current selection.")}</p> : <>
            <strong>{t("No saved commands")}</strong>
            {editable && <p>{t("Save commands that use the active pane’s files and folders.")}</p>}
          </>}
        </div>}
        {editable && managing && <div className="user-menu-tools">
            <Button onClick={() => add(newCommand())}>{t("New command")}</Button>
            <Button onClick={() => add({ kind: "submenu", label: "", hotkey: "", children: [] })}>{t("New submenu")}</Button>
            <Button onClick={() => { change((items) => [...items, separator]); setSelected(items.length); }}>{t("Add separator")}</Button>
            {current && <><Button disabled={current.entry.kind === "separator"} onClick={() => {
              if (current.entry.kind !== "separator") edit(current);
            }}>{t("Edit")}</Button>
            <Button disabled={current?.entry.kind !== "submenu"} onClick={() => activate(current)}>{t("Open submenu")}</Button>
            <Button disabled={currentIndex === undefined} onClick={() => change((items) => items.filter((_, index) => index !== currentIndex))}>{t("Remove")}</Button>
            <Button disabled={currentIndex === undefined || currentIndex === 0} onClick={() => reorder(-1)}>{t("Move up")}</Button>
            <Button disabled={currentIndex === undefined || currentIndex >= items.length - 1} onClick={() => reorder(1)}>{t("Move down")}</Button></>}
        </div>}
      </>}
    </div>
  </Dialog>;
}

const tokenLabels: Record<string, string> = {
  activeFolder: "Active pane folder", oppositeFolder: "Other pane folder", focusedName: "Focused item name",
  focusedPath: "Focused item path", focusedStem: "Focused name without extension", focusedExtension: "Focused extension",
  markedPaths: "Marked item paths",
};

function EntryFields({ entry, update, stepsField }: {
  entry: Editable; update: (entry: Editable) => void; stepsField: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const command = entry.kind === "command" ? entry : null;
  function insertToken(token: string) {
    const field = stepsField.current;
    if (!field || !token || !command) return;
    const start = field.selectionStart;
    const value = field.value.slice(0, start) + `{{${token}}}` + field.value.slice(field.selectionEnd);
    update({ ...command, steps: value.split("\n") });
    requestAnimationFrame(() => { field.focus(); field.setSelectionRange(start + token.length + 4, start + token.length + 4); });
  }

  return <>
    {command && <div className="user-menu-commands">
      <label>{t("Shell commands")}<textarea ref={stepsField} rows={3} value={command.steps.join("\n")}
        onChange={(event) => update({ ...command, steps: event.target.value.split("\n") })} spellCheck={false} /></label>
      <div className="user-menu-command-tools">
        <small>{t("One step per line")}</small>
        <select aria-label={t("Insert value")} value="" onChange={(event) => insertToken(event.target.value)}>
          <option value="">{t("Insert value")}</option>
          {menuTokens.map((token) => <option key={token} value={token}>{t(tokenLabels[token])}</option>)}
          {command.prompts.filter(({ name }) => name).map(({ label, name }, index) =>
            <option key={`${name}-${index}`} value={`prompt:${name}`}>{label || name}</option>)}
        </select>
      </div>
    </div>}
    <details className="user-menu-advanced">
      <summary>{t("Advanced options")}</summary>
      <div className="user-menu-advanced-fields">
        <div className="user-menu-entry-options">
          <label>{t("Menu hotkey")}<input maxLength={3} value={entry.hotkey}
            onChange={(event) => update({ ...entry, hotkey: event.target.value })} /></label>
          {command && <label>{t("Visibility")}<select value={command.visibility}
            onChange={(event) => update({ ...command, visibility: event.target.value as MenuVisibility })}>
            {Object.entries(rules).map(([key, label]) => <option key={key} value={key}>{t(label)}</option>)}
          </select></label>}
        </div>
        {command && <>
          {(command.visibility === "file" || command.visibility === "folder") && <label>{t("Name mask")}<input value={command.mask}
            onChange={(event) => update({ ...command, mask: event.target.value })} placeholder="*.txt" /></label>}
          {command.prompts.map((prompt, index) => <div className="user-menu-prompt" key={index}>
            {([ ["name", "Token name"], ["label", "Prompt label"], ["initial", "Default value"] ] as const).map(([key, label]) =>
              <label key={key}>{t(label)}<input value={prompt[key]} onChange={(event) => update({ ...command,
                prompts: command.prompts.map((value, i) => i === index ? { ...value, [key]: event.target.value } : value) })} /></label>)}
            <Button onClick={() => update({ ...command, prompts: command.prompts.filter((_, i) => i !== index) })}>{t("Remove prompt")}</Button>
          </div>)}
          <div><Button onClick={() => update({ ...command, prompts: [...command.prompts, { name: "", label: "", initial: "" }] })}>
            <Plus aria-hidden="true" />{t("Add prompt")}</Button></div>
        </>}
      </div>
    </details>
  </>;
}

function ReviewEntries({ entries }: { entries: MenuEntry[] }) {
  return <ul className="user-menu-review-entries">{entries.map((entry, index) => entry.kind !== "separator" && <li key={index}>
    <strong>{entry.label}</strong>
    {entry.kind === "command" ? <pre>{entry.steps.join("\n")}</pre> : <ReviewEntries entries={entry.children} />}
  </li>)}</ul>;
}
