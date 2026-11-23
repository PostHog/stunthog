import {
  Button,
  Input,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from "@posthog/quill";
import { type FormEvent, useState } from "react";
import { api } from "../api.js";
import { Choice } from "../Choice.js";
import { Field, Notice } from "../components.js";
import { StatusIcon } from "../status/StatusIcon.js";
import type { Resource } from "../types.js";
import { ArgumentFields } from "./ArgumentFields.js";
import { DefaultDockerfile } from "./DefaultDockerfile.js";
import { InlineDockerfile } from "./InlineDockerfile.js";
import { PathInput } from "./PathInput.js";
import { ResourceIcon, type ResourceIconName } from "./ResourceIcon.js";
import { type ResourceKind, resourceInfo } from "./resource-info.js";

function EnvironmentSectionHeading({
  icon,
  title,
  description,
}: {
  icon: ResourceIconName;
  title: string;
  description: string;
}) {
  return (
    <header className="environment-section-heading">
      <span className="environment-section-icon">
        <ResourceIcon name={icon} />
      </span>
      <div>
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
    </header>
  );
}

const inlineSkillTemplate = `---
name: review-code
description: Review changed files for defects.
---

Read the changed files and report any defects.
`;

const titlePlaceholders = {
  skills: "Review code",
  personas: "Backend engineer",
  mcps: "GitHub",
  environments: undefined,
};

export function ResourceForm({
  kind,
  initial,
  onClose,
  onSaved,
  onSavingChange,
  hideTitle = false,
}: {
  kind: ResourceKind;
  initial?: Resource;
  onClose: () => void;
  onSaved: (resource: Resource) => void;
  onSavingChange?: (saving: boolean) => void;
  hideTitle?: boolean;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [path, setPath] = useState(
    initial?.workspacePath ?? initial?.filePath ?? initial?.command ?? "",
  );
  const [repositoryUrl, setRepositoryUrl] = useState(
    initial?.repositoryUrl ?? "",
  );
  const [dockerfilePath, setDockerfilePath] = useState(
    initial?.dockerfilePath ?? "",
  );
  const [dockerfileContent, setDockerfileContent] = useState(
    initial?.dockerfileContent ?? "",
  );
  const [dockerfileSource, setDockerfileSource] = useState<
    "default" | "file" | "inline"
  >(
    initial?.dockerfileContent
      ? "inline"
      : initial?.dockerfilePath
        ? "file"
        : "default",
  );
  const [environmentSource, setEnvironmentSource] = useState<
    "empty" | "folder" | "repository"
  >(
    initial?.repositoryUrl
      ? "repository"
      : initial?.workspacePath
        ? "folder"
        : "empty",
  );
  const [executionMode, setExecutionMode] = useState<"local" | "docker">(
    initial?.executionMode ?? "local",
  );
  const [content, setContent] = useState(
    initial?.content ?? inlineSkillTemplate,
  );
  const [skillSource, setSkillSource] = useState<"inline" | "file">(
    initial?.filePath ? "file" : "inline",
  );
  const [mcpSource, setMcpSource] = useState<"command" | "url">(
    initial?.url ? "url" : "command",
  );
  const [mcpUrl, setMcpUrl] = useState(initial?.url ?? "");
  const [args, setArgs] = useState<{ id: string; value: string }[]>(() =>
    (initial?.arguments ?? []).map((value) => ({
      id: crypto.randomUUID(),
      value,
    })),
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault();

    if (
      kind === "environments" &&
      executionMode === "docker" &&
      dockerfileSource === "inline" &&
      !dockerfileContent.trim()
    ) {
      setError("Add the inline Dockerfile before saving the environment.");
      return;
    }

    setSaving(true);
    onSavingChange?.(true);
    setError("");

    try {
      const [mcpCommand, ...mcpArguments] =
        kind === "mcps" && mcpSource === "command" ? splitNpxCommand(path) : [];
      const value = {
        kind: resourceInfo[kind].kind,
        title,
        ...(kind === "personas" || kind === "mcps" ? { description } : {}),
        ...(kind === "environments"
          ? {
              workspacePath: environmentSource === "folder" ? path : null,
              repositoryUrl:
                environmentSource === "repository" ? repositoryUrl : null,
              executionMode,
              dockerfilePath:
                executionMode === "docker" && dockerfileSource === "file"
                  ? dockerfilePath
                  : null,
              dockerfileContent:
                executionMode === "docker" && dockerfileSource === "inline"
                  ? dockerfileContent
                  : null,
            }
          : {}),
        ...(kind === "skills"
          ? {
              filePath: skillSource === "file" ? path : null,
              content: skillSource === "inline" ? content : null,
            }
          : {}),
        ...(kind === "mcps"
          ? mcpSource === "url"
            ? { url: mcpUrl, command: "", arguments: [] }
            : {
                url: null,
                command: mcpCommand,
                arguments: [
                  ...mcpArguments,
                  ...args.map((argument) => argument.value),
                ],
              }
          : {}),
      };

      const saved = await api<Resource>(
        initial ? `/resources/${initial.id}` : "/resources",
        {
          method: initial ? "PUT" : "POST",
          body: JSON.stringify(value),
        },
      );
      onSaved(saved);
    } catch (error) {
      setError(String(error));
    } finally {
      setSaving(false);
      onSavingChange?.(false);
    }
  }

  return (
    <form className="resource-form" onSubmit={save}>
      {!hideTitle && (
        <h2>
          {initial ? "Edit" : "Add"} {resourceInfo[kind].singular}
        </h2>
      )}
      {kind !== "environments" && (
        <p className="muted">{resourceInfo[kind].hint}</p>
      )}
      <Notice error={error} />
      <Field label="Title">
        <Input
          required
          placeholder={titlePlaceholders[kind]}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </Field>
      {kind !== "skills" && kind !== "environments" && (
        <Field
          label={kind === "personas" ? "Persona instructions" : "Description"}
        >
          <Textarea
            required={kind === "personas"}
            rows={4}
            placeholder={
              kind === "personas"
                ? "Review changes as a backend engineer."
                : "Access GitHub issues and pull requests."
            }
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
      )}
      {kind === "skills" && (
        <Tabs
          className="resource-source"
          value={skillSource}
          onValueChange={(value) => setSkillSource(value as typeof skillSource)}
        >
          <TabsList aria-label="Source">
            <TabsTrigger value="file">File</TabsTrigger>
            <TabsTrigger value="inline">Inline</TabsTrigger>
          </TabsList>
          <TabsContent value="inline">
            {skillSource === "inline" && (
              <Field label="Skill instructions">
                <Textarea
                  required
                  rows={12}
                  placeholder="Read the changed files and report any defects."
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                />
              </Field>
            )}
          </TabsContent>
          <TabsContent value="file">
            {skillSource === "file" && (
              <Field label="Skill file">
                <PathInput
                  kind="file"
                  required
                  value={path}
                  placeholder="/absolute/path/to/skill.md"
                  onChange={setPath}
                />
              </Field>
            )}
          </TabsContent>
        </Tabs>
      )}
      {kind === "environments" && (
        <div className="environment-form">
          <section>
            <EnvironmentSectionHeading
              icon="runtime"
              title="Execution engine"
              description="Choose where agent and tool commands run."
            />
            <Tabs
              value={executionMode}
              onValueChange={(value) =>
                setExecutionMode(value as typeof executionMode)
              }
            >
              <TabsList aria-label="Execution engine">
                <TabsTrigger value="local">Local</TabsTrigger>
                <TabsTrigger value="docker">Docker</TabsTrigger>
              </TabsList>
              <TabsContent value="local">
                <p className="muted">Run agent commands on this computer.</p>
              </TabsContent>
              <TabsContent value="docker" className="environment-options">
                <div className="environment-subsection">
                  <h4>Docker image</h4>
                  <Field label="Image definition">
                    <Choice
                      value={dockerfileSource}
                      onValueChange={(value) =>
                        setDockerfileSource(value as typeof dockerfileSource)
                      }
                      options={[
                        { value: "default", label: "Use the built-in image" },
                        { value: "file", label: "Use a local Dockerfile" },
                        { value: "inline", label: "Write a Dockerfile" },
                      ]}
                    />
                  </Field>
                  {dockerfileSource === "default" && <DefaultDockerfile />}
                  {dockerfileSource === "file" && (
                    <Field label="Dockerfile path">
                      <PathInput
                        kind="file"
                        required
                        value={dockerfilePath}
                        placeholder="/absolute/path/to/Dockerfile"
                        onChange={setDockerfilePath}
                      />
                    </Field>
                  )}
                  {dockerfileSource === "inline" && (
                    <InlineDockerfile
                      value={dockerfileContent}
                      onChange={setDockerfileContent}
                    />
                  )}
                  <p className="muted">
                    StuntHog installs the selected native harness with npm. For
                    a native harness, the final image must include Node.js 22,
                    npm, and sh. Pi requires only the commands the agent uses.
                  </p>
                </div>
              </TabsContent>
            </Tabs>
          </section>
          <section>
            <EnvironmentSectionHeading
              icon="workspace"
              title="Workspace source"
              description="Choose which files each session starts with."
            />
            <Tabs
              value={environmentSource}
              onValueChange={(value) =>
                setEnvironmentSource(value as typeof environmentSource)
              }
            >
              <TabsList aria-label="Workspace source">
                <TabsTrigger value="empty">Empty workspace</TabsTrigger>
                <TabsTrigger value="folder">Local folder</TabsTrigger>
                <TabsTrigger value="repository">Git repository</TabsTrigger>
              </TabsList>
              <TabsContent value="empty">
                <p className="muted">
                  Start each session in an empty directory.
                </p>
              </TabsContent>
              <TabsContent value="folder" className="environment-options">
                <Field label="Source directory">
                  <PathInput
                    kind="directory"
                    required
                    value={path}
                    placeholder="/absolute/path/to/project"
                    onChange={setPath}
                  />
                </Field>
              </TabsContent>
              <TabsContent value="repository" className="environment-options">
                <Field label="Repository URL">
                  <Input
                    required
                    value={repositoryUrl}
                    placeholder="https://github.com/PostHog/posthog.git"
                    onChange={(event) => setRepositoryUrl(event.target.value)}
                  />
                </Field>
              </TabsContent>
            </Tabs>
          </section>
        </div>
      )}
      {kind === "mcps" && (
        <Tabs
          className="resource-source"
          value={mcpSource}
          onValueChange={(value) => setMcpSource(value as typeof mcpSource)}
        >
          <TabsList aria-label="Source">
            <TabsTrigger value="command">Command</TabsTrigger>
            <TabsTrigger value="url">MCP URL</TabsTrigger>
          </TabsList>
          <TabsContent value="command">
            {mcpSource === "command" && (
              <>
                <Field label="MCP command">
                  <Input
                    required
                    value={path}
                    placeholder="npx -y example-mcp-server"
                    onChange={(event) => setPath(event.target.value)}
                  />
                </Field>
                <ArgumentFields value={args} onChange={setArgs} />
              </>
            )}
          </TabsContent>
          <TabsContent value="url">
            {mcpSource === "url" && (
              <Field label="MCP URL">
                <Input
                  type="url"
                  required
                  value={mcpUrl}
                  placeholder="https://example.com/mcp"
                  onChange={(event) => setMcpUrl(event.target.value)}
                />
              </Field>
            )}
          </TabsContent>
        </Tabs>
      )}
      <div className="actions">
        <Button type="submit" variant="primary" disabled={saving}>
          {saving && <StatusIcon name="spinner" />}
          {saving ? "Saving..." : `Save ${resourceInfo[kind].singular}`}
        </Button>
        <Button type="button" disabled={saving} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function splitNpxCommand(input: string): string[] {
  const command = input.trim();
  if (!/^npx\s/.test(command)) return [command];

  // Parse pasted arguments as text so the command never needs a shell.
  const word = /(?:[^\s"'\\]+|'[^']*'|"(?:[^"\\]|\\.)*"|\\.)+/g;
  if (command.replace(word, "").trim())
    throw new Error(
      "Close the quotes or complete the escape in the MCP command.",
    );

  return Array.from(command.matchAll(word), ([value]) =>
    value.replace(
      /'([^']*)'|"((?:[^"\\]|\\.)*)"|\\(.)/g,
      (_match, single, double, escaped) =>
        single ?? double?.replace(/\\(["\\])/g, "$1") ?? escaped,
    ),
  );
}
