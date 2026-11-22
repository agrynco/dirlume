import { LanguageSupport, StreamLanguage } from "@codemirror/language";

type NginxState = { directive: boolean; inArgument: boolean; quote: string; depth: number };
const variable = /^\$(?:\{\w+\}|\w+)/;

export const nginxSyntax = new LanguageSupport(StreamLanguage.define<NginxState>({
  name: "nginx",
  startState: () => ({ directive: true, inArgument: false, quote: "", depth: 0 }),
  token(stream, state) {
    if (!state.quote) {
      if (stream.sol()) state.inArgument = false;
      if (stream.eatSpace()) {
        state.inArgument = false;
        return null;
      }
      if (!state.inArgument && stream.eat("#")) {
        stream.skipToEnd();
        return "comment";
      }
      const delimiter = stream.eat(/[;{}]/);
      if (delimiter) {
        if (delimiter === "{") state.depth++;
        if (delimiter === "}") state.depth = Math.max(0, state.depth - 1);
        state.directive = true;
        state.inArgument = false;
        return "punctuation";
      }
    }

    const directive = state.directive;
    const argumentStart = !state.inArgument;
    state.directive = false;
    state.inArgument = true;
    if (stream.match(variable)) return "propertyName";

    if (!state.quote && argumentStart) state.quote = stream.eat(/["']/) || "";
    if (state.quote) {
      while (!stream.eol() && !(stream.peek() === "$" && stream.match(variable, false))) {
        const ch = stream.next();
        if (ch === "\\") stream.next();
        else if (ch === state.quote) {
          state.quote = "";
          break;
        }
      }
      return "string";
    }

    // Consume a bare argument up to its next variable or directive delimiter.
    if (!stream.match(/^(?:\\.?|[^\s;{}$\\])+/)) stream.next();
    const word = stream.current();
    if (directive && /^[a-z_]\w*$/i.test(word)) return "keyword";
    if (argumentStart && /^\d+(?:\.\d+)?(?:ms|[kmgshdwy])?$/i.test(word)) return "number";
    return null;
  },
  indent(state, textAfter, { unit }) {
    return Math.max(0, state.depth - (/^\s*}/.test(textAfter) ? 1 : 0)) * unit;
  },
  languageData: { indentOnInput: /^\s*}$/, commentTokens: { line: "#" } },
}));
