import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
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
  const list = useRef<HTMLDivElement>(null);
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

  useLayoutEffect(() => {
    if (editor || parameters) firstField.current?.focus();
    else if (!review) list.current?.focus({ preventScroll: true });
  }, [Boolean(editor), Boolean(parameters), review, path, busy]);

  const source = sources.find((candidate) => candidate.path === path);
  const entries = draft ?? source?.entries ?? [];
  const items = menuLevel(entries, level);
  const rows = items.flatMap((entry, index) => {
    const runnable = menuVisible(entry, context, windowsClient);
    return runnable || showHidden || managing ? [{ entry, index, runnable }] : [];
  });
  const selectable = rows.filter(({ entry }) => managing || entry.kind !== "separator");
  const currentIndex = selectable.some(({ index }) => selected === index) ? selected : selectable[0]?.index;
  const current = rows.find(({ index }) => index === currentIndex);
  const values = menuValues(context);
  const dirty = draft !== undefined;
  const sourceVersion = source ? { folder: context.folder, path: source.path, revision: source.revision } : undefined;
  const editable = !!source?.writable && !source.error;
  const promptPreview = parameters?.entry.steps.map((step) => menuPreview(step, menuValues(context, parameters.inputs), true));

  function choose(path: string) {
    setPath(path);
    setLevel([]);
    setSelected(undefined);
    setError("");
  }

  function goBack() {
    setSelected(level.at(-1));
    setLevel(level.slice(0, -1));
  }

  function close() {
    if (busy) return;
    if (parameters) setParameters(undefined);
    else if (editor) setEditor(undefined);
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
    if (row.entry.kind === "submenu") { setLevel([...level, row.index]); setSelected(undefined); }
    else if (row.entry.kind === "command" && row.runnable && !managing) {
      if (!source?.approved) setReview(true);
      else begin(row.entry, row.index);
    } else if (row.entry.kind !== "separator" && managing && editable) {
      setEditor({ index: row.index, entry: row.entry });
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

  function add(command: Editable) { setManaging(true); setEditor({ entry: command }); }

  function commitEditor() {
    if (!editor) return;
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
    const next = { ...entry, hotkey };
    change((items) => index === undefined ? [...items, next] : items.map((item, i) => i === index ? next : item));
    setSelected(index ?? items.length);
    setEditor(undefined);
  }

  async function save() {
    if (!sourceVersion || !draft || busy) return;
    setBusy(true);
    setError("");
    try {
      const saved = await api.saveUserMenu(sourceVersion, draft);
      setSources(sources.map((candidate) => candidate.path === saved.path ? saved : candidate));
      setDraft(undefined);
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

  const options = <>
    {sources.map((candidate) => <option key={candidate.path} value={candidate.path}>
      {candidate.personal ? t("Personal menu") : candidate === sources[0] ? t("Current folder menu") : candidate.path}
    </option>)}
  </>;
  const currentTitle = level.length ? menuLevel(entries, level.slice(0, -1))[level.at(-1)!] : undefined;
  const title = editor ? t(editor.index === undefined ? "Add menu entry" : "Edit menu entry") : parameters ? t("Command parameters") :
    review ? t("Review folder menu") : managing ? t("Manage menus") : currentTitle?.kind === "submenu" ? menuPreview(currentTitle.label, values).text : t("User Menu");

  return <Dialog title={title} wide={managing || review || !!parameters} helpTopic="terminal" onClose={close}
    footer={editor ? <><Button onClick={() => setEditor(undefined)}>{t("Cancel")}</Button><Button className="primary" onClick={commitEditor}>{t("Apply")}</Button></> :
      parameters ? <><Button onClick={() => setParameters(undefined)}>{t("Cancel")}</Button><Button className="primary" disabled={promptPreview?.some(({ missing }) => missing.length > 0)}
        onClick={() => begin(parameters.entry, parameters.index, parameters.inputs)}>{t("Run")}</Button></> :
      review ? <><Button onClick={() => setReview(false)}>{t("Cancel")}</Button><Button className="primary" disabled={busy || !source?.revision} onClick={() => void approve()}>{t("Approve this version")}</Button></> :
      managing ? <><Button disabled={busy} onClick={() => { setDraft(undefined); setManaging(false); setError(""); }}>{t(dirty ? "Discard changes" : "Back")}</Button>
        <Button className="primary" disabled={!dirty || busy} onClick={() => void save()}>{t("Save menu")}</Button></> :
      <><Button disabled={busy || !source} onClick={() => { setManaging(true); setShowHidden(true); }}>{t("Manage menus")}</Button>
        <Button onClick={onClose}>{t("Close")}</Button></>}>
    <div className="user-menu-body">
      {error && <p role="alert">{errorText(error)}</p>}
      {editor ? <>
        <label>{t("Label")}<input ref={firstField} value={editor.entry.label} onChange={(event) => setEditor({ ...editor, entry: { ...editor.entry, label: event.target.value } })} /></label>
        <label>{t("Menu hotkey")}<input maxLength={3} value={editor.entry.hotkey} onChange={(event) => setEditor({ ...editor, entry: { ...editor.entry, hotkey: event.target.value } })} /></label>
        {editor.entry.kind === "command" && <CommandFields entry={editor.entry} stepsField={stepsField}
          update={(entry) => setEditor({ ...editor, entry })} />}
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
        <pre>{JSON.stringify(source?.entries ?? [], null, 2)}</pre>
      </> : <>
        <label>{t("Menu source")}<select value={path} onChange={(event) => choose(event.target.value)} disabled={busy || dirty}>{options}</select></label>
        <p className="user-menu-path">{source?.path ?? context.folder}</p>
        {source?.error && <p role="alert">{errorText(source.error)}</p>}
        {source && !source.writable && <p>{t("Read only")}</p>}
        {source?.revision && !source.approved && !source.error && <Button onClick={() => setReview(true)}>{t("Review folder menu")}</Button>}
        {level.length > 0 && <Button onClick={goBack}>{t("Back")}</Button>}
        {!managing && <label className="user-menu-check"><input type="checkbox" checked={showHidden} onChange={(event) => setShowHidden(event.target.checked)} />{t("Show hidden entries")}</label>}
        <div ref={list} tabIndex={0} className="user-menu-list" role="listbox" aria-label={t("Menu entries")}
          aria-activedescendant={currentIndex === undefined ? undefined : `user-menu-entry-${currentIndex}`} onKeyDown={keyDown}>
          {rows.map((row) => row.entry.kind === "separator" && !managing ? <hr key={row.index} /> :
            <div key={row.index} id={`user-menu-entry-${row.index}`} role="option" aria-selected={currentIndex === row.index}
              aria-disabled={!row.runnable && !managing} onClick={() => managing ? setSelected(row.index) : activate(row)} onDoubleClick={() => { if (managing) activate(row); }}>
              <span>{row.entry.kind === "separator" ? t("Separator") : menuPreview(row.entry.label, values).text}</span>
              {row.entry.kind !== "separator" && <span>{row.entry.hotkey}{row.entry.kind === "submenu" ? " ›" : ""}</span>}
            </div>)}
          {rows.length === 0 && <p>{t(busy ? "Loading…" : "No menu entries")}</p>}
        </div>
        {editable && <div className="user-menu-tools">
          {(managing || !items.length) && <Button onClick={() => add(newCommand())}>{t("New command")}</Button>}
          {managing && <>
            <Button onClick={() => add({ kind: "submenu", label: "", hotkey: "", children: [] })}>{t("New submenu")}</Button>
            <Button onClick={() => { change((items) => [...items, separator]); setSelected(items.length); }}>{t("Add separator")}</Button>
            <Button disabled={!current || current.entry.kind === "separator"} onClick={() => {
              if (current && current.entry.kind !== "separator") setEditor({ index: current.index, entry: current.entry });
            }}>{t("Edit")}</Button>
            <Button disabled={current?.entry.kind !== "submenu"} onClick={() => activate(current)}>{t("Open submenu")}</Button>
            <Button disabled={currentIndex === undefined} onClick={() => change((items) => items.filter((_, index) => index !== currentIndex))}>{t("Remove")}</Button>
            <Button disabled={currentIndex === undefined || currentIndex === 0} onClick={() => reorder(-1)}>{t("Move up")}</Button>
            <Button disabled={currentIndex === undefined || currentIndex >= items.length - 1} onClick={() => reorder(1)}>{t("Move down")}</Button>
          </>}
        </div>}
      </>}
    </div>
  </Dialog>;
}

function CommandFields({ entry, update, stepsField }: {
  entry: Command; update: (entry: Command) => void; stepsField: React.RefObject<HTMLTextAreaElement | null>;
}) {
  function insertToken(token: string) {
    const field = stepsField.current;
    if (!field || !token) return;
    const start = field.selectionStart;
    const value = field.value.slice(0, start) + `{{${token}}}` + field.value.slice(field.selectionEnd);
    update({ ...entry, steps: value.split("\n") });
    requestAnimationFrame(() => { field.focus(); field.setSelectionRange(start + token.length + 4, start + token.length + 4); });
  }

  return <>
    <label>{t("Visibility")}<select value={entry.visibility} onChange={(event) => update({ ...entry, visibility: event.target.value as MenuVisibility })}>
      {Object.entries(rules).map(([key, label]) => <option key={key} value={key}>{t(label)}</option>)}
    </select></label>
    {(entry.visibility === "file" || entry.visibility === "folder") && <label>{t("Name mask")}<input value={entry.mask}
      onChange={(event) => update({ ...entry, mask: event.target.value })} placeholder="*.txt" /></label>}
    <label>{t("Shell steps, one per line")}<textarea ref={stepsField} rows={4} value={entry.steps.join("\n")}
      onChange={(event) => update({ ...entry, steps: event.target.value.split("\n") })} /></label>
    <label>{t("Insert token")}<select value="" onChange={(event) => insertToken(event.target.value)}>
      <option value="">{t("Choose a token")}</option>
      {[...menuTokens, ...entry.prompts.filter(({ name }) => name).map(({ name }) => `prompt:${name}`)].map((token, index) =>
        <option key={`${token}-${index}`} value={token}>{`{{${token}}}`}</option>)}
    </select></label>
    {entry.prompts.map((prompt, index) => <div className="user-menu-prompt" key={index}>
      {([ ["name", "Token name"], ["label", "Prompt label"], ["initial", "Default value"] ] as const).map(([key, label]) =>
        <label key={key}>{t(label)}<input value={prompt[key]} onChange={(event) => update({ ...entry,
          prompts: entry.prompts.map((value, i) => i === index ? { ...value, [key]: event.target.value } : value) })} /></label>)}
      <Button onClick={() => update({ ...entry, prompts: entry.prompts.filter((_, i) => i !== index) })}>{t("Remove prompt")}</Button>
    </div>)}
    <div><Button onClick={() => update({ ...entry, prompts: [...entry.prompts, { name: "", label: "", initial: "" }] })}>{t("Add prompt")}</Button></div>
  </>;
}
