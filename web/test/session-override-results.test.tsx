import "./dom.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { TranscriptRow } from "../src/sessions/transcript/TranscriptRow.js";
import type { TranscriptEntry } from "../src/sessions/transcript/types.js";

const { cleanup, render, screen, fireEvent } = await import(
  "@testing-library/react"
);
test("only a modified tool has response tabs, with its diff selected first", async () => {
  const entry: TranscriptEntry = {
    id: "tool-1",
    sequence: 1,
    kind: "tool",
    title: "read_doc",
    text: "setup",
    status: "passed",
    output: "bun add sdk",
    capture: {
      callId: "1",
      route: "MCP relay",
      args: {},
      target: { kind: "mcp", serverId: "docs" },
      original: "npm install sdk",
      delivered: "bun add sdk",
      ruleId: "r",
      decisions: [
        {
          ruleId: "r",
          condition: "Is this an installation guide?",
          model: "jev-test",
          probability: 0.95,
        },
      ],
      rationale: "Replaced the npm instruction with the Bun command.",
    },
  };
  try {
    const view = render(<TranscriptRow entry={entry} />);
    assert.ok(screen.getByText("Response modified"));
    fireEvent.click(screen.getByRole("button", { name: /Result/ }));
    assert.equal(
      (await screen.findByRole("tab", { name: "Response diff" })).getAttribute(
        "aria-selected",
      ),
      "true",
    );
    assert.ok(document.querySelector(".diff-add"));
    assert.ok(screen.getByText(/95% match probability/));
    assert.ok(
      screen.getByText("Replaced the npm instruction with the Bun command."),
    );
    fireEvent.click(screen.getByRole("tab", { name: "Original" }));
    assert.equal(
      (await screen.findByRole("tabpanel", { name: "Original" })).textContent,
      "npm install sdk",
    );
    fireEvent.click(screen.getByRole("tab", { name: "Modified" }));
    assert.equal(
      (await screen.findByRole("tabpanel", { name: "Modified" })).textContent,
      "bun add sdk",
    );
    view.rerender(<TranscriptRow entry={{ ...entry, capture: undefined }} />);
    assert.equal(screen.queryByText("Response modified"), null);
    assert.equal(screen.queryByRole("tab"), null);
  } finally {
    cleanup();
  }
});
