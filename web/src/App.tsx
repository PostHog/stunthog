import { Badge } from "@posthog/quill";
import { type ReactNode, useEffect, useState } from "react";
import { EvalDetail } from "./evals/EvalDetail.js";
import { EvalEditor } from "./evals/EvalEditor.js";
import { EvalList } from "./evals/EvalList.js";
import { ModelCatalog } from "./models/ModelReference.js";
import { CredentialsPage } from "./resources/CredentialsPage.js";
import { HarnessesPage } from "./resources/HarnessesPage.js";
import { ResourcePage } from "./resources/ResourcePage.js";
import { navigationGroups, Sidebar } from "./Sidebar.js";
import { SessionDetail } from "./sessions/SessionDetail.js";
import { SessionList } from "./sessions/SessionList.js";
import { SettingsPage } from "./settings/SettingsPage.js";

export function App() {
  const [route, setRoute] = useState(location.hash.slice(1) || "evals");

  useEffect(() => {
    const change = () => setRoute(location.hash.slice(1) || "evals");
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);

  const [page, id, action] = route.split("?")[0]?.split("/") ?? [];
  let content: ReactNode;

  if (page === "evals")
    content =
      id === "new" ? (
        <EvalEditor />
      ) : id && action === "edit" ? (
        <EvalEditor id={id} />
      ) : id ? (
        <EvalDetail id={id} />
      ) : (
        <EvalList />
      );
  else if (page === "sessions")
    content = id ? (
      <SessionDetail
        id={id}
        branch={new URLSearchParams(route.split("?")[1]).get("branch")}
      />
    ) : (
      <SessionList />
    );
  else if (page === "credentials") content = <CredentialsPage />;
  else if (page === "harnesses") content = <HarnessesPage />;
  else if (page === "settings") content = <SettingsPage />;
  else if (["environments", "skills", "personas", "mcps"].includes(page ?? ""))
    content = (
      <ResourcePage
        key={page}
        kind={page as "environments" | "skills" | "personas" | "mcps"}
      />
    );
  else
    content = (
      <p>
        Page not found. <a href="#evals">Return to evaluations</a>.
      </p>
    );

  return (
    <ModelCatalog>
      <div className="app">
        <Sidebar page={page} />
        <div
          className={
            page === "sessions" && id
              ? "main-shell session-shell"
              : "main-shell"
          }
        >
          <header className="topbar">
            <a className="breadcrumb-link" href="#evals">
              StuntHog
            </a>{" "}
            <span>/</span>{" "}
            {navigationGroups
              .flatMap((group) => group.links)
              .find(([path]) => path === page)?.[1] ?? "Report"}
            <Badge variant="info" className="ml-auto">
              Local
            </Badge>
          </header>
          <main key={route}>{content}</main>
        </div>
      </div>
    </ModelCatalog>
  );
}
