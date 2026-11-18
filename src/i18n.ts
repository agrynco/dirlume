import { translations } from "./translations";

export const languages = { en: "English", uk: "Українська", ru: "Русский" } as const;
export type Language = keyof typeof languages;
const locales: Record<Language, string> = { en: "en-US", uk: "uk-UA", ru: "ru-RU" };
let language: Language = "en";

export function readLanguage(value: unknown): Language {
  return value === "uk" || value === "ru" ? value : "en";
}

export function setLanguage(next: Language) {
  language = next;
  document.documentElement.lang = next;
}

export function locale() {
  return locales[language];
}

export function t(message: string, ...values: (string | number)[]) {
  const variants = Object.hasOwn(translations, message) ? translations[message] : undefined;
  const pattern = language === "en" ? message : variants?.[language === "uk" ? 0 : 1] ?? message;
  return values.length ? pattern.replace(/\{(\d+)\}/g, (placeholder, index: string) => {
    const value = values[Number(index)];
    return typeof value === "number" ? value.toLocaleString(locale()) : value ?? placeholder;
  }) : pattern;
}

// Keep OS and server diagnostics intact when their wording is outside the application catalog.
export function errorText(message: string) {
  const translated = t(message);
  if (translated !== message) return translated;
  const diagnostic = /^(.+?) (\(os error \d+\))$/.exec(message);
  if (diagnostic && t(diagnostic[1]) !== diagnostic[1]) return t(diagnostic[1]) + " " + diagnostic[2];
  return message;
}

const nounForms = {
  folder: { en: ["folder", "folders"], uk: ["папка", "папки", "папок"], ru: ["папка", "папки", "папок"] },
  file: { en: ["file", "files"], uk: ["файл", "файли", "файлів"], ru: ["файл", "файла", "файлов"] },
  item: { en: ["item", "items"], uk: ["елемент", "елементи", "елементів"], ru: ["элемент", "элемента", "элементов"] },
  match: { en: ["match", "matches"], uk: ["збіг", "збіги", "збігів"], ru: ["совпадение", "совпадения", "совпадений"] },
  process: { en: ["process", "processes"], uk: ["процес", "процеси", "процесів"], ru: ["процесс", "процесса", "процессов"] },
} as const;
const plurals = Object.fromEntries(Object.entries(locales).map(([key, value]) => [key, new Intl.PluralRules(value)])) as Record<Language, Intl.PluralRules>;

export function countText(count: number, noun: keyof typeof nounForms) {
  const rule = plurals[language].select(count);
  const forms = nounForms[noun][language];
  const form = rule === "one" ? forms[0] : language === "en" || rule === "few" ? forms[1] : forms[2];
  return `${count.toLocaleString(locale())} ${form}`;
}
