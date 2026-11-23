# StuntHog design

This is a local research tool for PostHog engineers. Users define evals,
compare sessions, and inspect the evidence for each judge decision.

Use the official assets and guidance at https://brand.posthog.com/.
Keep the dense dark layout from the supplied session screenshots.
Do not add marketing sections or decorative dashboard cards.

- Font: bundled RoundHog, with 400, 500, and 700 weights. Body text is 13px.
- Code and transcripts: the system monospace font, 12px.
- Components: `@posthog/quill`, pinned to 0.3.0-beta.33.
- Theme: Quill dark mode, with the `dark` class on the document root.
- Surfaces, text, borders, focus, and status colors: Quill semantic tokens.
- Root font size: 16px, so Quill rem-based controls retain their intended size.
- App body: 13px. Preserve the compact research layout.
- Use **StuntHog** in the interface and `stunthog` for the command.
  The sidebar pairs the name with `images/posthog-hedgehog-evel.png`.
- Sidebar: Workspace, Resources, and Settings groups; gold current-page state.
  Keep New eval next to the brand on narrow screens. PostHog wordmark and a
  small research hedgehog sit in the desktop footer.
- Icons: official PostHog icons. Research hedgehog: sidebar footer only.

Open criteria by default on the eval detail screen. Expose full criteria in
keyboard-accessible tooltips. Show status as text as well as color.
Use chronological, numbered transcript entries with expandable tool
output and explicit filters. Judge feedback sits beside the transcript
on wide screens and below it on narrow screens.

Import Quill tokens, base reset, Tailwind source, and primitive styles in
web/src/styles.css. Use Quill controls directly. The Choice and Dialog
components compose Quill for repeated app flows. Custom CSS covers page
layout, model references, and transcript content; it must not recreate control
skins. Criteria and model settings use dialogs with local draft state. Apply
updates the eval draft; Cancel discards changes. New evals start with no models
and no judge. Explicit Add actions open configuration dialogs; only complete
selections appear in the model and judge sections. Inline resource creation
saves to the resource library and selects the result in the draft.
Skills have one title and either inline instructions or one local file path.
They do not have descriptions.
API keys use provider rows with explicit key sources. Add, override, replace,
and remove actions open focused dialogs; key fields stay hidden until editing.

Asset provenance and
licenses live in web/public/brand. All brand assets must work offline.
