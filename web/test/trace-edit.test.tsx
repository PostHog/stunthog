import "./dom.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionDetail } from "../src/sessions/SessionDetail.js";
import { TraceEditDialog } from "../src/sessions/TraceEditDialog.js";

const { cleanup, fireEvent, render, screen, waitFor, within } = await import(
  "@testing-library/react"
);

test("the original trace and branch tree identify shared and nested fork points", async () => {
  const originalFetch = globalThis.fetch;
  const model = { model: "test", harness: "pi" };
  const parent = {
    ...model,
    id: "parent",
    status: "completed",
    origin: "organic",
    eval: { title: "Install" },
    decisions: [],
    snapshot: {
      skills: [],
      mcps: [],
      evaluation: {
        prompt: "Install the CLI",
        criteria: [],
        judge: model,
        responseOverrides: [],
      },
    },
  };
  const node = {
    status: "completed",
    createdAt: "2026-11-27T00:00:00Z",
    passed: 1,
    assessed: 1,
  };
  globalThis.fetch = async (url) => {
    if (String(url).includes("/parent/events?"))
      return Response.json([
        {
          sequence: 2,
          phase: "agent",
          event: {
            type: "assistant",
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "a",
                  name: "Bash",
                  input: { command: "pwd" },
                },
              ],
            },
          },
        },
        {
          sequence: 3,
          phase: "agent",
          event: {
            type: "user",
            message: {
              content: [
                { type: "tool_result", tool_use_id: "a", content: "workspace" },
              ],
            },
          },
        },
      ]);
    if (String(url).includes("/parent/branches"))
      return Response.json([
        { ...node, id: "parent", prompt: "Install the CLI" },
        {
          ...node,
          id: "child",
          parentSessionId: "parent",
          branchEntryId: "tool-a",
          prompt: "Bash · Entry 2",
          change: "Use the CLI",
        },
        {
          ...node,
          id: "sibling",
          parentSessionId: "parent",
          branchEntryId: "tool-a",
          prompt: "Bash · Entry 2",
        },
        {
          ...node,
          id: "nested",
          parentSessionId: "child",
          branchEntryId: "tool-b",
          prompt: "Read · Entry 4",
        },
      ]);
    if (String(url).includes("/child/starting-point"))
      return Response.json({
        kind: "tool-result",
        before: `${"unchanged ".repeat(65)}CLI version 1`,
        after: `${"unchanged ".repeat(65)}CLI version 22`,
      });
    if (String(url).includes("/sessions/child?"))
      return Response.json({
        ...parent,
        id: "child",
        origin: "synthetic",
        branchEntryId: "tool-a",
        snapshot: {
          ...parent.snapshot,
          editedStart: { label: "Bash · Entry 2", hasBackground: true },
        },
        parentSessionId: parent.id,
        rootSessionId: parent.id,
      });
    return Response.json(
      String(url).includes("/sessions/parent?") ? parent : [],
    );
  };
  try {
    render(<SessionDetail id={parent.id} />);
    const tree = await screen.findByRole("navigation", { name: "Branch tree" });
    const link = (name: string) => within(tree).getByRole("link", { name });
    assert.equal(link("Original").getAttribute("aria-current"), "page");
    assert.equal(
      link("Branch 1").getAttribute("href"),
      "#sessions/parent?branch=child",
    );
    assert.equal(
      link("Bash · Entry 2").getAttribute("href"),
      "#sessions/parent?entry=tool-a",
    );
    assert.equal(
      link("Read · Entry 4").getAttribute("href"),
      "#sessions/parent?branch=child&entry=tool-b",
    );
    assert(link("Branch 1").closest("li")?.contains(link("Branch 3")));
    assert(!link("Branch 1").closest("li")?.contains(link("Branch 2")));
    assert.equal(within(tree).getByText("Use the CLI").tagName, "SPAN");
    const trace = screen.getByRole("region", { name: "Session transcript" });
    for (const name of ["Branch 1", "Branch 2"]) {
      assert.equal(
        (await within(trace).findByRole("link", { name })).closest("article")
          ?.id,
        "trace-tool-a",
      );
    }
    assert.equal(within(trace).queryByRole("link", { name: "Branch 3" }), null);
    cleanup();
    render(<SessionDetail id={parent.id} branch="child" />);
    await screen.findByRole("heading", { name: "Branch 1" });
    const start = within(
      await screen.findByRole("region", { name: "Branch starting point" }),
    );
    await start.findByText("Edited tool result");
    assert.equal(start.getByText("22").tagName, "MARK");
    assert.equal(
      start
        .getByRole("link", { name: "Bash · Entry 2 in parent trace" })
        .getAttribute("href"),
      "#sessions/parent?entry=tool-a",
    );
    const preview = start.getByText("Edited tool result").nextElementSibling;
    assert.ok(preview);
    assert.ok(preview.textContent?.startsWith("…"));
    fireEvent.click(start.getByRole("button", { name: "Show full values" }));
    assert.equal(
      preview.textContent,
      `${"unchanged ".repeat(65)}CLI version 22`,
    );
    assert.ok(screen.getByRole("heading", { name: "Branch continuation" }));
    assert.equal(
      screen
        .getByRole("link", { name: "Original session" })
        .getAttribute("href"),
      "#sessions/parent",
    );
    const branchTree = screen.getByRole("navigation", { name: "Branch tree" });
    assert.equal(
      within(branchTree)
        .getByRole("link", { name: "Branch 1" })
        .getAttribute("aria-current"),
      "page",
    );
  } finally {
    cleanup();
    globalThis.fetch = originalFetch;
  }
});

test("preview an edited tool call with an explicit result and keep live execution separate", async () => {
  const restore = globalThis.fetch;
  const bodies: unknown[] = [];
  let started = "";
  const originalRoute = window.location.hash;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith("/api/sessions/s/edit-point"))
      return Response.json({
        harness: "pi",
        workspace: "initial",
        kind: "tool",
        tool: true,
        text: "npm list",
        args: { command: "npm list" },
        result: "Original package",
        next: [{ kind: "message", text: "Inspect package.json" }],
        provider: "openrouter",
        model: "test",
        models: [{ id: "test", name: "Test" }],
        canBranch: false,
        context: [],
      });
    if (url === "/api/sessions/s/branches") {
      bodies.push(JSON.parse(String(options?.body)));
      return Response.json({ id: "child" });
    }
    assert.equal(url, "/api/sessions/s/previews");
    bodies.push(JSON.parse(String(options?.body)));
    return Response.json({
      action: { kind: "message", text: "Check the CLI version" },
      model: "test",
      cost: null,
      tokens: 12,
    });
  };
  try {
    render(
      <TraceEditDialog
        session={{ id: "s" }}
        entryId="tool-npm"
        onClose={() => {}}
        onBranchCreated={(id) => {
          started = id;
        }}
      />,
    );
    assert.equal(
      (
        (await screen.findByLabelText(
          "Edited tool result",
        )) as HTMLTextAreaElement
      ).value,
      "Original package",
    );
    fireEvent.click(screen.getByRole("combobox", { name: "Edit" }));
    const option = await screen.findByRole("option", {
      name: "Tool arguments",
    });
    fireEvent.pointerDown(option);
    fireEvent.click(option);
    const args = (await screen.findByLabelText(
      "Edited arguments (JSON)",
    )) as HTMLTextAreaElement;
    assert.equal(JSON.parse(args.value).command, "npm list");
    const preview = screen.getByRole("button", { name: "Preview next action" });
    assert.equal(preview.getAttribute("aria-disabled"), "true");
    fireEvent.change(args, {
      target: { value: '{"command":"hog --version"}' },
    });
    fireEvent.click(screen.getByLabelText("This call returns no text"));
    fireEvent.click(preview);
    await screen.findByText("Check the CLI version");
    assert.deepEqual(bodies, [
      {
        model: "test",
        edit: {
          entryId: "tool-npm",
          field: "arguments",
          replacement: '{"command":"hog --version"}',
          sampleResult: "",
        },
      },
    ]);
    assert.ok(screen.getByText("Inspect package.json"));
    fireEvent.click(screen.getByLabelText("This call returns no text"));
    assert.equal(preview.getAttribute("aria-disabled"), "true");
    fireEvent.click(screen.getByRole("button", { name: "Run as branch" }));
    await screen.findByText(/Pi will use the edited conversation/);
    fireEvent.click(screen.getByRole("button", { name: "Back to edit" }));
    assert.equal(
      (screen.getByLabelText("Edited arguments (JSON)") as HTMLTextAreaElement)
        .value,
      '{"command":"hog --version"}',
    );
    fireEvent.click(screen.getByRole("button", { name: "Run as branch" }));
    fireEvent.click(screen.getByRole("button", { name: "Start branch" }));
    await waitFor(() => assert.equal(started, "child"));
    assert.equal(window.location.hash, originalRoute);
    const submitted = bodies[1] as Record<string, unknown>;
    assert.equal(submitted.confirmLiveTools, true);
    assert.equal(submitted.model, "test");
    assert.deepEqual(submitted.edit, {
      entryId: "tool-npm",
      field: "arguments",
      replacement: '{"command":"hog --version"}',
    });
    assert.match(String(submitted.requestId), /^[0-9a-f-]{36}$/);
  } finally {
    cleanup();
    globalThis.fetch = restore;
  }
});
