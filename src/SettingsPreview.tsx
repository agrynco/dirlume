import { t } from "./i18n";
import { useLayoutEffect, useRef } from "react";
import { File, Folder, FolderTree } from "lucide-react";
import { applyAppearance, fileColor } from "./appearance";
import type { AppearanceSection } from "./AppearanceSettings";
import { showShortcut, type Preferences } from "./preferences";
import { viewFontKeys, viewFonts } from "./viewFonts";

type PreviewPage = AppearanceSection | "viewFonts" | "general" | "shortcuts";

const fileSamples = ["main.rs", "notes.md", "report.pdf", "photo.png", "recording.mp4", "backup.zip", "config.json", "setup.exe"];
const hiddenSample = { name: ".env", hidden: true };
const systemSample = { name: "System Volume Information", directory: true, hidden: true, system: true };

function Samples({ hidden, all }: { hidden: boolean; all: boolean }) {
  const files = all ? fileSamples : ["main.rs", "notes.md", "photo.png"];
  const samples: Parameters<typeof fileColor>[0][] = files.map((name) => ({ name }));
  if (all || hidden) samples.push(hiddenSample);
  if (all) samples.push(systemSample);
  return (
    <div className={`preview-files${all ? " preview-file-types" : ""}`}>
      {!all && <div className="preview-folder"><Folder /> {t("Project")}</div>}
      {samples.map((entry, index) => {
        const color = fileColor(entry);
        return <div className={`preview-file${!all && index === 1 ? " preview-file-selected" : ""}`} key={entry.name}>
          {entry.directory ? <Folder /> : <File />}
          <span style={color && (all || index !== 1) ? { color: `var(--${color})` } : undefined}>{entry.name}</span>
        </div>;
      })}
    </div>
  );
}

function CodeSample() {
  return <pre className="preview-code"><span className="syntax-comment">// {t("Preview settings")}</span>{"\n"}
    <span className="syntax-keyword">const</span> options = {"{"}{"\n  "}
    <span className="syntax-property">name</span>: <span className="syntax-string">"Dirlume"</span>,{"\n  "}
    <span className="syntax-property">zoom</span>: <span className="syntax-number">100</span>{"\n}"};</pre>;
}

export function SettingsPreview({ page, preferences }: { page: PreviewPage; preferences: Preferences }) {
  const preview = useRef<HTMLDivElement>(null);
  const scheme = preferences.schemes.find(({ id }) => id === preferences.activeScheme) ?? null;
  const { theme } = preferences;
  useLayoutEffect(() => {
    const element = preview.current;
    if (!element) return;
    const apply = () => applyAppearance(theme, scheme, element);
    const media = matchMedia("(prefers-color-scheme: dark)");
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme, scheme]);

  return (
    <section className="settings-preview" aria-label={t("Settings preview")}>
      <h3>{t("Preview")}</h3>
      <div className="preview-frame" ref={preview}>
        {page === "dialogs" ? (
          <div className="preview-dialog">
            <strong>{t("Copy report.pdf")}</strong>
            <div className="preview-field">{t("Downloads")}</div>
            <div className="preview-dialog-actions"><span>{t("Cancel")}</span><span className="preview-primary">{t("Copy")}</span></div>
          </div>
        ) : page === "viewFonts" ? (
          <dl className="preview-view-fonts">
            {viewFontKeys.map((view) => {
              const { label, group, family, sample } = viewFonts[view];
              return <div key={view}>
                <dt>{t(label)}</dt>
                <dd style={{ fontSize: preferences.viewFontSizes[view] ?? `var(--${group}-size)`, fontFamily: `var(${family})` }}>{t(sample)}</dd>
              </div>;
            })}
          </dl>
        ) : page === "text" ? <CodeSample /> :
          page === "files" ? <Samples hidden={preferences.hidden} all /> :
          page === "shortcuts" ? (
            <div className="preview-shortcuts">
              {([["View", "view"], ["Edit", "edit"], ["Find files", "search"], ["Copy", "copy"]] as const).map(([label, command]) => (
                <span key={command}>{t(label)}<kbd>{showShortcut(preferences.shortcuts[command]) || t("Unassigned")}</kbd></span>
              ))}
            </div>
          ) : (
            <>
              <div className="preview-toolbar"><FolderTree />{t("Project")}<span className="preview-toolbar-action">{t("Connect")}</span></div>
              <div className={page === "fonts" ? "preview-fonts" : undefined}>
                <Samples hidden={preferences.hidden} all={false} />
                {page === "fonts" && <CodeSample />}
              </div>
            </>
          )}
      </div>
    </section>
  );
}
