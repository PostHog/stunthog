import "./dom.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ApplicationSettings } from "../../src/settings/domain/application-settings.js";
import { EvalDetail } from "../src/evals/EvalDetail.js";
import { EvalEditor } from "../src/evals/EvalEditor.js";

const { cleanup, fireEvent, render, screen, waitFor } = await import(
  "@testing-library/react"
);

test("load session keeps the file and memo on error, then selects the new run", async () => {
  const original = globalThis.fetch;
  let attempts = 0;
  const fixture = evaluation();
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith("/api/evals/e?")) return Response.json(fixture);
    if (String(url).startsWith("/api/sessions?")) return Response.json([]);
    if (String(url).startsWith("/api/resources?"))
      return Response.json(resources);
    assert.equal(url, "/api/evals/e/session-file");
    assert.equal(new Headers(options?.headers).has("Content-Type"), false);
    assert.ok(options?.body instanceof FormData);
    assert.equal(options.body.get("memo"), "First installation");
    const file = options.body.get("file");
    assert.ok(file instanceof File);
    assert.equal(file.name, "session.jsonl");
    return ++attempts === 1
      ? Response.json(
          { message: "Choose another model for the judge." },
          { status: 400 },
        )
      : Response.json({ batchId: "next" });
  };
  try {
    render(<EvalDetail id={fixture.id} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Load session file" }),
    );
    const submit = screen.getByRole("button", {
      name: "Load and judge",
    }) as HTMLButtonElement;
    assert.ok(
      submit.disabled || submit.getAttribute("aria-disabled") === "true",
    );
    fireEvent.change(screen.getByLabelText("Session file"), {
      target: { files: [new File(["{}"], "session.jsonl")] },
    });
    fireEvent.change(screen.getByLabelText("Memo (optional)"), {
      target: { value: "First installation" },
    });
    assert.equal(submit.getAttribute("aria-disabled"), "false");
    assert.ok(submit.form);
    fireEvent.submit(submit.form);
    await screen.findByRole("alert");
    assert.equal(attempts, 1);
    fireEvent.submit(submit.form);
    await screen.findByText(/Organic session loaded/);
    assert.equal(attempts, 2);
  } finally {
    cleanup();
    globalThis.fetch = original;
  }
});

const resources = { skills: [], environments: [], mcps: [], personas: [] };
const model = ApplicationSettings.defaults().value.evaluationDefaults.models[0];
assert.ok(model);
function evaluation() {
  return {
    id: "e",
    revision: 1,
    title: "Install the CLI",
    prompt: "Install the CLI",
    criteria: [{ id: "criterion", description: "CLI reports its version" }],
    skillIds: [],
    mcpIds: [],
    judgeSkillIds: [],
    judgeMcpIds: [],
    judgeMcpTools: {},
    models: [model],
    judge: model,
  };
}

test("a new evaluation can stage files alongside models and save with only organic sessions", async () => {
  const oldFetch = globalThis.fetch;
  const previousUrl = window.location.href;
  const submissions: FormData[] = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith("/api/settings?"))
      return Response.json({
        evaluationDefaults: { models: [model], judge: model },
      });
    if (String(url).startsWith("/api/resources?"))
      return Response.json(resources);
    if (String(url).startsWith("/api/harnesses?")) return Response.json([]);
    assert.equal(url, "/api/evals/with-session-files");
    assert.ok(options?.body instanceof FormData);
    submissions.push(options.body);
    return submissions.length === 1
      ? Response.json({ message: "Choose a supported judge." }, { status: 400 })
      : Response.json({ id: "saved" });
  };
  try {
    render(<EvalEditor />);
    fireEvent.change(await screen.findByLabelText("Title"), {
      target: { value: "Install the CLI" },
    });
    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "Install the CLI" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add criterion" }));
    fireEvent.change(screen.getByLabelText("Acceptance criterion"), {
      target: { value: "CLI reports its version" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply criterion" }));
    fireEvent.click(screen.getByRole("button", { name: "Load session file" }));
    fireEvent.change(screen.getByLabelText("Session file"), {
      target: { files: [new File(["{}"], "cli.jsonl")] },
    });
    fireEvent.change(screen.getByLabelText("Memo (optional)"), {
      target: { value: "First installation" },
    });
    const fileForm = screen
      .getByRole("button", { name: "Add file" })
      .closest("form");
    assert.ok(fileForm);
    fireEvent.submit(fileForm);
    await screen.findByText("cli.jsonl");
    assert.equal(submissions.length, 0);
    fireEvent.click(
      screen.getByRole("button", { name: "Save and judge file" }),
    );
    await screen.findByRole("alert");
    assert.deepEqual(
      JSON.parse(String(submissions[0]?.get("evaluation"))).models,
      [model],
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Remove model configuration 1" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Save and judge file" }),
    );
    await waitFor(() => assert.equal(window.location.hash, "#evals/saved"));
    assert.deepEqual(
      JSON.parse(String(submissions[1]?.get("evaluation"))).models,
      [],
    );
    assert.deepEqual(JSON.parse(String(submissions[1]?.get("memos"))), [
      "First installation",
    ]);
    assert.equal((submissions[1]?.get("files") as File).name, "cli.jsonl");
  } finally {
    cleanup();
    globalThis.fetch = oldFetch;
    window.history.replaceState(null, "", previousUrl);
  }
});

test("the evaluation session list shows both sources across runs", async () => {
  const oldFetch = globalThis.fetch;
  const fixture = evaluation();
  const session = {
    model: "gpt",
    harness: "codex",
    status: "completed",
    createdAt: new Date().toISOString(),
    eval: { title: fixture.title },
    evalId: "e",
    snapshot: { evaluation: fixture, environment: null, skills: [], mcps: [] },
    decisions: [],
    interceptedCalls: 0,
    agentResult: null,
    judgeResult: null,
    durationMs: null,
    costUsd: null,
  };
  globalThis.fetch = async (url) => {
    if (String(url).startsWith("/api/evals/e?")) return Response.json(fixture);
    if (String(url).startsWith("/api/sessions?"))
      return Response.json([
        {
          ...session,
          id: "one",
          batchId: "batch1",
          origin: "organic",
          memo: "CLI installation",
        },
        { ...session, id: "two", batchId: "batch2", origin: "synthetic" },
      ]);
    return Response.json(resources);
  };
  try {
    render(<EvalDetail id={fixture.id} />);
    await screen.findByText("Organic", { exact: true });
    await screen.findByText("Synthetic", { exact: true });
    const toggle = screen.getByRole("checkbox", { name: "Selected run only" });
    fireEvent.click(toggle);
    await waitFor(() =>
      assert.equal(screen.queryByText("Synthetic", { exact: true }), null),
    );
    fireEvent.click(toggle);
    await screen.findByText("Synthetic", { exact: true });
  } finally {
    cleanup();
    globalThis.fetch = oldFetch;
  }
});
