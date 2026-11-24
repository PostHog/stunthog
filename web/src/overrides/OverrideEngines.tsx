import { Tabs, TabsList, TabsTrigger, Textarea } from "@posthog/quill";
import { useRef } from "react";
import type { ResponseRule } from "../../../src/overrides/domain/response-override.js";
import { Field } from "../components.js";

type Engines = Pick<ResponseRule, "decision">;

export function OverrideEngines({
  decision,
  change,
}: Engines & { change: (patch: Partial<Engines>) => void }) {
  const lastDecision = useRef(decision ?? { prompt: "" });

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
    </div>
  );
}
