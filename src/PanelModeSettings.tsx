import { Plus } from "lucide-react";
import { DialogIconButton, RowOrderActions } from "./DialogActions";
import { t } from "./i18n";
import { panelFields, panelNameOptions, isNameField, panelWidthsFit, validPanelWidth, type PanelColumn, type PanelField, type PanelMode, type PanelNameOption } from "./panelModes";
import { SettingSearchLabel } from "./SettingSearchLabel";

export const panelModeSettingsLabels = [
  "Name", "Column types", "Column widths", "Status line column types", "Status line column widths",
  ...Object.values(panelFields), ...Object.values(panelNameOptions),
];

const options = Object.entries(panelFields) as [PanelField, string][];

function ColumnSettings({ columns, status, onChange }: {
  columns: PanelColumn[];
  status: boolean;
  onChange: (columns: PanelColumn[]) => void;
}) {
  const typeLabel = status ? "Status line column types" : "Column types";
  const widthLabel = status ? "Status line column widths" : "Column widths";
  const set = (index: number, column: PanelColumn) => onChange(columns.map((value, i) => i === index ? column : value));
  function move(index: number, next: number) {
    const ordered = [...columns];
    [ordered[index], ordered[next]] = [ordered[next], ordered[index]];
    onChange(ordered);
  }

  return <fieldset className="panel-mode-fields">
    <legend><SettingSearchLabel label={typeLabel} /></legend>
    {columns.length > 0 && <div className="panel-mode-field-head"><span>{t("Field")}</span><SettingSearchLabel label={widthLabel} /></div>}
    {columns.map((column, index) => {
      const valid = validPanelWidth(column.width);
      return <div key={index} className="panel-mode-field">
        <select aria-label={t("{0}, field {1}", t(typeLabel), index + 1)} value={column.field}
          onChange={(event) => set(index, { ...column, field: event.target.value as PanelField })}>
          {options.map(([field, label]) => <option key={field} value={field}>{t(label)}</option>)}
        </select>
        <input type="text" aria-label={t("{0}, field {1}", t(widthLabel), index + 1)} aria-invalid={!valid}
          aria-describedby={valid ? undefined : `panel-width-${status}-${index}`}
          value={column.width} onChange={(event) => set(index, { ...column, width: event.target.value })} />
        <RowOrderActions up={t("Move field {0} up", index + 1)} down={t("Move field {0} down", index + 1)}
          remove={t("Remove field {0}", index + 1)} first={index === 0} last={index === columns.length - 1}
          onMove={(offset) => move(index, index + offset)} onRemove={() => onChange(columns.filter((_, i) => i !== index))} />
        {!valid && <p className="dialog-error" role="alert" id={`panel-width-${status}-${index}`}>
          {t("Enter 0 for automatic, a character count from 1 to 999, or a percentage from 1% to 100%.")}
        </p>}
      </div>;
    })}
    {!panelWidthsFit(columns) &&
      <p className="dialog-error" role="alert">{t("Percentage widths must add up to 100% or less.")}</p>}
    {!status && !columns.some(({ field }) => isNameField(field)) &&
      <p className="dialog-error" role="alert">{t("Include at least one name field in the file list.")}</p>}
    <DialogIconButton label={t("Add field")} onClick={() => onChange([...columns, { field: "name", width: "0" }])}><Plus /></DialogIconButton>
  </fieldset>;
}

export function PanelModeSettings({ mode, defaultName, onChange }: {
  mode: PanelMode;
  defaultName: string;
  onChange: (mode: PanelMode) => void;
}) {
  return <div className="dialog-body panel-mode-settings">
    <label className="setting"><SettingSearchLabel label="Name" />
      <input type="text" value={mode.name} placeholder={defaultName}
        onChange={(event) => onChange({ ...mode, name: event.target.value })} />
    </label>
    <p className="panel-width-guide">{t("Use 0 for automatic width, a number for characters, or % for a share of the remaining space.")}</p>
    <ColumnSettings columns={mode.list} status={false} onChange={(list) => onChange({ ...mode, list })} />
    <ColumnSettings columns={mode.status} status onChange={(status) => onChange({ ...mode, status })} />
    {Object.entries(panelNameOptions).map(([key, label]) => {
      const option = key as PanelNameOption;
      return <label key={key} className="field-checkbox"><SettingSearchLabel label={label} />
        <input type="checkbox" checked={mode[option]} onChange={(event) => onChange({ ...mode, [option]: event.target.checked })} />
      </label>;
    })}
  </div>;
}
