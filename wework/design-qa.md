# Plugin composer recommendation design QA

- Selected visual truth:
  - `/Users/md/.codex/generated_images/019fb61a-1746-7b11-a3fe-f6318f05954e/exec-fa332845-911c-4e0c-8ab1-341eda692300.png`
- Rendered implementation:
  - `/Users/md/Wegent/wework/test-results/ai-verify/2026-08-03T06-53-08-424Z-55483/plugin-guidance-recommendation-final.png`
  - `/Users/md/Wegent/wework/test-results/ai-verify/2026-08-03T06-53-08-424Z-55483/plugin-guidance-other-tasks.png`
- Same-input comparison:
  - `/Users/md/Wegent/wework/test-results/ai-verify/2026-08-03T06-53-08-424Z-55483/plugin-guidance-visual-comparison-final.png`
- Desktop E2E evidence:
  - `/Users/md/Wegent/wework/test-results/desktop-e2e/2026-08-03T07-30-25-393Z-73421/plugins-04-used-in-chat.png`
- Viewport: `1280 x 720` CSS pixels at device scale factor `1`.
- State: light theme, local project selected, installed plugin active in the composer.

## Product decision

The three competing composer interactions were replaced with one recommendation flow:

1. One recommended task is the only primary object and has the only strong CTA.
2. `AI 换一个建议` replaces the recommendation using the current draft, plugin capabilities, and inherited recent conversation.
3. `查看其他常用任务` is collapsed by default. Selecting an item replaces the recommendation instead of mutating the composer immediately.

Only `使用这个任务` writes the recommendation into the composer. It preserves the plugin mention and never submits automatically.

## Findings

No actionable P0/P1/P2 findings remain.

- The header now identifies the panel as `<plugin> 使用建议`, not another plugin picker.
- The recommendation row owns visual focus through its title, supporting description, and inverse-neutral CTA.
- AI and static alternatives are quiet, adjacent actions with explicit outcomes rather than equal-weight rows.
- Other tasks stay hidden until requested, reducing initial density and avoiding the expectation that every plugin must provide three examples.
- A selected alternative replaces the recommendation and automatically collapses the list.
- The guide is not rendered when no plugin or plugin templates are active.
- Consequence copy appears once in the footer: the task remains editable and is not sent automatically.

## Visual comparison

- Hierarchy: implementation matches the selected direction of one recommended task, one primary CTA, and two secondary paths.
- Density: implementation is compressed to the existing Wework composer width and spacing scale while preserving the selected layout hierarchy.
- Color: existing neutral surfaces, weak borders, and inverse-neutral CTA are reused; no new accent palette was introduced.
- Context: the plugin chip remains in the composer directly below the guide so the recommendation and its execution target read as one flow.
- Expansion: the optional task list uses compact text rows and no repeated plugin icons.

## Interaction evidence

- Component tests verify initial single-recommendation state, collapsed alternatives, alternative replacement, AI replacement, preserved plugin mention, no automatic submit, and no stray guide without a plugin.
- Real Tauri inspection verified selecting another task, automatic collapse, applying the task, and the resulting composer value.
- Desktop plugin E2E verifies the marketplace-to-chat path, deterministic AI recommendation, application to the composer, plugin picker entry, slash-command entry, and uninstall flow.
- Production build, strict TypeScript, focused tests, lint, and formatting checks completed successfully.

## Iteration history

### Iteration 1

- P1: header, AI action, and three visible examples competed at the same visual level.
- Fix: selected the single-recommendation direction and made alternatives secondary.

### Iteration 2

- P1: the guide appeared with no selected plugin because an AI refinement callback was available globally.
- Fix: require an active plugin name or plugin-provided templates before rendering the guide.

### Iteration 3

- P2: recommendation description repeated the footer's editable/no-auto-send consequence.
- Fix: static recommendations now identify their plugin source; the consequence remains only in the footer.

### Iteration 4

- P1: the desktop E2E model server treated hidden AI recommendation work as a normal chat request.
- Fix: added a deterministic plugin-recommendation response so the real desktop path verifies the intended isolated AI flow.

## Follow-up polish

- P3: plugin-provided examples remain in their manifest language when localized metadata is unavailable.

final result: passed
