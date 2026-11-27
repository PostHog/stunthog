import { Button, Input, Textarea } from "@posthog/quill";
import { type FormEvent, useId, useState } from "react";
import {
  maxSessionFileBytes,
  maxSessionFileMiB,
  maxSessionMemoLength,
} from "../../../src/sessions/domain/session-file.js";
import { Field, Notice } from "../components.js";
import { Dialog } from "../Dialog.js";
import { StatusIcon } from "../status/StatusIcon.js";

export interface PendingSessionFile {
  id: string;
  file: File;
  memo: string;
}

export function LoadSessionDialog({
  onClose,
  onLoad,
  stage = false,
}: {
  onClose: () => void;
  onLoad: (entry: PendingSessionFile) => void | Promise<void>;
  stage?: boolean;
}) {
  const fileHelp = useId();
  const [file, setFile] = useState<File>();
  const [memo, setMemo] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function load(event: FormEvent) {
    event.preventDefault();
    if (!file || busy) return;
    setBusy(true);
    setError("");
    try {
      await onLoad({ id: crypto.randomUUID(), file, memo: memo.trim() });
    } catch (error) {
      setError(String(error));
      setBusy(false);
    }
  }

  return (
    <Dialog
      title="Load session file"
      description={
        stage
          ? "The judge checks this session when you save the evaluation."
          : "The judge checks the recorded session against this evaluation’s criteria."
      }
      onClose={onClose}
      busy={busy}
    >
      <form className="ph-no-capture" onSubmit={load}>
        <Field label="Session file">
          <Input
            type="file"
            accept=".json,.jsonl,.ndjson"
            required
            disabled={busy}
            aria-describedby={fileHelp}
            onChange={(e) => {
              const selected = e.target.files?.[0];
              setFile(selected);
              setError(
                selected && selected.size > maxSessionFileBytes
                  ? `Choose a session file of ${maxSessionFileMiB} MiB or less.`
                  : "",
              );
            }}
          />
        </Field>
        <p className="muted" id={fileHelp}>
          Choose a JSON or JSONL log from Claude Code, Codex, OpenCode, or Pi.
          Maximum size per file is {maxSessionFileMiB} MiB.
        </p>
        <Field label="Memo (optional)">
          <Textarea
            rows={3}
            maxLength={maxSessionMemoLength}
            disabled={busy}
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            placeholder="For example, first attempt to install the PostHog CLI"
          />
        </Field>
        <Notice error={error} />
        <footer className="dialog-actions">
          <Button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!file || file.size > maxSessionFileBytes || busy}
          >
            {busy && <StatusIcon name="spinner" />}
            {busy ? "Loading session…" : stage ? "Add file" : "Load and judge"}
          </Button>
        </footer>
      </form>
    </Dialog>
  );
}
