import { StreamLanguage } from "@codemirror/language";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";

const regex = StreamLanguage.define({
  startState: () => ({ inClass: false }),
  token(stream, state) {
    if (stream.match(/^\\(?:[pP]\{[^}]*\}|.)/)) return "escape";
    const c = stream.next();
    if (c === "[" && !state.inClass) {
      state.inClass = true;
      return "squareBracket";
    }
    if (c === "]" && state.inClass) {
      state.inClass = false;
      return "squareBracket";
    }
    if (state.inClass) return "string";
    if (c === "(" || c === ")") return "paren";
    if (c === "{" && stream.match(/^\d+(?:,\d*)?\}/)) return "number";
    return c && "^$|.*+?".includes(c) ? "operator" : null;
  },
});
const extensions = [
  regex,
  EditorView.lineWrapping,
  EditorView.contentAttributes.of({ "aria-label": "Find pattern" }),
];
export function RegexInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      theme="dark"
      placeholder="posthog-(js|node)"
      extensions={extensions}
      basicSetup={{
        lineNumbers: false,
        foldGutter: false,
        highlightActiveLine: false,
        closeBrackets: false,
      }}
    />
  );
}
