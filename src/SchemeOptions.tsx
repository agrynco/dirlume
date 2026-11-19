import { builtInThemes, schemeFits, type Scheme } from "./appearance";
import { t } from "./i18n";

export function SchemeOptions({ schemes, mode }: { schemes: Scheme[]; mode?: "light" | "dark" }) {
  const custom = mode ? schemes.filter(({ base }) => schemeFits(base, mode)) : schemes;
  return <>
    <optgroup label={t("Built in")}>
      {Object.entries(builtInThemes).map(([value, label]) =>
        (!mode || (value !== "system" && schemeFits(value as Scheme["base"], mode))) &&
        <option key={value} value={value}>{t(label)}</option>)}
    </optgroup>
    {custom.length > 0 && <optgroup label={t("Custom")}>
      {custom.map(({ id, name }) => <option key={id} value={`custom:${id}`}>{name.trim() || t("Custom scheme")}</option>)}
    </optgroup>}
  </>;
}
