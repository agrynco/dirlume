import { useEffect, useMemo, useRef, useState } from "react";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { Compartment, EditorState } from "@codemirror/state";
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

export default function CodeSurface({ fileName, editing, locked, active, value, onChange }: {
  fileName: string;
  editing: boolean;
  locked: boolean;
  active: boolean;
  value: string;
  onChange: (text: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const latest = useRef({ value, onChange });
  latest.current = { value, onChange };
  const languageSlot = useMemo(() => new Compartment(), []);
  const editSlot = useMemo(() => new Compartment(), []);
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
          palette, languageSlot.of([]), editSlot.of([]), lineNumbers(),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            "aria-label": `${editing ? "Edit" : "View"} ${fileName}`, spellcheck: "false",
          }),
          ...(editing ? [history(), keymap.of([...defaultKeymap, ...historyKeymap]),
            EditorView.updateListener.of((update) => {
              if (update.docChanged) latest.current.onChange(update.state.doc.toString());
            })] : []),
        ],
      }),
    });
    editor.current = view;
    return () => { editor.current = null; view.destroy(); };
  }, [editing, fileName, languageSlot, editSlot]);

  useEffect(() => {
    const readOnly = !editing || locked;
    editor.current?.dispatch({ effects: editSlot.reconfigure([
      EditorState.readOnly.of(readOnly), EditorView.editable.of(editing),
    ]) });
  }, [editing, locked, editSlot]);

  useEffect(() => {
    if (!active) return;
    editor.current?.requestMeasure();
    if (editing) editor.current?.focus();
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
      <div className="text-toolbar syntax-toolbar">
        <label>Syntax <select value={syntax} onChange={(event) => setSyntax(event.target.value)}>
          <option value="auto">{`Automatic (${language?.name ?? "Plain text"})`}</option>
          <option value="plain">Plain text</option>
          {languageChoices.map(({ name }) => <option key={name} value={name}>{name}</option>)}
        </select></label>
        {unavailable && <span role="status">Syntax unavailable.</span>}
      </div>
      <div className="code-surface" ref={container} />
    </>
  );
}
