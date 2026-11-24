import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@posthog/quill";
import { useState } from "react";
import { useApi } from "../api.js";
import { Notice, PageTitle } from "../components.js";
import { Feedback, RequestState } from "../PageState.js";
import type { Credential } from "../types.js";
import { CredentialForm } from "./CredentialForm.js";
import { CredentialRow } from "./CredentialRow.js";
import { providerInfo } from "./provider-info.js";

export function CredentialsPage() {
  const { data, error, refresh } = useApi<Credential[]>("/credentials");
  const [message, setMessage] = useState("");
  const [editing, setEditing] = useState<{
    credential: Credential;
    remove: boolean;
  }>();

  return (
    <>
      <PageTitle title="API keys">
        <Button
          nativeButton={false}
          variant="outline"
          render={<a href="#harnesses">Check harnesses</a>}
        />
      </PageTitle>
      <p className="description">
        Add keys for the providers you use in sessions and response overrides.
      </p>
      <Feedback message={message} />
      {data ? (
        <Notice error={error} />
      ) : (
        <RequestState error={error} retry={refresh} />
      )}
      <div className="credentials">
        {data && (
          <div className="credentials-heading" aria-hidden="true">
            <span>Provider / use</span>
            <span>Key source</span>
            <span>Actions</span>
          </div>
        )}
        {data?.map((credential) => (
          <CredentialRow
            key={credential.provider}
            credential={credential}
            onEdit={() => {
              setMessage("");
              setEditing({ credential, remove: false });
            }}
            onRemove={() => {
              setMessage("");
              setEditing({ credential, remove: true });
            }}
          />
        ))}
      </div>
      {editing && (
        <CredentialForm
          credential={editing.credential}
          remove={editing.remove}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setMessage(
              `${providerInfo[editing.credential.provider]?.name ?? editing.credential.provider} ${editing.remove ? "saved key removed" : "key saved"}.`,
            );
            setEditing(undefined);
            refresh();
          }}
        />
      )}
      <p className="section-note">
        A saved key takes priority over the provider’s environment variable.
        Remove the saved key to use the environment variable again.
      </p>
      <Collapsible className="credential-storage">
        <CollapsibleTrigger>How keys are stored</CollapsibleTrigger>
        <CollapsibleContent>
          <p className="section-note">
            StuntHog encrypts provider keys and stores them in SQLite. The local
            data directory contains the encryption key. Make a backup of both
            files together. The server reads provider keys from its environment
            or its .env file. Restart the server if you change those values.
          </p>
        </CollapsibleContent>
      </Collapsible>
    </>
  );
}
