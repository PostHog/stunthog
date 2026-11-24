import type { ResponseRule } from "../../../src/overrides/domain/response-override.js";

export function ResponseOverrideList({
  rules = [],
  servers = [],
  title = "Response overrides",
}: {
  rules?: ResponseRule[] | undefined;
  servers?: { id?: string; title: string }[] | undefined;
  title?: string;
}) {
  return (
    <section className="report-overrides">
      <h2>
        {title} <span className="muted">({rules.length})</span>
      </h2>
      {rules.length === 0 ? (
        <p className="muted">No response overrides.</p>
      ) : (
        <ol>
          {rules.map((rule, i) => {
            const target = rule.target;
            const destination =
              target.kind === "web"
                ? (target.url ?? "All web fetches")
                : target.kind === "shell"
                  ? rule.decision
                    ? "Shell calls"
                    : target.command
                  : [
                      servers.find((server) => server.id === target.serverId)
                        ?.title ?? target.serverId,
                      target.tool ?? "All tools",
                    ].join(" · ");
            return (
              <li key={rule.id}>
                <details>
                  <summary>
                    <strong>
                      {i + 1}. {destination}
                    </strong>
                    <small>
                      <code>{rule.find}</code>
                      <span role="img" aria-label="replaced with">
                        →
                      </span>
                      <code>{rule.replacement || "Delete match"}</code>
                    </small>
                  </summary>
                  <dl>
                    {rule.decision && (
                      <>
                        <dt>Jev match condition</dt>
                        <dd>{rule.decision.prompt}</dd>
                      </>
                    )}
                    <dt>
                      {rule.mode === "regex"
                        ? "Regular expression"
                        : "Find text"}
                    </dt>
                    <dd>
                      <code>{rule.find}</code>
                    </dd>
                    <dt>Replacement</dt>
                    <dd>
                      <code>{rule.replacement || "Delete match"}</code>
                    </dd>
                    {!rule.decision && rule.inputContains && (
                      <>
                        <dt>Call input contains</dt>
                        <dd>{!rule.decision && rule.inputContains}</dd>
                      </>
                    )}
                    {!rule.decision && rule.outputContains && (
                      <>
                        <dt>Response contains</dt>
                        <dd>{!rule.decision && rule.outputContains}</dd>
                      </>
                    )}
                    {rule.path && (
                      <>
                        <dt>JSON field</dt>
                        <dd>
                          <code>{rule.path}</code>
                        </dd>
                      </>
                    )}
                  </dl>
                </details>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
