import { Button, Input } from "@posthog/quill";
import { useId, useRef, useState } from "react";
import type { Harness } from "../types.js";
import { searchModels } from "./model-search.js";

export function ModelSelect({
  harness,
  value,
  onChange,
}: {
  harness?: Pick<Harness, "models">;
  value: string;
  onChange: (model: string) => void;
}) {
  const id = useId();
  const results = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState("");
  const models = searchModels(harness?.models ?? [], query);
  const selected = harness?.models.find((model) => model.id === value);

  return (
    <div className="model-search">
      <label htmlFor={id}>Search models</label>
      <Input
        id={id}
        type="search"
        placeholder="Search by name or model ID"
        autoComplete="off"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;

          if (event.key === "Enter") {
            event.preventDefault();

            if (models[0]) onChange(models[0].id);
          }

          if (event.key === "ArrowDown") {
            event.preventDefault();
            results.current?.querySelector("button")?.focus();
          }
        }}
      />
      <output className="model-result-count">
        {models.length} models ·{" "}
        {value ? `Selected: ${selected?.name ?? value}` : "Choose one model"}
      </output>
      <ul className="model-results" ref={results} aria-label="Available models">
        {models.map((model) => (
          <li key={model.id}>
            <Button
              type="button"
              aria-pressed={model.id === value}
              onClick={() => onChange(model.id)}
            >
              <span>
                <strong>{model.name}</strong>
                <code>{model.id}</code>
              </span>
              {model.id === value && <span>Selected</span>}
            </Button>
          </li>
        ))}
      </ul>
      {models.length === 0 && (
        <p className="muted">
          {harness?.models.length
            ? "No matches. Try another model name or ID."
            : "No models available. Check the harness setup and API key."}
        </p>
      )}
    </div>
  );
}
