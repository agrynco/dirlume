import { languages } from "@codemirror/language-data";

export const languageChoices = [...languages].sort((left, right) => left.name.localeCompare(right.name));
