import { useState, type KeyboardEvent } from "react";
import { ArrowDown, ArrowDownWideNarrow, ArrowUp, ArrowUpDown, ArrowUpNarrowWide, Check, Plus, RotateCcw } from "lucide-react";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { DialogIconButton, RowOrderActions } from "./DialogActions";
import { t } from "./i18n";
import {
  defaultSortCriteria, sortModeIds, sortModes, usesSortGroups, type FileSort, type SortCriterion, type SortGroup, type SortMode,
} from "./fileSort";
import { bindingMatches, eventShortcut, showShortcut, sortModeCommand, type Bindings } from "./preferences";

const toggles = [
  { field: "groups", command: "sortGroups", label: "Use sort groups" },
  { field: "markedFirst", command: "sortMarkedFirst", label: "Show selected first" },
  { field: "directoriesFirst", command: "sortDirectoriesFirst", label: "Show directories first" },
] as const;

type SortPriority = typeof toggles[number]["field"];
type SortChoice = Exclude<SortMode, "unsorted">;

export function SortMenu({ sort, mode, available, bindings, onMode, onDirection, onToggle, onCriteria, onClose }: {
  sort: FileSort;
  mode: SortMode;
  available: (mode: SortMode) => boolean;
  bindings: Bindings;
  onMode: (mode: SortMode) => void;
  onDirection: (asc: boolean) => void;
  onToggle: (field: SortPriority) => void;
  onCriteria: (mode: SortMode) => void;
  onClose: () => void;
}) {
  const directions = [
    { command: "sortAscending", label: "Sort ascending", icon: ArrowUpNarrowWide, run: () => onDirection(true) },
    { command: "sortDescending", label: "Sort descending", icon: ArrowDownWideNarrow, run: () => onDirection(false) },
    { command: "sortReverse", label: "Reverse sort direction", icon: ArrowUpDown, run: () => onDirection(!sort.asc) },
  ] as const;

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.getModifierState("AltGraph")) return;
    const key = eventShortcut(event);
    const action = directions.find(({ command }) => bindingMatches(bindings[command], key));
    const editCriteria = bindingMatches(bindings.sortEditCriteria, key);
    const priority = toggles.find(({ command }) => bindingMatches(bindings[command], key));
    const criterion = sortModeIds.find((item) => available(item) && bindingMatches(bindings[sortModeCommand(item)], key));
    if (action || editCriteria || priority || criterion) {
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      if (action) action.run();
      else if (editCriteria) {
        const selected = (event.target as HTMLElement).closest<HTMLElement>("[data-sort-mode]")?.dataset.sortMode as SortMode | undefined;
        const target = selected ?? mode;
        if (target !== "unsorted" && available(target)) onCriteria(target);
      } else if (priority) onToggle(priority.field);
      else if (criterion) onMode(criterion);
      return;
    }
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".sort-menu-list button:not([aria-disabled=true])")];
    const active = options.indexOf(document.activeElement as HTMLButtonElement);
    const offset = event.key === "ArrowUp" ? -1 : 1;
    const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (active + options.length + offset) % options.length;
    event.preventDefault();
    options[next]?.focus();
  }

  return <Dialog title={t("Sort by")} onClose={onClose}>
    <div className="dialog-body sort-menu" onKeyDown={keyDown}>
      <div className="sort-menu-list">
        <div className="sort-menu-modes" role="radiogroup" aria-label={t("Sort modes")}>
        {sortModeIds.map((id) => {
          const current = mode === id;
          const enabled = available(id);
          const direction = sort.asc ? "Ascending" : "Descending";
          const shortcut = showShortcut(bindings[sortModeCommand(id)][0]);
          return <Button key={id} type="button" role="radio" aria-checked={current} data-sort-mode={id}
            aria-disabled={!enabled || undefined} data-initial-focus={current && enabled || undefined}
            aria-label={current ? t("{0}, {1}", t(sortModes[id].label), t(direction)) : t(sortModes[id].label)}
            aria-describedby={enabled ? undefined : "sort-mode-unavailable"}
            shortcut={shortcut} onClick={() => { if (enabled) onMode(id); }}>
            <span className="sort-menu-marker" aria-hidden="true">{current && (sort.asc ? <ArrowUp /> : <ArrowDown />)}</span>
            <span>{t(sortModes[id].label)}</span>{shortcut && <kbd aria-hidden="true">{shortcut}</kbd>}
          </Button>;
        })}
        </div>
        <div className="main-menu-separator" role="separator" />
        {toggles.map(({ field, command, label }) => {
          const shortcut = showShortcut(bindings[command][0]);
          return <Button key={field} type="button" role="checkbox" aria-checked={sort[field]}
            shortcut={shortcut} onClick={() => onToggle(field)}>
            <span className="sort-menu-marker" aria-hidden="true">{sort[field] && <Check />}</span>
            <span>{t(label)}</span>{shortcut && <kbd aria-hidden="true">{shortcut}</kbd>}
          </Button>;
        })}
      </div>
      <p className="sort-mode-note" id="sort-mode-unavailable">{t("Dimmed modes require metadata unavailable at this location.")}</p>
      {!available(mode) && <p className="sort-mode-note">{t("This pane uses Name order here and restores the chosen order where supported.")}</p>}
      {sort.groups && !usesSortGroups(mode) && <p className="sort-mode-note">{t("Sort groups apply to Name, Name only, and Extension.")}</p>}
      <div className="dialog-actions dialog-actions-end">
        <div className="dialog-action-group">
          {directions.map(({ command, label, icon: Icon, run }) => <DialogIconButton key={command}
            label={t(label)} shortcut={showShortcut(bindings[command][0])} onClick={run}><Icon /></DialogIconButton>)}
        </div>
        <Button type="button" disabled={mode === "unsorted" || !available(mode)}
          shortcut={showShortcut(bindings.sortEditCriteria[0])} onClick={() => onCriteria(mode)}>{t("Edit sort tie-breakers")}</Button>
      </div>
    </div>
  </Dialog>;
}

function SequenceControls({ index, length, move, remove }: {
  index: number; length: number; move: (next: number) => void; remove: () => void;
}) {
  return <RowOrderActions up={t("Move row {0} up", index + 1)} down={t("Move row {0} down", index + 1)} remove={t("Remove row {0}", index + 1)}
    first={index === 0} last={index + 1 === length} onMove={(offset) => move(index + offset)} onRemove={remove} />;
}

function moveItem<T>(items: T[], index: number, next: number) {
  const copy = [...items];
  [copy[index], copy[next]] = [copy[next], copy[index]];
  return copy;
}

export function SortCriteriaDialog({ mode, criteria, onSave, onClose }: {
  mode: SortMode; criteria: SortCriterion[]; onSave: (criteria: SortCriterion[]) => void; onClose: () => void;
}) {
  const [draft, setDraft] = useState(criteria);
  const options = sortModeIds.filter((id): id is SortChoice => id !== mode && id !== "unsorted");
  const unused = options.find((id) => !draft.some((criterion) => criterion.mode === id));
  const replace = (index: number, criterion: SortCriterion) =>
    setDraft(draft.map((item, i) => i === index ? criterion : item));
  return <Dialog title={t("Tie-breakers for {0}", t(sortModes[mode].label))} onClose={onClose} footer={<>
    <Button type="button" onClick={() => setDraft(defaultSortCriteria(mode))}><RotateCcw /> {t("Reset")}</Button>
    <Button type="button" onClick={onClose}>{t("Cancel")}</Button>
    <Button type="button" className="primary" onClick={() => onSave(draft)}>{t("Apply")}</Button>
  </>}>
    <div className="dialog-body sort-sequence">
      {draft.map((criterion, index) => <div className="sort-sequence-row" key={index}>
        <label>{t("Criterion")}
          <select aria-label={t("Criterion {0}", index + 1)} value={criterion.mode}
            onChange={(event) => replace(index, { ...criterion, mode: event.target.value as SortChoice })}>
            {options.map((id) => <option key={id} value={id} disabled={id !== criterion.mode && draft.some((item) => item.mode === id)}>
              {t(sortModes[id].label)}
            </option>)}
          </select>
        </label>
        <label>{t("Direction")}
          <select aria-label={t("Direction for criterion {0}", index + 1)} value={criterion.asc ? "asc" : "desc"}
            onChange={(event) => replace(index, { ...criterion, asc: event.target.value === "asc" })}>
            <option value="asc">{t("Ascending")}</option><option value="desc">{t("Descending")}</option>
          </select>
        </label>
        <SequenceControls index={index} length={draft.length} move={(next) => setDraft(moveItem(draft, index, next))}
          remove={() => setDraft(draft.filter((_, i) => i !== index))} />
      </div>)}
      <DialogIconButton label={t("Add criterion")} disabled={!unused}
        onClick={() => { if (unused) setDraft([...draft, { mode: unused, asc: true }]); }}><Plus /></DialogIconButton>
    </div>
  </Dialog>;
}

export function SortGroupsSettings({ groups, onChange }: { groups: SortGroup[]; onChange: (groups: SortGroup[]) => void }) {
  const replace = (index: number, group: SortGroup) => onChange(groups.map((item, i) => i === index ? group : item));
  return <div className="dialog-body sort-sequence">
    <p>{t("The first matching filename mask wins. Use * for any number of characters and ? for a single character.")}</p>
    {groups.map((group, index) => <div className="sort-sequence-row" key={index}>
      <label>{t("Filename mask")}
        <input type="text" aria-label={t("Filename mask {0}", index + 1)} aria-invalid={!group.mask.trim()}
          value={group.mask} onChange={(event) => replace(index, { ...group, mask: event.target.value })} />
      </label>
      <label>{t("Position")}
        <select aria-label={t("Position for group {0}", index + 1)} value={group.position}
          onChange={(event) => replace(index, { ...group, position: event.target.value === "after" ? "after" : "before" })}>
          <option value="before">{t("Before unmatched items")}</option>
          <option value="after">{t("After unmatched items")}</option>
        </select>
      </label>
      <SequenceControls index={index} length={groups.length} move={(next) => onChange(moveItem(groups, index, next))}
        remove={() => onChange(groups.filter((_, i) => i !== index))} />
      {!group.mask.trim() && <p className="dialog-error" role="alert">{t("Enter a filename mask.")}</p>}
    </div>)}
    <DialogIconButton label={t("Add sort group")} onClick={() => onChange([...groups, { mask: "", position: "before" }])}><Plus /></DialogIconButton>
  </div>;
}
