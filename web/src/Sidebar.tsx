import { Button } from "@posthog/quill";
import stuntHedgehog from "../../images/posthog-hedgehog-evel.png";
import { useApi } from "./api.js";

type ProviderCredit = {
  provider: "openrouter" | "openai" | "anthropic" | "typesafe";
  balanceUsd: number | null;
  status: "available" | "not_configured" | "unsupported" | "unavailable";
  detail: string;
};

const providerNames = {
  openrouter: "OpenRouter",
  openai: "OpenAI",
  anthropic: "Anthropic",
  typesafe: "TypeSafe",
};

export const navigationGroups: { title: string; links: [string, string][] }[] =
  [
    {
      title: "Workspace",
      links: [
        ["evals", "Evaluations"],
        ["sessions", "Agent sessions"],
      ],
    },
    {
      title: "Resources",
      links: [
        ["environments", "Environments"],
        ["skills", "Skills"],
        ["personas", "Personas"],
        ["mcps", "MCP servers"],
      ],
    },
    {
      title: "Settings",
      links: [
        ["settings", "General"],
        ["harnesses", "Harnesses"],
        ["credentials", "API keys"],
      ],
    },
  ];

export function Sidebar({ page }: { page?: string }) {
  const credits = useApi<ProviderCredit[]>("/provider-credits");

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <a className="brand" href="#evals">
          <img src={stuntHedgehog} alt="" width="60" height="60" />
          <span>StuntHog</span>
        </a>
        <Button
          variant="primary"
          className="sidebar-create"
          render={
            <a href="#evals/new">
              <span aria-hidden="true">+</span> New evaluation
            </a>
          }
        />
      </div>
      <nav aria-label="Main navigation" className="sidebar-navigation">
        {navigationGroups.map((group) => (
          <section
            key={group.title}
            aria-label={group.title}
            className="nav-group"
          >
            <h2>{group.title}</h2>
            <ul>
              {group.links.map(([path, title]) => (
                <li key={path}>
                  <a
                    href={`#${path}`}
                    aria-current={page === path ? "page" : undefined}
                  >
                    <span
                      className="nav-icon"
                      aria-hidden="true"
                      style={{ maskImage: `url(/brand/${path}.svg)` }}
                    />
                    {title}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </nav>
      <footer className="sidebar-footer">
        <section className="provider-credits" aria-label="Provider credits">
          <header>
            <strong>Provider credits</strong>
            <button
              type="button"
              onClick={credits.refresh}
              aria-label="Refresh credits"
            >
              ↻
            </button>
          </header>
          {credits.data?.map((credit) => (
            <div key={credit.provider} title={credit.detail}>
              <span>{providerNames[credit.provider]}</span>
              <strong
                className={credit.status === "available" ? "pass" : "muted"}
              >
                {credit.balanceUsd === null
                  ? credit.status === "not_configured"
                    ? "Not set"
                    : "Unavailable"
                  : credit.balanceUsd.toLocaleString(undefined, {
                      style: "currency",
                      currency: "USD",
                    })}
              </strong>
            </div>
          ))}
          {credits.loading && !credits.data ? (
            <span className="muted">Checking…</span>
          ) : null}
        </section>
        <div className="workspace-note">
          <img src="/brand/research.svg" alt="" width="44" height="44" />
          <p>
            <strong>Local workspace</strong>
            <span>Saved on this computer</span>
          </p>
        </div>
        <img
          className="sidebar-posthog"
          src="/brand/posthog-logo-white.svg"
          alt="PostHog"
          width="92"
          height="17"
        />
      </footer>
    </aside>
  );
}
