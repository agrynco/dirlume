import { menuPositions, type MenuPosition } from "./preferences";
import { SettingSearchLabel } from "./SettingSearchLabel";
import { t } from "./i18n";

export const menuAlignmentTerms = [...Object.values(menuPositions), "Align left", "Align center", "Align right"];

export function MenuAlignmentSetting({ label, value, onChange }: {
  label: string;
  value: MenuPosition;
  onChange: (value: MenuPosition) => void;
}) {
  return <label className="setting">
    <SettingSearchLabel label={label} aliases={menuAlignmentTerms} />
    <select value={value} onChange={(event) => onChange(event.target.value as MenuPosition)}>
      {Object.entries(menuPositions).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
    </select>
  </label>;
}
