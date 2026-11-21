import { api, describeError, type ReleaseHighlights } from "./api";
import { t } from "./i18n";

export function ReleaseNotes({ release, onError }: { release: ReleaseHighlights; onError: (error: string) => void }) {
  const url = `https://github.com/agrynco/dirlume/releases/tag/v${encodeURIComponent(release.version)}`;
  return <section className="release-notes" aria-label={t("Release highlights")}>
    {release.highlights.length > 0 && <ul>
      {release.highlights.map((highlight, index) => <li key={index}>{highlight}</li>)}
    </ul>}
    <a href={url} onClick={(event) => {
      event.preventDefault();
      void api.openWebLink(url).catch((error: unknown) => onError(describeError(error)));
    }} onAuxClick={(event) => event.preventDefault()}>{t("Full release notes for {0}", release.version)}</a>
  </section>;
}
