import { t } from "./i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { Annotation, Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { tags } from "@lezer/highlight";

const palette = syntaxHighlighting(HighlightStyle.define([
  { tag: [tags.comment, tags.docComment], class: "syntax-comment" },
  { tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword, tags.definitionKeyword, tags.modifier], class: "syntax-keyword" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp, tags.escape], class: "syntax-string" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], class: "syntax-number" },
  { tag: [tags.typeName, tags.className, tags.tagName, tags.heading], class: "syntax-type" },
  { tag: [tags.propertyName, tags.attributeName, tags.function(tags.variableName)], class: "syntax-property" },
  { tag: tags.invalid, class: "syntax-invalid" },
]));
const languageChoices = [...languages].sort((a, b) => a.name.localeCompare(b.name));
const externalEdit = Annotation.define<boolean>();

export default function CodeSurface({ fileName, editing, locked, active, fontSize, value, syntaxTarget, onChange }: {
  fileName: string;
  editing: boolean;
  locked: boolean;
  active: boolean;
  fontSize?: number;
  value: string;
  syntaxTarget: HTMLElement | null;
  onChange: (text: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const latest = useRef({ value, onChange });
  latest.current = { value, onChange };
  const languageSlot = useMemo(() => new Compartment(), []);
  const editSlot = useMemo(() => new Compartment(), []);
  const labelSlot = useMemo(() => new Compartment(), []);
  const label = t(editing ? "Edit {0}" : "View {0}", fileName);
  const [syntax, setSyntax] = useState("auto");
  const [unavailable, setUnavailable] = useState(false);
  const language = syntax === "auto" ? LanguageDescription.matchFilename(languages, fileName) :
    languageChoices.find(({ name }) => name === syntax);

  useEffect(() => {
    const parent = container.current;
    if (!parent) return;
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: latest.current.value,
        extensions: [
          palette, languageSlot.of([]), editSlot.of([]), labelSlot.of([]), lineNumbers(),
          EditorView.lineWrapping,
          ...(editing ? [history(), keymap.of([...defaultKeymap, ...historyKeymap]),
            EditorView.updateListener.of((update) => {
              if (update.docChanged && update.transactions.some((transaction) =>
                transaction.docChanged && !transaction.annotation(externalEdit))) {
                latest.current.onChange(update.state.doc.toString());
              }
            })] : []),
        ],
      }),
    });
    editor.current = view;
    return () => { editor.current = null; view.destroy(); };
  }, [editing, fileName, languageSlot, editSlot, labelSlot]);

  useEffect(() => {
    const view = editor.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;

    let from = 0;
    let oldEnd = current.length;
    let newEnd = value.length;
    while (from < oldEnd && from < newEnd && current[from] === value[from]) from++;
    while (oldEnd > from && newEnd > from && current[oldEnd - 1] === value[newEnd - 1]) {
      oldEnd--;
      newEnd--;
    }
    view.dispatch({
      changes: { from, to: oldEnd, insert: value.slice(from, newEnd) },
      annotations: [externalEdit.of(true), Transaction.addToHistory.of(false)],
    });
  }, [value]);

  useEffect(() => {
    editor.current?.dispatch({ effects: labelSlot.reconfigure(EditorView.contentAttributes.of({ "aria-label": label, spellcheck: "false" })) });
  }, [label, labelSlot]);

  useEffect(() => {
    const readOnly = !editing || locked;
    editor.current?.dispatch({ effects: editSlot.reconfigure([
      EditorState.readOnly.of(readOnly), EditorView.editable.of(editing),
    ]) });
  }, [editing, locked, editSlot]);

  useEffect(() => {
    if (active) editor.current?.requestMeasure();
  }, [active, fontSize]);

  useEffect(() => {
    if (active && editing) editor.current?.focus();
  }, [active, editing]);

  useEffect(() => {
    const view = editor.current;
    if (!view) return;
    let canceled = false;
    setUnavailable(false);
    view.dispatch({ effects: languageSlot.reconfigure([]) });
    void language?.load().then(
      (support) => { if (!canceled) view.dispatch({ effects: languageSlot.reconfigure(support) }); },
      () => { if (!canceled) setUnavailable(true); },
    );
    return () => { canceled = true; };
  }, [language, languageSlot]);

  return (
    <>
      {syntaxTarget && createPortal(<div className="syntax-toolbar">
        <label>{t("Syntax")} <select value={syntax} onChange={(event) => setSyntax(event.target.value)}>
          <option value="auto">{t("Automatic ({0})", language?.name ?? t("Plain text"))}</option>
          <option value="plain">{t("Plain text")}</option>
          {languageChoices.map(({ name }) => <option key={name} value={name}>{name}</option>)}
        </select></label>
        {unavailable && <span role="status">{t("Syntax unavailable.")}</span>}
      </div>, syntaxTarget)}
      <div className="code-surface" ref={container} />
    </>
  );
}
