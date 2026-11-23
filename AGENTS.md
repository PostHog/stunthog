# Engineering directives

These directives preserve the project's requirements and decisions. Apply them when changing StuntHog. Later, explicit user instructions take precedence.

## Product and stack

- Use **StuntHog** for the application name and `stunthog` for the CLI and repository. It evaluates how coding agents use tools and complete tasks, including PostHog integrations and the developing `hog` CLI.
- The CLI is the entry point. Use NestJS and Nest Commander to start the local server and web application. Users must be able to open saved results without starting an evaluation.
- Use Bun for the application runtime, dependency management, builds, and tests. Example projects can retain their own package managers.
- Use React, Vite, Tailwind, and PostHog's Quill components for the web application. All configuration and report workflows belong in the web app; do not restore the YAML runner or standalone file-report implementation.
- Persist evaluations, resources, settings, sessions, traces, artifacts, judgments, and usage through Prisma and SQLite.

## Architecture and implementation

- Follow domain-driven design and clean architecture. Model domain concepts with entities, aggregates, and value objects; enforce their invariants at the domain boundary.
- Domain code must remain independent of NestJS, Prisma, provider SDKs, and the UI. Application services coordinate use cases through ports. Infrastructure implements persistence, filesystem, SDK, and process adapters. Nest modules wire dependencies.
- Keep the shared `Harness` contract above provider implementations. Pi, OpenCode, Codex, and Claude Code each supply their own model catalog, execution adapter, native arguments, and event translation.
- Keep workspace source and execution runtime separate. Route agent commands and MCP processes through the selected local or Docker runtime; do not accidentally run container commands on the host.
- Reuse existing components, domain objects, and adapters. Keep the code organized and readable; avoid duplicated execution or provider logic.
- Add short, useful comments at high-level execution and ownership boundaries. Explain non-obvious flow; do not narrate obvious statements.
- Finish refactors by removing obsolete implementation code, configuration, and generated leftovers. Preserve user data and unrelated work.

## Domain behavior

- An evaluation owns a prompt, acceptance criteria, environment, optional persona, skills, MCP servers, model configurations, and a judge configuration.
- A session is one model running one evaluation with its effective configuration. Each session gets its own judgment. Saved sessions retain their original configuration when an evaluation changes.
- A persona has a title and description and is injected into the agent's instructions. Skills and MCP servers are made available through the harness.
- A skill has a title and exactly one instruction source: a local file or inline content. It has no separate description field.
- An environment has no description field. Its source can be empty, a local folder, or a Git repository. Its execution mode is local or Docker.
- Model configuration includes harness, model, effort, session count, turn limit, and timeout. Do not treat a model and its harness as interchangeable.
- Evaluation defaults and session concurrency are configurable in Settings and persist in SQLite. Defaults prefill new evaluations only; existing evaluations retain their choices. Empty default model or judge selections are allowed.
- Duplicate an evaluation from the evaluations table. Copy its configuration into a new evaluation with new identities, without copying sessions.

## Workspace isolation and data

- Each coding session runs in its own temporary workspace. Copy a selected local folder or clone a selected repository. Do not modify the source folder or reuse another session's workspace.
- Docker environments support an inspectable default image or a custom Dockerfile supplied as a local file or inline content. Ensure the selected native harness is available in the container.
- Harnesses need web access for research and tool use. Preserve web/tool evidence in session traces.
- A custom environment can preinstall a tool under evaluation. When testing the developing PostHog `hog` CLI, verify the intended source/version; do not substitute the deprecated `posthog-cli` package based on its name.
- Default application data to `~/.stunthog/stunthog.db`, independent of the launch directory. Keep `credential.key` and catalog state in the same data directory. `--data` overrides `STUNTHOG_DATA_DIR`, which overrides the home default.
- Use the shared data-directory resolver. Do not add new working-directory-based database or key paths.
- Apply committed Prisma migrations at startup, including in compiled releases. Add a migration for schema changes and preserve existing records and settings.
- Do not overwrite or merge existing databases implicitly. Moving an older database requires its credential key as well; keep old project-local data recoverable.
- API keys have a dedicated management screen. Preserve encryption at rest and masked responses. Never put credentials in source, logs, examples, or this file.

## Judging, logs, and reporting

- Judge each session against its configured criteria using recorded output, actions, and tool evidence. Produce a decision and useful explanation for every criterion, with validated criterion identities.
- Keep execution failures, acceptance failures, and criteria that were not assessed distinguishable. Do not present missing usage, cost, or assessments as successful results or zero values.
- Reports show per-criterion pass percentages, acceptance by model, and per-session feedback explaining the result. The evaluations overview shows average acceptance rather than a column for every model.
- Track running time, input/output/cache tokens, and cost at session, model, and total levels. Preserve the distinction between agent and judge usage and avoid double-counting.
- Console log lines identify the model and show current turn / maximum turns where available. Tool-call summaries include useful details and remain one line.
- Provide a dedicated session page with configuration, files, judgment feedback, and a readable harness-style transcript. Keep raw events available separately from the readable view.
- Keep previous evaluations and sessions navigable. Use spinners, progress bars, icons, and explicit running feedback for active sessions and evaluations.
- Show provider credit balances where a supported endpoint exists. Label unsupported or unavailable balances accurately.
- Maintain PostHog analytics, key-action events, log capture, and exception capture in frontend and backend, plus AI Observability for agents and judges. Reuse the existing integration and keep credentials and private session content out of telemetry.
- Users do not log in. Persist a random anonymous installation ID in SQLite and use it for browser/backend analytics, logs, exceptions, and all agent/judge traces. Never use localhost, a shared fallback, or a trace/session ID as the person's identity. Initialize browser analytics with that ID before capturing events.

## UI and interaction

- Apply the `asd-ste100` skill to all app copy, including labels, help text, errors, status messages, and CLI output. Use active voice, consistent terms, and one instruction per sentence. Limit instructions to 20 words and descriptions to 25 words per sentence. Preserve conditions, uncertainty, and technical terms. Apply these rules to new and existing copy.

- Follow the PostHog brand system and Quill. Use the supplied fonts and stunt hedgehog in `images/posthog-hedgehog-evel.png`. Retain PostHog attribution. Keep the sidebar compact without the strong yellow selection notch.
- Use clear hierarchy, technical labels, useful icons, and compact layouts. User-facing navigation says **Evaluations**.
- Keep criteria open by default on evaluation detail pages. In create/edit forms, show a readable criterion list and open a richer editor dialog when a criterion is selected.
- Use reusable model/harness references with harness logos and model display names. Criterion-bar tooltips identify the criterion and result.
- Use searchable dialogs for model and judge configuration. Show compact summaries of selected configurations. Represent empty selections with explicit **Add model** or **Add judge** actions, not incomplete placeholder configurations.
- Allow inline creation of environments, personas, skills, and MCP servers from evaluation forms.
- Folder and file inputs accept paths and offer a picker. Inline Dockerfiles open in a dialog with a syntax-highlighted code editor.
- Review complete user flows when changing a screen. Visually verify UI changes through the Chrome extension when available; disclose when browser verification is unavailable.
- Keep the README's stunt hedgehog header intact when editing documentation.

## Verification and distribution

- Run focused tests for changed behavior. Use temporary databases/workspaces and controlled harnesses; ordinary tests must not make paid model requests or modify user data.
- `bun run check` runs typechecking, Biome, tests, and the production build. Use `bun run compile:binary` after the build to verify the packaged executable when changing startup, assets, or distribution.
- Test migration compatibility and persistence across restart for storage changes. Test that edits to defaults do not change existing evaluations.
- Distribute standalone executables containing the runtime, UI, and migrations. Maintain release workflows for macOS ARM64/x64, Linux ARM64/x64, and Windows x64, with startup smoke tests, archives, and checksums on GitHub Releases.
- When asked to release, verify checks and publishing outcomes, keep package versions and tags aligned, and report the release link and any unverified behavior.
- Distribute one public npm package, `@posthog/stunthog`, with a Node launcher. Its npm postinstall downloads only the matching GitHub release archive and verifies its SHA-256 against the package manifest. Keep the development package private; generate the distribution manifest separately. Publish through GitHub Actions OIDC from `release.yml` using the `npm` environment. Publishing requires the package's trusted publisher to be configured on npm.
