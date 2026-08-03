# Plugin composer AI guidance design QA

- Source visual truth:
  - `/var/folders/01/4sjfpdwj1ls3k91ykpx3rpd80000gn/T/codex-clipboard-2909cb89-cbbc-448b-948b-966b07d118e1.png`
  - `/var/folders/01/4sjfpdwj1ls3k91ykpx3rpd80000gn/T/codex-clipboard-5823212f-1096-4052-85bc-2e1937cae407.png`
  - `/var/folders/01/4sjfpdwj1ls3k91ykpx3rpd80000gn/T/codex-clipboard-e5632fa5-cab3-4c71-ab2b-a96bfe09fd18.png`
- Rendered implementation:
  - `/Users/md/Wegent/wework/test-results/ai-verify/2026-08-03T04-57-34-498Z-15264/plugin-ai-guide-project.png`
  - `/Users/md/Wegent/wework/test-results/ai-verify/2026-08-03T04-57-34-498Z-15264/plugin-ai-guide-result.png`
- Same-input comparison:
  - `/Users/md/Wegent/wework/test-results/ai-verify/2026-08-03T04-57-34-498Z-15264/plugin-guide-comparison.png`
- Viewport: `1280 x 720` CSS pixels at device scale factor `1`.
- State: light theme, local project selected, an installed plugin selected from the composer.

## Product decision

The composer popup is no longer a second plugin picker. It is a lightweight plugin-use coach with two paths:

1. The primary path asks AI to turn the current draft, plugin capabilities, available examples, and inherited recent conversation into one ready-to-send task.
2. The secondary path lets the user start from a compact plugin example when AI refinement is unnecessary.

AI output is always shown in an editable preview before it can replace the composer text. Applying it preserves the plugin mention and never submits automatically.

## Findings

No actionable P0/P1/P2 findings remain.

- The old header (`<plugin> 常用场景`) read as another plugin list. The new header uses an explicit `AI 使用引导` badge, `用好 <plugin>` title, and consequence-focused helper copy.
- Repeated plugin icons made every row look like a plugin entity. The new design uses a single AI identity at the panel and text-only examples as secondary actions.
- The old list offered only static examples. The new primary action runs hidden ephemeral inference using the current model selection and, when available, the current runtime task as conversation context.
- Generated text is not silently inserted. It enters an editable result state with `重新整理` and `带入输入框` actions.
- Loading, failure, retry, close, apply, and no-auto-send consequences are visible in the same panel.

## Visual comparison

- Hierarchy: the AI action is the only full-width primary row; examples are lower contrast and grouped under `也可以从示例开始`.
- Identity: the panel is visually separated from the plugin picker and explicitly states why it appeared.
- Density: the previous three equal rows became one primary AI action plus compact example text, reducing repeated chrome and icons.
- Borders and color: existing Wework neutral surfaces and weak borders are reused; no new saturated accent or decorative asset was introduced.
- Composer relationship: the selected plugin mention remains inside the composer, while guidance stays above it and explains that it only improves input.

## Interaction evidence

- Component tests verify AI success, no mutation before confirmation, editable preview, preserved plugin mention, and no automatic submit.
- Hook tests verify creation of a hidden ephemeral runtime task, inherited source conversation, output normalization, and surfaced model errors.
- Desktop plugin E2E verifies opening the guide, AI result editing, applying the result to the composer, and no automatic send.
- Real Tauri inspection verified the initial, loading, and inline timeout/retry states. The isolated manual session did not have a responding model, so AI success is covered by deterministic hook/component/desktop-E2E execution rather than claimed from that session.
- Production build, strict TypeScript, focused tests, and lint completed successfully.

## Iteration history

### Iteration 1

- P1: plugin examples visually resembled installed-plugin rows.
- P1: there was no dynamic completion path.
- Fix: added explicit AI guide identity and promoted AI refinement over examples.

### Iteration 2

- P1: earlier context enhancement merely appended an instruction and did not call a model.
- P1: an immediate model rewrite would be surprising if it replaced the composer silently.
- Fix: replaced the fake enhancement with hidden runtime inference and introduced an editable result preview before apply.

### Iteration 3

- P2: repeated icons and equal-weight rows still made the guide look like a plugin picker.
- Fix: removed repeated plugin icons, reduced example emphasis, clarified no-auto-send behavior, and added inline retry.

## Follow-up polish

- P3: plugin-provided examples remain in their manifest language when localized metadata is unavailable.

final result: passed
