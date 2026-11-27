import type { EvaluationData } from "../../evaluations/domain/evaluation.js";

import type { ModelSettingsData } from "../../evaluations/domain/model-settings.js";
import type { BackgroundEntry, TraceEdit } from "./trace-edit.js";

export interface EditedSessionStart {
  settings: ModelSettingsData;
  task: string;
  background: BackgroundEntry[];
  label: string;
  change: string;
  field: TraceEdit["field"];
  workspace: "initial" | "empty";
}

export interface ExecutionSnapshot {
  agentSettings?: ModelSettingsData;
  editedStart?: {
    label: string;
    change?: string;
    field?: TraceEdit["field"];
    fingerprint: string;
    hasBackground: boolean;
    workspace: "initial" | "empty";
  };
  promptCheckpoint?: ModelSettingsData;
  evaluation: EvaluationData;
  environment: {
    title: string;
    workspacePath: string | null;
    repositoryUrl: string | null;
    restoredImage?: string;
    executionMode: "local" | "docker";
    dockerfilePath: string | null;
    dockerfileContent: string | null;
  } | null;
  persona: { title: string; description: string } | null;
  skills: { title: string; content: string }[];
  mcps: {
    id?: string;
    title: string;
    url?: string | null;
    command: string;
    arguments: string[];
  }[];
  // Judge resources. Sessions saved before judge resources existed omit these fields.
  judgeSkills?: { title: string; content: string }[];
  // Judge MCP entries saved without allowedTools expose no tools.
  judgeMcps?: {
    title: string;
    url?: string | null;
    command: string;
    arguments: string[];
    allowedTools?: string[];
  }[];
}
