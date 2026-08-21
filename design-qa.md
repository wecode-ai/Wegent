# Design QA

- Source visual truth:
  `/Users/axb-mac/.wework/workspace/attachments/draft/1787287286894/image.png`
- Implementation screenshot:
  `wework/test-results/ai-verify/2026-08-21T04-44-50-868Z-22271/pr-status-left.png`
- Focused comparison:
  `wework/test-results/ai-verify/2026-08-21T04-44-50-868Z-22271/pr-status-comparison.png`
- Popover screenshot:
  `wework/test-results/ai-verify/2026-08-21T04-44-50-868Z-22271/pr-status-popover.png`
- Viewport: 1600 × 900 CSS px in the isolated Tauri WebView.
- Pixel dimensions: source 544 × 400 px; implementation 2560 × 1440 px.
- Density normalization: the implementation capture uses the desktop display density;
  the focused comparison crops the implementation and places both references on
  600 × 430 px canvases. The source and implementation have different themes and
  content, so the comparison evaluates the requested task-row placement rather
  than whole-screen pixel parity.
- State: expanded project with a selected task linked to GitHub PR #2886; PR checks
  are pending.

## Full-view comparison evidence

The real Tauri capture shows the PR status trigger at the leading edge of the task
row, inside the indentation area before the title. The task title starts immediately
after the 24 px trigger and remains aligned with the task content. Trailing task
metadata and runtime state remain at the right edge.

Measured CSS boxes:

- Task row: x 6–234, height 30 px.
- PR status trigger: x 14–38, size 24 × 24 px.
- Task title: x 42–174, height 20 px.
- Open status popover: x 14–270, size 256 × 103 px.

## Focused region comparison evidence

The side-by-side focused comparison confirms the requested structural change:
the source marks a blank leading column, and the implementation now uses that
column for the PR/MR status while preserving the title and trailing metadata
regions. The status popover opens from the left-aligned trigger toward the content
area instead of extending off the outer edge.

## Required fidelity surfaces

- Fonts and typography: unchanged existing Wework typography is preserved. The
  title keeps its existing size, weight, line height, and truncation.
- Spacing and layout rhythm: passed. The 24 px status trigger plus 4 px gap consumes
  the previous 28 px leading indentation without shifting the normal task title.
- Colors and visual tokens: passed. Existing semantic status colors and sidebar
  tokens are unchanged.
- Image quality and asset fidelity: not applicable; the change reuses the existing
  Lucide status icons and does not add raster or custom-drawn assets.
- Copy and content: unchanged. Existing PR/MR labels, task titles, tooltips, and
  actions remain intact.

## Findings

No actionable P0, P1, or P2 visual mismatches remain within the requested scope.

## Interaction verification

- Clicking the leading PR status trigger opens its details popover.
- The popover remains visible and opens toward the task content area.
- The trigger retains its existing accessible label and test ID.
- The selected task row and its title remain clickable outside the trigger.
- No app errors were observed during the primary interaction.

## Comparison history

Initial implementation placed the PR/MR status after the title and split-group
metadata. The implementation moved it before the title with a negative leading
margin that exactly offsets its width and gap, then changed the task-list popover
alignment to open from the trigger's left edge. The post-fix real-Tauri screenshots
and element metrics above confirm the final placement.

## Follow-up polish

No P3 follow-up is required for this focused change.

final result: passed
