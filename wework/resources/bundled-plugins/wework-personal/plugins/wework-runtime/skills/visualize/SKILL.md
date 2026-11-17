---
name: visualize
description: 'Generate interactive HTML in conversations, including real Wework tool actions and navigation through the host API.'
---

Wework inline visualizations:

- Wework can render AI-generated interactive HTML directly inside conversations. Use this for adjustable inputs, calculators, simulations, charts, and Wework workflows where users can select results, complete a form, execute a real operation or open an existing feature. Generate the HTML for the current scenario; do not look for or create a dedicated business app. Keep simple answers in Markdown and static relationship diagrams in Mermaid. Requests to build or modify a website, application, or repository still require the actual project implementation.
- Create a self-contained HTML fragment in a durable, authorized task-owned directory, preferably `outputs/visualizations/` under the task's working directory. Use a unique descriptive filename for each new visualization or revision so earlier messages keep their original result. Do not use temporary directories or assume a personal Codex directory is writable. Use the absolute path on the execution device.
- Write literal UTF-8 markup with a unique root ID, root-scoped CSS, and inline JavaScript. Do not include doctype/html/head/body wrappers. Keep the file under 1 MiB, embed the required data, and make the initial state useful. Read the file back and check that every selected element exists and that the primary input updates the result.
- Render the result by placing this content reference on its own line in the same turn's final response, outside code fences: visualize{"path":"/absolute/task-owned/outputs/visualizations/calculator.html","title":"Calculator"}. Replace the example path and title with the actual file. Optional `"mode":"wide"` is for desktop application mockups or comparisons that require extra width. Ordinary calculators and charts should fit the normal message width. Do not emit the reference in progress messages or replace it with a Markdown file link.
- The host supplies `--background`, `--foreground`, `--card`, `--card-foreground`, `--primary`, `--primary-foreground`, `--secondary`, `--secondary-foreground`, `--muted`, `--muted-foreground`, `--accent`, `--accent-foreground`, `--destructive`, `--border`, `--input`, `--ring`, `--viz-series-1` through `--viz-series-6`, `--font-size-base`, and `--font-sans`. Use these theme-aware tokens, relative type sizes, responsive layouts, semantic labeled controls, and visible focus. Use compact desktop controls; mobile touch targets must be at least 44px × 44px. Supply any utility classes and control styling yourself; the host does not provide a UI framework.
- The fragment runs in a sandbox with JavaScript enabled. Keep interactions local to its DOM; do not depend on `window.openai`, parent DOM access, Electron, local imports, external scripts, network requests, credentials, or browser storage. The host handles resizing. Use CSS, inline SVG, or canvas for graphics. Inline response fragments are conversation content, not downloadable artifact deliverables; declare an exported standalone file only when the user asks for one.
- Keep the surrounding prose concise and explain only what the user can learn or adjust. Do not expose the rendering protocol or repeat the visualization's data in prose unless requested.

## Information density

Default to high information density unless the user requests otherwise. Choose the simplest layout that lets users identify records and act. A few simple records belong in **one compact list or table**, not a stack of cards, split panels or a multipage interface.

- Give each simple record one row: **name | key status or time | action**. Keep these fields and a small, quiet action button on the same row on desktop. Do not give each record its own bordered card, heading, paragraph and separate button row. Wrap only when the available width or content requires it; retain useful labels and decision context.
- At the default desktop UI scale, aim for 36–44px simple rows and 28–32px action buttons, with 4–8px between related controls. Use relative sizing from the host typography tokens; allow rows to grow for wrapped content, user font settings and accessibility. Mobile targets remain at least 44px × 44px. Do not apply mobile control sizing to every desktop row.
- Keep height intrinsic to content. Do not add minimum-height cards, viewport-height panels, oversized padding, internal scrolling or pagination to a short list. A handful of simple records should occupy one compact block, without requiring several screens of scrolling. Read all required backend pages; do not hide records to make a layout appear compact.
- Group related form fields and use responsive columns when space allows. Keep labels beside or close to their controls. Do not stretch every short field or action across the full width.
- Use the host card title as the heading; add an internal heading only for a distinct section. Keep necessary shared context or coverage notes to a concise line. Reserve strong emphasis for the main workflow action. Do not repeat titles, instructions, warnings or result data above and below the interface.
- Show fields needed to identify a result and decide what to do. Keep internal IDs, lengthy descriptions, logs and secondary settings out of the default row unless decision-relevant; reveal them in details on demand. Preserve readable typography, visible focus and semantic labels. Before presenting, check the whole composition against these rules and simplify excessive vertical stacking.

## HTML that operates Wework

Interactive HTML is optional. Respect explicit user preferences for text, direct execution or an interactive page. Clear, fully specified requests can use direct tools and a concise reply. Choose HTML when selection, editable inputs, multiple results or ongoing management help. This choice applies to every Wework capability, including newly registered tools.

For real Wework actions in a Codex conversation, reuse the fragment and design guidance above, then call `wework_control.present_interaction` with `title`, the literal `html` fragment, and `tools` containing only the exact capability names the fragment uses. Use `[]` for navigation alone. This renders the HTML in the current conversation and injects `window.wework` before its inline scripts execute. Do not emit a separate visualize reference for the same interaction. The ordinary visualize reference remains for local-only explanations and charts; it has no tool access.

When choosing HTML, use the same workflow for every Wework capability: discover its `inputSchema` and `outputSchema` with `list_capabilities` or `describe_capability`, read the relevant current data, generate HTML for the user's goal, and bind the needed real operations. Newly registered tools use the same host API without a dedicated UI adapter. Collect missing inputs in the generated form, show candidates for selection, and offer actions appropriate to the current state. If no tool performs the requested operation, use a registered navigation destination. Do not infer one capability's fields from another capability.

The injected API is the interface between generated HTML and the host:

```js
const result = await window.wework.callTool(capabilityName, argumentsObject)
// Use the exact name, arguments and result fields from the discovered contract.
// result is decoded business data matching that capability's outputSchema.
// The host decodes structuredContent or a single JSON text result; failures reject.
const destinations = window.wework.navigationTargets
// Each registered destination has id, path, label and optional labelKey.
await window.wework.navigate(destinations[0].path)
// Existing wework:// links returned by Wework are also supported.
const restored = window.wework.state // object or null, specific to this interaction
await window.wework.setState({ view: 'results', selectedIds: [] })
// Resolved only after the host saves the state; limit 64 KiB.
const { locale, timeZone, theme } = window.wework.context
```

- Bind only real capabilities and use their exact argument schemas. The host checks the source conversation and tool binding and preserves native authorization. HTML cannot grant permissions. Do not use network requests, credentials, parent DOM access, Electron or browser storage.
- Generate the useful interface immediately. For a partial creation request, fill known values and let the user supply missing fields in the form. For multiple matching conversations, render selectable results and relevant actions. Query actual data, follow pagination and display incomplete coverage. Use `textContent` for data from tools rather than treating returned text as markup.
- Choose the primary action from the user's goal and the target's current state. For archived-conversation recovery, list the candidates with **Restore** actions calling `unarchive_conversation` with the returned `conversation_id`. After `accepted: true`, show **Restored** and offer **Open conversation**. Do not replace a requested operation with a navigation button or treat opening a destination as a successful mutation.
- Use `navigationTargets` to find a registered feature when an operation has no tool; do not guess routes or invent API names. Opening a feature does not perform its operation. If the required operation and destination are both unavailable, state that limitation in the HTML.
- Only user actions may trigger writes. Disable submission while pending, display the actual result and handle rejection. A timeout or `invalid_tool_result` error has an unknown outcome: inspect the real state before resubmitting. Never retry a write automatically or run it during initialization.
- Read each capability's output schema; do not infer its result shape from its input or inspect MCP `content`/`structuredContent` in the HTML. `callTool` already decodes that envelope. Show selected, meaningful fields with `textContent`; never dump `JSON.stringify(result)` into a success or error message.
- Read `state` before choosing the initial view. Use **one `render(state)` function** for initial restoration and the immediate result of a successful action. Build the completed state from the returned business object, render it immediately, then persist that same state with `await setState(...)`. Reopening must render the same completed view without repeating the action. Keep current business data fresh through read tools.
- Track operation success separately from rendering and card-state persistence. Once the real tool succeeds, keep its result and the submit action disabled even if rendering, a follow-up read or `setState` fails. Show a specific secondary error such as “Task created; card state could not be saved.” Do not report the operation as failed or invite another creation. Save drafts when useful and surface persistence failures.
- Keep height intrinsic to content; avoid viewport-height layouts. The host handles resizing and theme changes. Supply semantic controls, descriptive `data-testid` attributes, pending/error/success feedback, and concise surrounding prose.
