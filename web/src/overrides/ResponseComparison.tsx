import CodeMirror, { Decoration, EditorView } from "@uiw/react-codemirror";
import { type Change, diffWordsWithSpace } from "diff";
import { useMemo } from "react";

const editorSetup = {
  lineNumbers: true,
  foldGutter: false,
  highlightActiveLine: false,
  highlightActiveLineGutter: false,
  highlightSelectionMatches: false,
  autocompletion: false,
  closeBrackets: false,
};

function ResponsePane({
  title,
  text,
  parts,
  side,
  onEdit,
}: {
  title: string;
  text: string;
  parts: Change[] | undefined;
  side: "before" | "after";
  onEdit?: ((text: string) => void) | undefined;
}) {
  const editable = Boolean(onEdit);
  const extensions = useMemo(() => {
    let offset = 0;
    const ranges = [];
    for (const part of parts ?? []) {
      if (side === "before" ? part.added : part.removed) continue;
      const start = offset;
      offset += part.value.length;
      if (offset > start && (part.added || part.removed)) {
        ranges.push(
          Decoration.mark({
            class: part.added ? "diff-add" : "diff-remove",
          }).range(start, offset),
        );
      }
    }
    const marks = Decoration.set(ranges);
    return [
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({
        "aria-label": title,
        "aria-readonly": String(!editable),
      }),
      EditorView.decorations.compute(["doc"], (state) =>
        state.doc.length === text.length ? marks : Decoration.none,
      ),
    ];
  }, [parts, side, text.length, title, editable]);
  return (
    <section className="response-pane" data-side={side}>
      <header>
        <h3>{title}</h3>
        <span>{onEdit ? "Editable" : "Read only"}</span>
      </header>
      <CodeMirror
        value={text}
        editable={!!onEdit}
        readOnly={!onEdit}
        theme="none"
        indentWithTab={false}
        basicSetup={editorSetup}
        extensions={extensions}
        {...(onEdit && { onChange: onEdit })}
      />
    </section>
  );
}

export function ResponseComparison({
  before,
  after,
  onEdit,
  beforeTitle = "Original response",
  afterTitle = "Response for the agent",
}: {
  beforeTitle?: string;
  afterTitle?: string;
  before: string;
  after: string;
  onEdit?: ((text: string) => void) | undefined;
}) {
  // CodeMirror represents each line break with one document position.
  const left = before.replace(/\r\n?/g, "\n");
  const right = after.replace(/\r\n?/g, "\n");
  const parts = useMemo(
    () =>
      left === right
        ? undefined
        : (diffWordsWithSpace(left, right, {
            timeout: 40,
            maxEditLength: 1500,
          }) ?? [
            { value: left, added: false, removed: true, count: 1 },
            { value: right, added: true, removed: false, count: 1 },
          ]),
    [left, right],
  );
  return (
    <div className="response-comparison">
      <ResponsePane
        title={beforeTitle}
        text={left}
        parts={parts}
        side="before"
      />
      <span className="response-direction" aria-hidden="true">
        →
      </span>
      <ResponsePane
        title={afterTitle}
        text={right}
        parts={parts}
        side="after"
        onEdit={onEdit}
      />
    </div>
  );
}
