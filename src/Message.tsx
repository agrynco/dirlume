import type { ReactNode } from "react";
import { t } from "./i18n";

export function Message({ text, children }: { text: string; children: ReactNode }) {
  const [before, after] = t(text).split("{0}");
  return <>{before}{children}{after}</>;
}
