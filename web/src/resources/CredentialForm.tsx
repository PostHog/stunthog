import { Button, Input } from "@posthog/quill";
import { type FormEvent, useState } from "react";
import { api } from "../api.js";
import { Field, Notice } from "../components.js";
import { Dialog } from "../Dialog.js";
import type { Credential } from "../types.js";
import { providerInfo } from "./provider-info.js";

export function CredentialForm({
  credential,
  remove = false,
  onSaved,
  onClose,
}: {
  credential: Credential;
  remove?: boolean;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const provider = providerInfo[credential.provider];
  const name = provider?.name ?? credential.provider;
  const action = remove ? "Remove saved key" : "Save key";

  async function submit(event: FormEvent) {
    event.preventDefault();

    if (busy || (!remove && !value.trim())) return;

    setBusy(true);
    setError("");

    try {
      await api(
        `/credentials/${credential.provider}`,
        remove
          ? { method: "DELETE" }
          : { method: "PUT", body: JSON.stringify({ key: value.trim() }) },
      );

      setValue("");
      onSaved();
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={`${remove ? "Remove" : credential.source === "environment" ? "Override" : credential.configured ? "Replace" : "Add"} ${name} key`}
      onClose={onClose}
      busy={busy}
    >
      <form onSubmit={submit}>
        <p className="muted">
          {remove
            ? `Remove the saved ${name} key from this app? StuntHog will use the environment key if you set one.`
            : `StuntHog uses this key for ${provider?.harnesses ?? name}.`}
        </p>
        {!remove && (
          <>
            {credential.source === "environment" && (
              <p className="info-note">
                A key is already loaded from <code>{provider?.variable}</code>.
                Saving a key here takes priority. Your environment file will not
                change.
              </p>
            )}
            <Field label={`${name} API key`}>
              <Input
                required
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                disabled={busy}
                value={value}
                placeholder="Paste your API key"
                onChange={(event) => setValue(event.target.value)}
              />
            </Field>
            <p className="section-note">
              The key is encrypted and stored locally. Saved keys are never
              displayed.
            </p>
          </>
        )}
        <Notice error={error} />
        <footer className="dialog-actions">
          <Button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant={remove ? "destructive" : "primary"}
            loading={busy}
            disabled={!remove && !value.trim()}
          >
            {action}
          </Button>
        </footer>
      </form>
    </Dialog>
  );
}
