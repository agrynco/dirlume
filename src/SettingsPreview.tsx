import { t } from "./i18n";
import { useLayoutEffect, useRef, type CSSProperties } from "react";
import { Check, File, Folder, FolderTree } from "lucide-react";
import { applyAppearance, colorKeysForSurface, fileColor, fontGroups, resolveAppearance, useSystemTheme, type Surface } from "./appearance";
import type { AppearanceSection } from "./AppearanceSettings";
import { shortcutBindings, showShortcut, type Preferences } from "./preferences";
import { viewFontKeys, viewFonts } from "./viewFonts";
import { optionSurfaces, type FeaturePage } from "./featureOptions";
import { pickedSurface, pickLabel, type AppearancePick } from "./appearancePick";

type PreviewPage = AppearanceSection | FeaturePage | "viewFonts" | "general" | "shortcuts";

const fileSamples = ["main.rs", "notes.md", "report.pdf", "photo.png", "recording.mp4", "backup.zip", "config.json", "setup.exe"];
const hiddenSample = { name: ".env", hidden: true };
const systemSample = { name: "System Volume Information", directory: true, hidden: true, system: true };

function Samples({ hidden, all, showMarkedCursor }: { hidden: boolean; all: boolean; showMarkedCursor?: boolean }) {
  const files = all ? fileSamples : ["main.rs", "notes.md", "photo.png"];
  const samples: Parameters<typeof fileColor>[0][] = files.map((name) => ({ name }));
  if (all || hidden) samples.push(hiddenSample);
  if (all) samples.push(systemSample);
  return (
    <div className={`preview-files${all ? " preview-file-types" : ""}`}>
      {!all && <div className="preview-folder"><Folder /> {t("Project")}</div>}
      {samples.map((entry, index) => {
        const color = fileColor(entry);
        const currentMarked = showMarkedCursor && index === 2;
        const selection = currentMarked ? " preview-file-current-marked" : !all && index === 1 ? " preview-file-selected" : "";
        return <div className={`preview-file${selection}`} key={entry.name}>
          {currentMarked ? <Check /> : entry.directory ? <Folder /> : <File />}
          <span style={color && !selection ? { color: `var(--${color})` } : undefined}>{entry.name}</span>
        </div>;
      })}
    </div>
  );
}

function CodeSample({ style, surface }: { style?: CSSProperties; surface?: Surface } = {}) {
  return <pre className="preview-code" data-text-surface={surface} style={style}><span className="syntax-comment">// {t("Preview settings")}</span>{"\n"}
    <span className="syntax-keyword">const</span> options = {"{"}{"\n  "}
    <span className="syntax-property">name</span>: <span className="syntax-string">"Dirlume"</span>,{"\n  "}
    <span className="syntax-property">zoom</span>: <span className="syntax-number">100</span>{"\n}"};</pre>;
}

function SurfacePreview({ surface, preferences }: { surface: Surface; preferences: Preferences }) {
  const [background, ink] = colorKeysForSurface(surface);
  const view = viewFontKeys.find((key) => viewFonts[key].group === surface);
  const style = {
    background: `var(--${background})`, color: `var(--${ink})`,
    fontFamily: `var(--${surface}-font)`, fontSize: (view && preferences.viewFontSizes[view]) ?? `var(--${surface}-size)`,
  };
  const sample = view ? viewFonts[view].sample : surface === "compare" ? "README.txt" : "$ dirlume";
  return <div className="surface-preview">
    <div className="surface-preview-label">{t(fontGroups[surface].label)}</div>
    {surface === "viewer" || surface === "editor" ? <CodeSample surface={surface} style={style} /> :
      <pre className="preview-code" style={style}>
        {surface === "compare" ? <><span style={{ background: "var(--compare-removed)" }}>− dirlume.txt</span>{"\n"}
          <span style={{ background: "var(--compare-added)" }}>+ README.txt</span></> :
          surface === "markdown" ? <><span style={{ color: "var(--markdown-link)", textDecoration: "underline" }}>{t(sample)}</span>{" "}
            <span style={{ background: "var(--markdown-search)", color: "var(--markdown-search-ink)" }}>Dirlume</span></> : t(sample)}
      </pre>}
  </div>;
}

function PickPreview({ pick, preferences }: { pick: AppearancePick; preferences: Preferences }) {
  const background = ["panel-current-marked-bg", "danger-action", "accent-fill", "panel-selection", "panel-inactive-selection", "viewer-bg", "text-bg", "dialog-input",
    "dialog-header", "dialog-bg", "mermaid-node-bg", "panel-header", "panel-bg", "raised", "surface", "canvas"]
    .find((color) => pick.colors.some((item) => item === color));
  const foreground = ["panel-marked", "on-danger-action", "on-accent", "panel-selected-ink", ...pick.colors.filter((color) => color.startsWith("file-")),
    "mermaid-node-ink", "dialog-ink", "text-ink", "panel-ink", "muted", "ink"]
    .find((color) => pick.colors.some((item) => item === color));
  const style: CSSProperties = {
    background: pick.layout === "twin" && pick.row === "current" && pick.colors.includes("accent")
      ? "color-mix(in srgb, var(--accent) 20%, var(--panel-bg))" : background && `var(--${background})`,
    color: foreground && `var(--${foreground})`,
    fontFamily: pick.font && `var(--${pick.font}-font)`,
    fontSize: (pick.view && preferences.viewFontSizes[pick.view]) || (pick.font && `var(--${pick.font}-size)`),
    borderColor: pick.colors.includes("accent") ? "var(--accent)" : "var(--line)",
  };
  return <div className={`preview-picked-element${pick.row === "currentMarked" ? " preview-file-current-marked" : ""}`}
    style={pick.row === "currentMarked" ? { ...style, color: "var(--panel-selected-ink)" } : style}>{pickLabel(pick)}</div>;
}

export function SettingsPreview({ page, preferences, pick }: { page: PreviewPage; preferences: Preferences; pick?: AppearancePick }) {
  const preview = useRef<HTMLDivElement>(null);
  const { theme, scheme } = resolveAppearance(preferences, useSystemTheme());
  const shortcuts = shortcutBindings(preferences);
  const fontViews = page === "viewFonts" ? viewFontKeys : null;
  const surface = pick && pickedSurface(pick);
  const surfaces = page === "viewer" || page === "editor" || page === "terminal" || page === "text" ? optionSurfaces[page] : [];
  useLayoutEffect(() => {
    if (preview.current) applyAppearance(theme, scheme, preview.current, preferences.retainedFonts);
  }, [theme, scheme, preferences.retainedFonts]);

  return (
    <section className="settings-preview" aria-label={t("Settings preview")}>
      <h3>{t("Preview")}</h3>
      <div className="preview-frame" ref={preview}>
        {pick ? surface ? <SurfacePreview surface={surface} preferences={preferences} /> : <PickPreview pick={pick} preferences={preferences} /> : page === "dialogs" ? (
          <div className="preview-dialog">
            <strong>{t("Copy report.pdf")}</strong>
            <div className="preview-field">{t("Downloads")}</div>
            <div className="preview-dialog-actions"><span>{t("Cancel")}</span><span className="preview-primary">{t("Copy")}</span></div>
          </div>
        ) : fontViews ? (
          <dl className="preview-view-fonts">
            {fontViews.map((view) => {
              const { label, group, family, sample } = viewFonts[view];
              return <div key={view}>
                <dt>{t(label)}</dt>
                <dd style={{ fontSize: preferences.viewFontSizes[view] ?? `var(--${group}-size)`, fontFamily: `var(${family})` }}>{t(sample)}</dd>
              </div>;
            })}
          </dl>
        ) : surfaces.length ? (
          <>
            {surfaces.map((surface) => <SurfacePreview key={surface} surface={surface} preferences={preferences} />)}
            {page === "text" && <CodeSample />}
          </>
        ) :
          page === "files" ? <Samples hidden={preferences.hidden} all /> :
          page === "shortcuts" ? (
            <div className="preview-shortcuts">
              {([["View", "view"], ["Edit", "edit"], ["Find files", "search"], ["Copy", "copy"]] as const).map(([label, command]) => (
                <span key={command}>{t(label)}<kbd>{showShortcut(shortcuts[command][0]) || t("Unassigned")}</kbd></span>
              ))}
            </div>
          ) : (
            <>
              <div className="preview-toolbar"><FolderTree />{t("Project")}<span className="preview-toolbar-action">{t("Connect")}</span></div>
              <div className={page === "fonts" ? "preview-fonts" : undefined}>
                <Samples hidden={preferences.hidden} all={false} showMarkedCursor={page === "panels" || page === "filePanels"} />
                {page === "fonts" && <CodeSample />}
              </div>
            </>
          )}
      </div>
    </section>
  );
}
