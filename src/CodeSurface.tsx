import { t } from "./i18n";
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { cursorDocEnd, cursorDocStart, defaultKeymap, history, historyKeymap, redo, redoDepth, selectAll, undo, undoDepth } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Annotation, Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView, highlightActiveLine, keymap, lineNumbers, type Command } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { NamedFile } from "./api";
import { detectLanguage, languageChoices } from "./syntaxCatalog";

const palette = syntaxHighlighting(HighlightStyle.define([
  { tag: [tags.comment, tags.docComment], class: "syntax-comment" },
  { tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword, tags.definitionKeyword, tags.modifier], class: "syntax-keyword" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp, tags.escape], class: "syntax-string" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], class: "syntax-number" },
  { tag: [tags.typeName, tags.className, tags.tagName, tags.heading], class: "syntax-type" },
  { tag: [tags.propertyName, tags.attributeName, tags.function(tags.variableName)], class: "syntax-property" },
  { tag: tags.invalid, class: "syntax-invalid" },
]));
const externalEdit = Annotation.define<boolean>();
export type SourceStatus = { line: number; column: number; canUndo: boolean; canRedo: boolean };
export type SourceActions = {
  selection: () => string;
  selectAll: () => void;
  undo: () => void;
  redo: () => void;
  goToStart: () => void;
  goToEnd: () => void;
};
const managedCommands: Command[] = [selectAll, cursorDocStart, cursorDocEnd];

export default function CodeSurface({ file, editing, locked, active, fontSize, readingWidth, value, onChange,
  ref, syntaxOverride = "auto", onSyntaxInfo, onSourceStatus }: {
  file: NamedFile;
  editing: boolean;
  locked: boolean;
  active: boolean;
  fontSize?: number;
  readingWidth?: number;
  value: string;
  onChange: (text: string) => void;
  ref?: Ref<SourceActions>;
  syntaxOverride?: string;
  onSyntaxInfo?: (info: { detected: string | undefined; unavailable: boolean }) => void;
  onSourceStatus?: (status: SourceStatus) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const latest = useRef({ value, onChange, onSourceStatus });
  latest.current = { value, onChange, onSourceStatus };
  const languageSlot = useMemo(() => new Compartment(), []);
  const editSlot = useMemo(() => new Compartment(), []);
  const labelSlot = useMemo(() => new Compartment(), []);
  const fileName = file.name;
  const label = t(editing ? "Edit {0}" : "View {0}", fileName);
  const [unavailable, setUnavailable] = useState(false);
  const detected = useMemo(() => detectLanguage(file), [file]);
  const language = syntaxOverride === "auto" ? detected : languageChoices.find(({ name }) => name === syntaxOverride);
  const managed = Boolean(ref);
  useEffect(() => { onSyntaxInfo?.({ detected: detected?.name, unavailable }); }, [detected, unavailable, onSyntaxInfo]);

  useImperativeHandle(ref, () => ({
    selection: () => editor.current?.state.sliceDoc(editor.current.state.selection.main.from, editor.current.state.selection.main.to) ?? "",
    selectAll: () => { if (editor.current) { selectAll(editor.current); editor.current.focus(); } },
    undo: () => { if (editor.current) { undo(editor.current); editor.current.focus(); } },
    redo: () => { if (editor.current) { redo(editor.current); editor.current.focus(); } },
    goToStart: () => { if (editor.current) { cursorDocStart(editor.current); editor.current.focus(); } },
    goToEnd: () => { if (editor.current) { cursorDocEnd(editor.current); editor.current.focus(); } },
  }), []);

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
          ...(editing ? [history(), highlightActiveLine(), keymap.of(managed ? defaultKeymap.filter(({ run }) => !run || !managedCommands.includes(run)) :
            [...defaultKeymap, ...historyKeymap])] : []),
          EditorView.updateListener.of((update) => {
            if (editing && update.docChanged && update.transactions.some((transaction) =>
              transaction.docChanged && !transaction.annotation(externalEdit))) {
              latest.current.onChange(update.state.doc.toString());
            }
            if (update.selectionSet || update.docChanged) {
              const { doc, selection } = update.state;
              const line = doc.lineAt(selection.main.head);
              latest.current.onSourceStatus?.({
                line: line.number, column: selection.main.head - line.from + 1,
                canUndo: undoDepth(update.state) > 0, canRedo: redoDepth(update.state) > 0,
              });
            }
          }),
        ],
      }),
    });
    if (!editing) view.scrollDOM.tabIndex = 0;
    editor.current = view;
    return () => { editor.current = null; view.destroy(); };
  }, [editing, fileName, languageSlot, editSlot, labelSlot, managed]);

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
  }, [active, fontSize, readingWidth]);

  useEffect(() => {
    const view = editor.current;
    if (!active || !view) return;
    if (editing) view.focus();
    else if (document.activeElement === view.dom.closest(".text-window")) view.scrollDOM.focus({ preventScroll: true });
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
  }, [editing, fileName, language, languageSlot, managed]);

  return <div className="code-surface" ref={container} />;
}
