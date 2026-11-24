import "./dom.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionDetail } from "../src/sessions/SessionDetail.js";

const { cleanup, render, within, screen, fireEvent } = await import(
  "@testing-library/react"
);

test("a drift finding opens the exact edited response from another tab", async () => {
  const fetch = globalThis.fetch;
  const scroll = HTMLElement.prototype.scrollIntoView;
  let scrolledTo: HTMLElement | undefined;
  HTMLElement.prototype.scrollIntoView = function () {
    scrolledTo = this;
  };
  const responses = ["first", "second"].map((callId, i) => ({
    sequence: i + 1,
    phase: "response",
    event: {
      callId,
      route: "Shell",
      args: {},
      target: { kind: "shell", command: "npm install sdk", match: "batch" },
      ruleId: "rule",
      original: "installed",
      delivered: "run setup",
    },
  }));
  const session = {
    id: "s",
    model: "test",
    harness: "pi",
    status: "completed",
    eval: { title: "Install" },
    interceptedCalls: 2,
    decisions: [],
    snapshot: {
      skills: [],
      mcps: [],
      evaluation: {
        prompt: "Install the SDK",
        criteria: [],
        judge: { model: "test", harness: "pi" },
        responseOverrides: [
          {
            id: "rule",
            target: { kind: "shell", command: "npm install sdk" },
            find: "installed",
            replacement: "run setup",
          },
        ],
      },
    },
    behaviorDrift: [
      {
        callId: "first",
        outcome: "observed",
        explanation: "The agent ran setup.",
      },
      {
        callId: "second",
        outcome: "uncertain",
        explanation: "The trace ends after the second call.",
      },
    ],
  };
  try {
    globalThis.fetch = (async (path) =>
      Response.json(
        String(path).includes("/events?")
          ? responses
          : String(path).includes("/sessions/s?")
            ? session
            : [],
      )) as typeof fetch;
    render(<SessionDetail id={session.id} />);
    const drift = await screen.findByRole("region", {
      name: "Model behavior drift",
    });
    const findings = within(drift).getAllByRole("listitem");
    assert.equal(findings.length, 2);
    assert.match(
      findings[1]?.textContent ?? "",
      /Rule 1 · installed → run setup/,
    );
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "unrelated" },
    });
    fireEvent.click(screen.getByRole("tab", { name: "Judge logs" }));
    fireEvent.click(
      await within(drift).findByRole("button", { name: "Shell · Trace #2" }),
    );
    assert.equal(
      screen
        .getByRole("tab", { name: "Agent logs" })
        .getAttribute("aria-selected"),
      "true",
    );
    const diff = await screen.findByRole("tabpanel", { name: "Response diff" });
    assert.equal(diff.closest("article")?.id, "trace-response-second");
    assert.equal(scrolledTo?.id, "trace-response-second");
  } finally {
    cleanup();
    globalThis.fetch = fetch;
    HTMLElement.prototype.scrollIntoView = scroll;
  }
});
