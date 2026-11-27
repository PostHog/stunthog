import "./dom.js";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  ApplicationSettings,
  type ApplicationSettingsData,
} from "../../src/settings/domain/application-settings.js";
import { EvalEditor } from "../src/evals/EvalEditor.js";
import { SettingsPage } from "../src/settings/SettingsPage.js";

const { cleanup, fireEvent, render, screen, waitFor } = await import(
  "@testing-library/react"
);
const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test("session concurrency loads and saves from the settings page", async () => {
  let saved: unknown;

  const settings = ApplicationSettings.defaults().value;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith("/api/harnesses")) return Response.json([]);
    if (options?.method === "PUT") {
      saved = JSON.parse(String(options.body));
      return Response.json(saved);
    }

    return Response.json(settings);
  };

  render(<SettingsPage />);

  const input = (await screen.findByLabelText(
    "Concurrent agent sessions",
  )) as HTMLInputElement;

  assert.equal(input.value, "2");
  fireEvent.change(input, { target: { value: "6" } });
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  await screen.findByText(/new limit now applies/);
  assert.deepEqual(saved, { ...settings, sessionConcurrency: 6 });
});

test("saved model and judge defaults prefill new evaluations without changing existing ones", async () => {
  let settings: ApplicationSettingsData = ApplicationSettings.defaults().value;
  const resources = { environments: [], personas: [], skills: [], mcps: [] };
  const customModel = {
    harness: "pi" as const,
    model: "custom-model",
    effort: "low" as const,
    maxTurns: 100,
    timeoutSeconds: 600,
    count: 1,
  };
  const existing = {
    id: "existing",
    revision: 1,
    title: "Existing evaluation",
    prompt: "Existing task",
    criteria: [{ id: "criterion", description: "Check output" }],
    environmentId: null,
    personaId: null,
    skillIds: [],
    mcpIds: [],
    judgeSkillIds: [],
    judgeMcpIds: [],
    models: [customModel],
    judge: customModel,
  };

  globalThis.fetch = async (url, options) => {
    switch (String(url).split("?")[0]) {
      case "/api/settings":
        if (options?.method === "PUT")
          settings = JSON.parse(String(options.body));
        return Response.json(settings);
      case "/api/harnesses":
        return Response.json([
          {
            id: "pi",
            title: "Pi",
            installed: true,
            provider: "openrouter",
            supportsMcp: true,
            judgeSupportsMcp: true,
            models: [{ id: "custom-model", name: "Custom model" }],
          },
        ]);
      case "/api/resources":
        return Response.json(resources);
      case "/api/evals/existing":
        return Response.json(existing);
      default:
        throw new Error(`Unexpected request: ${url}`);
    }
  };

  const page = render(<SettingsPage />);
  await screen.findByRole("button", { name: "Remove model configuration 6" });
  for (let i = 0; i < 6; i++)
    fireEvent.click(
      screen.getByRole("button", { name: "Remove model configuration 1" }),
    );
  fireEvent.click(screen.getByRole("button", { name: "Remove judge" }));
  await waitFor(() =>
    assert.notEqual(
      screen
        .getByRole("button", { name: "Add model" })
        .getAttribute("aria-disabled"),
      "true",
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Add model" }));
  await screen.findByText("Changes apply when you save settings.");
  fireEvent.click(screen.getByRole("button", { name: /Custom model/ }));
  fireEvent.change(screen.getByLabelText("Sessions"), {
    target: { value: "3" },
  });
  fireEvent.change(screen.getByLabelText("Maximum turns"), {
    target: { value: "42" },
  });
  fireEvent.change(screen.getByLabelText("Timeout (seconds)"), {
    target: { value: "900" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply settings" }));
  assert.equal(settings.evaluationDefaults.models.length, 6);
  fireEvent.click(screen.getByRole("button", { name: "Add judge" }));
  fireEvent.click(screen.getByRole("button", { name: /Custom model/ }));
  fireEvent.click(screen.getByRole("button", { name: "Apply settings" }));
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  await screen.findByText(/Settings saved/);
  assert.deepEqual(settings.evaluationDefaults.models, [
    { ...customModel, count: 3, maxTurns: 42, timeoutSeconds: 900 },
  ]);
  assert.deepEqual(settings.evaluationDefaults.judge, customModel);
  page.unmount();

  const newEval = render(<EvalEditor />);
  await screen.findByText("3 sessions");
  assert.equal(screen.getAllByText(/42 turns · 900s timeout/).length, 1);
  fireEvent.click(
    screen.getByRole("button", { name: "Remove model configuration 1" }),
  );
  assert.equal(settings.evaluationDefaults.models.length, 1);
  newEval.unmount();
  const restoredDraft = render(<EvalEditor />);
  await screen.findByText("No sessions selected");
  restoredDraft.unmount();

  const editEval = render(<EvalEditor id={existing.id} />);
  await screen.findByDisplayValue("Existing evaluation");
  assert.equal(screen.getAllByText(/100 turns · 600s timeout/).length, 2);
  assert.equal(screen.queryByText("3 sessions"), null);
  editEval.unmount();

  settings = { ...settings, evaluationDefaults: { models: [], judge: null } };
  render(<EvalEditor />);
  await screen.findByText("No sessions selected");
  await screen.findByText("No judge selected");
});
