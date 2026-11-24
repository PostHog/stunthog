import { Badge, Button } from "@posthog/quill";
import type { Credential } from "../types.js";
import { providerInfo } from "./provider-info.js";

export function CredentialRow({
  credential,
  onEdit,
  onRemove,
}: {
  credential: Credential;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const provider = providerInfo[credential.provider];
  const saved = credential.source === "database";
  const environment = credential.source === "environment";

  return (
    <section
      className="credential-row"
      aria-label={provider?.name ?? credential.provider}
    >
      <div className="credential-provider">
        <h2>{provider?.name ?? credential.provider}</h2>
        <p>Used by {provider?.harnesses ?? credential.provider}</p>
      </div>
      <div className="credential-source">
        <Badge variant={saved ? "success" : environment ? "info" : "default"}>
          {saved
            ? "Saved locally"
            : environment
              ? "From environment"
              : "Not configured"}
        </Badge>
        <p>
          {saved ? (
            "Stored key is hidden and encrypted."
          ) : environment ? (
            <code>{provider?.variable}</code>
          ) : (
            "Add an API key to use this provider."
          )}
        </p>
      </div>
      <div className="actions credential-actions">
        <Button
          variant={credential.configured ? "outline" : "primary"}
          onClick={onEdit}
        >
          {saved ? "Replace key" : environment ? "Override key" : "Add key"}
        </Button>
        {saved && (
          <Button variant="destructive-outline" onClick={onRemove}>
            Remove
          </Button>
        )}
      </div>
    </section>
  );
}
