import "./dom.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { EditorView } from "@uiw/react-codemirror";
import {
  type ResponseRule,
  rewriteResponse,
} from "../../src/overrides/domain/response-override.js";
import { OverrideDialog } from "../src/overrides/OverrideDialog.js";

const { act, cleanup, fireEvent, render, screen, waitFor } = await import(
  "@testing-library/react"
);

function responseEditor(label: string) {
  const editor = EditorView.findFromDOM(
    screen.getByRole("textbox", { name: label }),
  );
  assert.ok(editor);
  return editor;
}

function editResponse(text: string) {
  const editor = responseEditor("Response for the agent");
  act(() =>
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: text },
    }),
  );
}

test("the inline Bash editor saves one command from a batch and previews its combined output", async () => {
  const previous = globalThis.fetch;
  const command = "grep posthog package.json";
  const batch = `npm install posthog-js 2>&1 | tail -5; ${command}`;
  const original = 'Installed packages\n"posthog-js": "^1.453.0"';
  const edited = original.replace("^1.453.0", "1.453.0");
  let saved: ResponseRule | undefined;
  try {
    globalThis.fetch = (async (_path, opts) => {
      const body = JSON.parse(String(opts?.body));
      return Response.json(
        await rewriteResponse([body.rule], body, body.original),
      );
    }) as typeof fetch;
    render(
      <OverrideDialog
        inline
        sample={{
          target: { kind: "shell", match: "batch", command: batch },
          args: { command: batch },
          callId: "bash-1",
          original,
          route: "Bash",
        }}
        servers={[]}
        evaluationTitle="Install PostHog"
        applyLabel="Save to evaluation"
        onApply={(rule) => {
          saved = rule;
        }}
        onClose={() => {}}
      />,
    );
    assert.equal(screen.queryByRole("dialog"), null);
    assert.equal(
      (
        screen.getByRole("radio", {
          name: "npm install posthog-js",
        }) as HTMLInputElement
      ).checked,
      true,
    );
    screen.getByRole("radio", { name: "tail -5" });
    fireEvent.click(screen.getByRole("radio", { name: "Entire call" }));
    fireEvent.click(screen.getByRole("radio", { name: command }));
    assert.equal(
      responseEditor("Original response").state.doc.toString(),
      original,
    );
    editResponse(edited);
    await screen.findByText("The rule changes this sample.");
    fireEvent.click(screen.getByRole("button", { name: "Save to evaluation" }));
    await waitFor(() => assert.ok(saved));
    assert.ok(saved);
    assert.deepEqual(saved.target, {
      kind: "shell",
      match: "command",
      command,
    });
    const nextResponse = async (next: string) =>
      (
        await rewriteResponse(
          [saved as ResponseRule],
          {
            target: { kind: "shell", match: "batch", command: next },
            args: { command: next },
          },
          original,
        )
      ).value;
    assert.equal(await nextResponse(`ls && ${command}`), edited);
    assert.equal(await nextResponse("grep version package.json"), original);
  } finally {
    cleanup();
    globalThis.fetch = previous;
  }
});

test("the call browser shows session context and applies a rule to the selected web response", async () => {
  const originalFetch = globalThis.fetch;
  const sample = {
    id: 1,
    name: "web_fetch",
    evaluation: "Sample install",
    phase: "agent",
    harness: "pi",
    status: "completed",
    hasOutput: 1,
    sessionId: "s",
    tool: "web_fetch",
    model: "fixture-model",
    createdAt: "2026-11-18T12:00:00Z",
    inputPreview: "https://example.com",
    outputPreview: "install old-sdk",
    output: "install old-sdk",
    target: { kind: "web", url: "https://example.com" },
    input: { url: "https://example.com" },
    sample: "install old-sdk",
  };
  let applied: ResponseRule | undefined;
  try {
    globalThis.fetch = (async (path, opts) => {
      if (String(path).endsWith("/search"))
        return Response.json({ calls: [sample], next: null });
      if (String(path).endsWith("/1")) return Response.json(sample);
      const req = JSON.parse(String(opts?.body));
      return Response.json(
        await rewriteResponse([req.rule], req, req.original),
      );
    }) as typeof fetch;
    render(
      <form onSubmit={() => assert.fail("The evaluation must not submit")}>
        <OverrideDialog
          servers={[]}
          onCreateServer={() => {}}
          onClose={() => {}}
          onApply={(rule) => {
            applied = rule;
          }}
        />
      </form>,
    );
    await screen.findByRole("button", {
      name: /web_fetch.*https:.*old-sdk.*Sample install/,
    });
    assert.equal(
      (await screen.findByRole("link", { name: "Open session" })).getAttribute(
        "href",
      ),
      "#sessions/s",
    );
    assert.equal(
      screen.queryByRole("button", { name: "Apply override" }),
      null,
    );
    fireEvent.click(screen.getByRole("button", { name: "Use this call" }));
    assert.equal(
      responseEditor("Original response").state.doc.toString(),
      sample.sample,
    );
    assert.equal(
      responseEditor("Response for the agent").state.doc.toString(),
      sample.sample,
    );
    assert.equal(screen.queryByLabelText("Find in the response"), null);
    assert.equal(
      screen.getByText("https://example.com", {
        selector: ".override-scope summary span",
      }).textContent,
      sample.target.url,
    );
    editResponse("install new-sdk");
    await screen.findByText("The rule changes this sample.");
    assert.equal(document.querySelector(".diff-add")?.textContent, "new");
    assert.equal(document.querySelector(".diff-remove")?.textContent, "old");
    fireEvent.click(screen.getByRole("button", { name: "Apply override" }));
    await waitFor(() => assert.equal(applied?.replacement, "install new-sdk"));
    fireEvent.click(screen.getByRole("tab", { name: "Find and replace" }));
    assert.equal(
      (screen.getByLabelText("Find in the response") as HTMLTextAreaElement)
        .value,
      sample.sample,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Regular expression" }));
    await screen.findByRole("textbox", { name: "Find pattern" });
  } finally {
    cleanup();
    globalThis.fetch = originalFetch;
  }
});

test("a Bash sample seeds both edit fields and previews before the author chooses a destination", async () => {
  const previous = globalThis.fetch;
  const manifest = JSON.stringify(
    { name: "workspace", version: "1.0.0" },
    null,
    2,
  );
  const shell = {
    id: 3,
    name: "bash",
    tool: "bash",
    phase: "agent",
    status: "completed",
    evaluation: "Setup",
    sessionId: "native",
    harness: "pi",
    model: "local",
    createdAt: "2026-11-18T12:00:00Z",
    hasOutput: 1,
    input: { command: "cat package.json" },
    inputPreview: "cat package.json",
    outputPreview: manifest,
    output: manifest,
    sample: manifest,
  };
  let applied = false;
  try {
    globalThis.fetch = (async (path, opts) => {
      if (String(path).endsWith("/search"))
        return Response.json({ calls: [shell], next: null });
      if (String(path).endsWith("/3")) return Response.json(shell);
      const body = JSON.parse(String(opts?.body));
      return Response.json(
        await rewriteResponse([body.rule], body, body.original),
      );
    }) as typeof fetch;
    render(
      <OverrideDialog
        servers={[]}
        onCreateServer={() => {}}
        onApply={() => {
          applied = true;
        }}
        onClose={() => {}}
      />,
    );
    await screen.findByText(/Use this output as a sample/);
    fireEvent.click(screen.getByRole("button", { name: "Use as sample" }));
    assert.equal(
      responseEditor("Original response").state.doc.toString(),
      manifest,
    );
    assert.equal(
      responseEditor("Response for the agent").state.doc.toString(),
      manifest,
    );
    editResponse(manifest.replace("workspace", "my-project"));
    await screen.findByText("The rule changes this sample.");
    assert.ok(document.querySelector(".diff-add")?.textContent?.includes("my"));
    assert.equal(
      screen
        .getByRole("button", { name: "Apply override" })
        .getAttribute("aria-disabled"),
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Apply override" }));
    assert.equal(applied, false);
    fireEvent.click(screen.getByText("Choose a destination"));
    fireEvent.click(screen.getByRole("tab", { name: "MCP tool" }));
    screen.getByRole("button", { name: "Add MCP server" });
    fireEvent.click(screen.getByRole("tab", { name: "Web fetch" }));
    fireEvent.click(screen.getByRole("button", { name: "Change sample" }));
    await screen.findByText(/Use this output as a sample/);
    fireEvent.click(screen.getByRole("button", { name: "Use as sample" }));
    assert.equal(
      (screen.getByLabelText("Replace each match with") as HTMLTextAreaElement)
        .value,
      '  "name": "my-project",',
    );
    assert.equal(
      (screen.getByLabelText("Find in the response") as HTMLTextAreaElement)
        .value,
      '  "name": "workspace",',
    );
    fireEvent.click(screen.getByRole("button", { name: "Apply override" }));
    await waitFor(() => assert.equal(applied, true));
  } finally {
    cleanup();
    globalThis.fetch = previous;
  }
});

test("direct edits to a structured MCP response keep the tool and field from the recorded call", async () => {
  const previous = globalThis.fetch;
  const target = {
    kind: "mcp",
    serverId: crypto.randomUUID(),
    tool: "read_docs",
  } as const;
  const original = {
    structuredContent: { setup: "npm install sdk\r\nstart()" },
  };
  let applied: ResponseRule | undefined;
  try {
    globalThis.fetch = (async (url, options) => {
      if (String(url).endsWith("/tools")) return Response.json(["read_docs"]);
      const body = JSON.parse(String(options?.body));
      return Response.json(
        await rewriteResponse([body.rule], body, body.original),
      );
    }) as typeof fetch;
    render(
      <OverrideDialog
        servers={[{ id: target.serverId, title: "Docs" }]}
        sample={{ target, args: {}, original, callId: "a", route: "read_docs" }}
        onClose={() => {}}
        onApply={(rule) => {
          applied = rule;
        }}
      />,
    );
    assert.equal(
      responseEditor("Response for the agent").state.doc.toString(),
      "npm install sdk\nstart()",
    );
    editResponse("bun add sdk\nstart()");
    await screen.findByText("The rule changes this sample.");
    fireEvent.click(screen.getByRole("button", { name: "Apply override" }));
    const saved = await waitFor(() => {
      assert.ok(applied);
      return applied;
    });
    assert.equal(saved.path, "/setup");
    assert.deepEqual(saved.target, target);
    assert.deepEqual(
      (await rewriteResponse([saved], { target, args: {} }, original)).value,
      { structuredContent: { setup: "bun add sdk\r\nstart()" } },
    );
  } finally {
    cleanup();
    globalThis.fetch = previous;
  }
});

test("a model override previews only on request and saves the match condition", async () => {
  const old = globalThis.fetch;
  let requests = 0;
  let saved: ResponseRule | undefined;
  try {
    globalThis.fetch = (async (_url, options) => {
      requests++;
      const { rule } = JSON.parse(String(options?.body));
      return Response.json({
        value: "Run setup next.",
        ruleId: rule.id,
        decisions: [{ ruleId: rule.id, model: "jev-test", probability: 0.98 }],
      });
    }) as typeof fetch;
    render(
      <OverrideDialog
        inline
        servers={[]}
        sample={{
          target: {
            kind: "shell",
            match: "batch",
            command: "npm install other posthog-js",
          },
          args: { command: "npm install other posthog-js" },
          callId: "sample",
          route: "Bash",
          original: "Done.",
        }}
        onApply={(rule) => {
          saved = rule;
        }}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Decision model" }));
    fireEvent.change(screen.getByLabelText("When should Jev match a call?"), {
      target: { value: "The command installs posthog-js." },
    });
    editResponse("Run setup next.");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 240));
    });
    assert.equal(requests, 0);
    fireEvent.click(screen.getByRole("button", { name: "Preview with model" }));
    await screen.findByText(/98% match probability/);
    fireEvent.click(screen.getByRole("button", { name: "Apply override" }));
    await waitFor(() =>
      assert.equal(saved?.decision?.prompt, "The command installs posthog-js."),
    );
    assert.equal(requests, 1);
  } finally {
    cleanup();
    globalThis.fetch = old;
  }
});
