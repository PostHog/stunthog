import type { Session } from "../types.js";
import { isActive } from "./session-filters.js";
import type { TranscriptEntry } from "./transcript/types.js";

const outcomes = {
  observed: "Observed influence",
  no_observed_effect: "No observed effect",
  uncertain: "Insufficient evidence",
};

export function ModelBehaviorDrift({
  session,
  entries,
  onInspect,
  onEvidence,
}: {
  session: Session;
  entries: TranscriptEntry[];
  onInspect: (callId: string) => void;
  onEvidence?: (entryId: string) => void;
}) {
  const findings = session.behaviorDrift ?? [];
  const rules = session.snapshot.evaluation.responseOverrides ?? [];
  const calls = new Map(
    entries
      .filter((entry) => entry.capture?.ruleId)
      .map((entry) => [entry.capture?.callId, entry]),
  );
  return (
    <section className="session-drift" aria-label="Model behavior drift">
      <h2>Model behavior drift</h2>
      {findings.length ? (
        <ul>
          {findings.map(({ callId, outcome, explanation, evidenceQuotes }) => {
            const entry = calls.get(callId);
            const index = rules.findIndex(
              (rule) => rule.id === entry?.capture?.ruleId,
            );
            const rule = rules[index];
            const later = entry
              ? entries.slice(entries.indexOf(entry) + 1)
              : [];
            const quotes =
              evidenceQuotes ??
              Array.from(
                explanation.matchAll(/["“`]([^"”`]{4,600})["”`]/g),
                (match) => match[1] ?? "",
              );
            const cited = new Set<TranscriptEntry>();
            for (const quote of quotes) {
              const matches = later.filter((row) => row.text.includes(quote));
              if (matches.length === 1 && matches[0]) cited.add(matches[0]);
            }
            return (
              <li key={callId}>
                <strong>{outcomes[outcome]}</strong>
                {entry ? (
                  <button
                    type="button"
                    className="drift-trace-link"
                    onClick={() => onInspect(callId)}
                  >
                    {entry.title} · Trace #{entry.sequence}
                  </button>
                ) : (
                  <small>Call {callId}</small>
                )}
                {entry && <code title={entry.text}>{entry.text}</code>}
                {rule && (
                  <small>
                    Rule {index + 1} ·{" "}
                    {rule.decision?.prompt ??
                      rule.llmEdit?.prompt ??
                      `${rule.find} → ${rule.replacement || "Delete match"}`}
                  </small>
                )}
                <p>{explanation}</p>
                {onEvidence &&
                  [...cited].map((row) => (
                    <button
                      key={row.id}
                      type="button"
                      className="drift-trace-link"
                      onClick={() => onEvidence(row.id)}
                    >
                      Evidence · {row.title || row.kind} · Trace #{row.sequence}
                    </button>
                  ))}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="muted">
          {isActive(session)
            ? "The judge checks edited responses after the agent finishes."
            : session.interceptedCalls
              ? "This session has no drift assessment."
              : "No tool responses changed."}
        </p>
      )}
    </section>
  );
}
