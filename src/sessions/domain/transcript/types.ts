import { z } from "zod";
import type { ResponseCapture } from "../../../overrides/domain/response-override.js";

export type EntryKind =
  | "message"
  | "user"
  | "thinking"
  | "tool"
  | "web"
  | "system";
export interface TranscriptEntry {
  id: string;
  sequence: number;
  completedAt?: number;
  batch?: string;
  capture?: ResponseCapture | undefined;
  responseId?: string | undefined;
  args?: Record<string, unknown> | undefined;
  name?: string | undefined;
  server?: string | undefined;
  kind: EntryKind;
  title: string;
  text: string;
  output?: string;
  exitCode?: number;
  status?: "running" | "passed" | "failed";
}

export const record = (value: unknown): Record<string, unknown> =>
  z.record(z.unknown()).safeParse(value).data ?? {};
export const string = (value: unknown): string =>
  typeof value === "string" ? value : "";
export const blocksText = (value: unknown): string =>
  typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value
          .map((part) => string(record(part).text))
          .filter(Boolean)
          .join("\n")
      : "";

export function toolText(value: unknown): string {
  const args = record(value);

  return (
    string(
      args.command ??
        args.filePath ??
        args.file_path ??
        args.path ??
        args.url ??
        args.pattern,
    ) || (Object.keys(args).length ? JSON.stringify(args) : "")
  );
}

export const toolKind = (name: string): EntryKind =>
  /web|fetch|search/i.test(name) ? "web" : "tool";

export interface TraceEvent {
  id: number;
  sequence: number;
  event: unknown;
}
