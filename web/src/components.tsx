import { FieldLabel, Field as QuillField } from "@posthog/quill";
import { cloneElement, type ReactElement, type ReactNode, useId } from "react";
import { StatusIcon } from "./status/StatusIcon.js";

export { Acceptance } from "./status/Acceptance.js";
export { Status } from "./status/Status.js";

export const money = (value: number | null | undefined) =>
  value == null ? "Unavailable" : `$${value.toFixed(4)}`;
export const duration = (value: number | null | undefined) =>
  value == null
    ? "—"
    : value < 60000
      ? `${(value / 1000).toFixed(1)}s`
      : `${Math.floor(value / 60000)}m ${Math.round((value % 60000) / 1000)}s`;
export const number = (value: number | null | undefined) =>
  value == null ? "—" : value.toLocaleString();

export function PageTitle({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-title">
      <h1>{title}</h1>
      <div className="actions">{children}</div>
    </div>
  );
}

export function Notice({ error }: { error?: string }) {
  return error ? (
    <p className="error" role="alert">
      <StatusIcon name="error" />
      <span>
        {error.includes("Failed to fetch")
          ? "Cannot connect to the local server. Start StuntHog. Then try again."
          : error.replace(/^(Error|TypeError): /, "")}
      </span>
    </p>
  ) : null;
}

export { CheckBar } from "./CheckBar.js";

export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactElement<{ id?: string }>;
}) {
  const id = useId();

  return (
    <QuillField className="field">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {cloneElement(children, { id })}
    </QuillField>
  );
}
