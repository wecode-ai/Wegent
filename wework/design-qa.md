# Plugin guidance design QA

- Source visual truth:
  - `/var/folders/01/4sjfpdwj1ls3k91ykpx3rpd80000gn/T/codex-clipboard-5823212f-1096-4052-85bc-2e1937cae407.png`
  - `/var/folders/01/4sjfpdwj1ls3k91ykpx3rpd80000gn/T/codex-clipboard-c5035f5e-6689-4ddf-b18f-e396bfd16588.png`
  - `/var/folders/01/4sjfpdwj1ls3k91ykpx3rpd80000gn/T/codex-clipboard-e5632fa5-cab3-4c71-ab2b-a96bfe09fd18.png`
- Rendered implementation:
  - `/Users/md/Wegent/wework/test-results/ai-verify/2026-08-03T04-01-40-048Z-90474/plugin-detail.png`
  - `/Users/md/Wegent/wework/test-results/ai-verify/2026-08-03T04-01-40-048Z-90474/plugin-guide.png`
  - `/Users/md/Wegent/wework/test-results/ai-verify/2026-08-03T04-01-40-048Z-90474/plugin-composer-guide.png`
- Viewport: `1280 × 720` CSS pixels at device scale factor `1`.
- Source pixels: dialog `773 × 792`; detail entry `1071 × 218`; composer guidance `812 × 395`.
- Implementation pixels: `1280 × 720` for all three captures.
- Normalization: each annotated source and its corresponding implementation capture were opened together in one comparison input. The sources are cropped annotations rather than full product frames, so hierarchy, density, affordance, spacing, and copy were compared at the component level rather than by shell geometry.
- State: light theme; Code Review marketplace detail and guide dialog; Data Analytics selected from the composer plugin picker.

## Findings

No actionable P0/P1/P2 findings remain.

- The detail entry is intentionally not a literal reproduction of the three-card source. The source annotation identifies those cards as too heavy and difficult to populate consistently; the implementation replaces them with one lightweight AI guide row and one recommended starting point.
- The dialog now establishes guidance before plugin content, makes the editable task goal primary, places the preview before optional supplement, and collapses supplement by default.
- The composer panel is visually and verbally separated from the plugin picker: it has a Sparkles guide icon, “插件使用建议” title, active plugin helper, editable-example affordances, and a no-auto-send footer.

## Full-view comparison evidence

- Detail: the original three equal cards consumed a full section and implied every plugin must provide three scenarios. The implementation uses a single neutral row with a concise explanation and one recommended example, reducing visual weight and removing the fixed-count assumption.
- Dialog: the annotated source placed optional supplement above the task preview and gave both equal emphasis. The implementation puts the editable goal and one key preference first, promotes the exact composer draft, and moves supplement into a low-emphasis disclosure after the preview.
- Composer: the annotated source could be mistaken for another plugin menu. The implementation clearly labels the panel as plugin guidance, names the active plugin, and explains that selection only fills the composer.

## Focused-region comparison evidence

- Dialog header, goal input, selected preference, preview, supplement disclosure, footer consequence copy, and primary CTA were inspected at full capture resolution. Text remains legible without overflow at `1280 × 720`.
- Composer header, selected example row, plugin mention, close control, enter affordances, and the relationship between guide panel and composer were inspected at full capture resolution.
- The active-conversation enhancement is covered by component and desktop E2E interaction evidence: it appears only when an active conversation exists, preserves the plugin mention and current draft, inserts a context-aware instruction, and does not submit.

## Required fidelity surfaces

- Fonts and typography: existing Wework semantic type roles, weights, line heights, wrapping, and truncation are used. Primary labels remain visually distinct from helper copy. Passed.
- Spacing and layout rhythm: the detail entry is compact; the dialog retains the shared 600px overlay and readable section rhythm; the composer guide stays within the 760px composer column. Passed.
- Colors and visual tokens: neutral surfaces, weak borders, restrained selected states, and the existing inverse primary action are used. No new decorative color system was introduced. Passed.
- Image quality and asset fidelity: existing plugin assets and Lucide product icons are reused. No generated placeholder, inline SVG artwork, CSS drawing, or fake logo was added. Passed.
- Copy and content: every entry explains its consequence; “AI 插件使用向导” and “插件使用建议” distinguish guidance from plugin selection; context-aware copy states when recent messages will be used; all actions explicitly avoid automatic sending. Passed.
- Responsiveness and accessibility: dialog focus trap, Escape close, focus restoration, labeled controls, `aria-pressed`, disclosure state, and keyboard-reachable actions are covered by tests. No visible clipping or persistent-control overflow was found. Passed.

## Primary interactions tested

- Opened the single guide entry from marketplace detail.
- Edited the task goal and changed the plugin-specific preference.
- Verified that the task preview updates before confirmation.
- Expanded optional supplement only on demand.
- Verified active-conversation enhancement preserves the current idea and only fills the composer.
- Selected plugin examples from the composer without submitting.
- Verified close, Escape, focus trap, and focus restoration behavior.
- Ran the real desktop plugin flow: install, try, composer selection, slash-command selection, and uninstall.
- Isolated Tauri debug state contained no captured application console errors. The unrelated local cloud API `HTTP 502` status does not affect this local plugin flow.

## Comparison history

### Iteration 1

- P1: detail used three equally prominent scenario cards and forced a fixed scenario count.
- P1: dialog made optional supplement compete with the generated task preview.
- P1: composer guidance resembled another plugin list and did not explain why it appeared.
- Fixes: consolidated detail to one AI guide entry; reordered dialog around editable goal → key choice → preview → optional supplement; added explicit guidance identity and consequence copy to composer.

### Iteration 2

- P2: “AI 结合当前对话生成任务” implied an immediate hidden generation step.
- Fix: changed the action to “让 AI 结合当前对话完善” and made the actual behavior explicit: recent conversation is used after the task enters chat, current draft is preserved, and nothing is sent automatically.
- Post-fix evidence: current implementation captures plus passing component and real desktop plugin E2E.

## Follow-up polish

- P3: plugin-provided English scenario prompts remain English when localized metadata is unavailable. This preserves source instructions and can be improved when plugin manifests support localized prompts.

final result: passed
