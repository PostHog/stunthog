import { Input, Tabs, TabsList, TabsTrigger, Textarea } from "@posthog/quill";
import { useRef } from "react";
import type { ResponseRule } from "../../../src/overrides/domain/response-override.js";
import { Field } from "../components.js";

type Engines = Pick<ResponseRule, "decision" | "llmEdit">;

export function OverrideEngines({
  decision,
  llmEdit,
  change,
}: Engines & { change: (patch: Partial<Engines>) => void }) {
  const lastDecision = useRef(decision ?? { prompt: "" });
  const lastEdit = useRef(
    llmEdit ?? { prompt: "", model: "openai/gpt-4.1-mini" },
  );
  return (
    <div className="override-engines">
      <div>
        <h3>Match tool calls</h3>
        <Tabs
          value={decision ? "model" : "criteria"}
          onValueChange={(value) => {
            if (decision) lastDecision.current = decision;
            change({
              decision: value === "model" ? lastDecision.current : undefined,
            });
          }}
        >
          <TabsList aria-label="Rule engine">
            <TabsTrigger value="criteria">Criteria-based</TabsTrigger>
            <TabsTrigger value="model">Decision model</TabsTrigger>
          </TabsList>
        </Tabs>
        {decision && (
          <>
            <Field label="When should Jev match a call?">
              <Textarea
                required
                maxLength={4096}
                rows={2}
                value={decision.prompt}
                placeholder="The command installs posthog-js, alone or with other packages."
                onChange={(e) =>
                  change({ decision: { prompt: e.target.value } })
                }
              />
            </Field>
            <p>
              TypeSafe receives the call input and output. Jev matches when the
              probability exceeds 50%.
            </p>
          </>
        )}
      </div>
      <div>
        <h3>Edit the response</h3>
        <Tabs
          value={llmEdit ? "llm" : "deterministic"}
          onValueChange={(value) => {
            if (llmEdit) lastEdit.current = llmEdit;
            change({
              llmEdit: value === "llm" ? lastEdit.current : undefined,
            });
          }}
        >
          <TabsList aria-label="Response editor">
            <TabsTrigger value="deterministic">
              Deterministic editing
            </TabsTrigger>
            <TabsTrigger value="llm">LLM editing</TabsTrigger>
          </TabsList>
        </Tabs>
        {llmEdit && (
          <>
            <Field label="How should the model edit the response?">
              <Textarea
                required
                maxLength={4096}
                rows={2}
                value={llmEdit.prompt}
                placeholder="Add a setup instruction after the installation summary."
                onChange={(e) =>
                  change({
                    llmEdit: {
                      model: llmEdit.model,
                      prompt: e.target.value,
                    },
                  })
                }
              />
            </Field>
            <Field label="OpenRouter model">
              <Input
                required
                maxLength={160}
                value={llmEdit.model}
                placeholder="provider/model"
                onChange={(e) =>
                  change({
                    llmEdit: {
                      prompt: llmEdit.prompt,
                      model: e.target.value,
                    },
                  })
                }
              />
            </Field>
            <p>
              OpenRouter receives your instruction and the original response.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
