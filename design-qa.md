**Comparison Target**

- Source truth: `design-demos/wework-issue-detail-redesign.html`
- Runtime surface: `TodoEditor.tsx` workspace-panel presentation
- Fidelity-critical behavior: `IssueWorkflowDag.tsx`
- Real-Tauri evidence: `wework/test-results/desktop-e2e/2026-08-19T14-40-41-865Z-77610`
- State: light theme, staged Issue, current human stage, three task executions, required deliverable, attachment footer

**Resolved Mismatches**

- Restored the demo's 460px inset floating panel, 16px radius, neutral shadow, compact breadcrumb header, pill metadata, and 20px body gutter.
- Restored the visible gray description block; the collapsed state now shows a two-line preview, toggle, and Markdown hint instead of hiding the description.
- Matched the demo's section rhythm: 20px section spacing, compact title/count headers, no section dividers, and quiet row hover states.
- Matched the staged form: 300px dotted DAG first, exactly one selected stage panel second, then deliverables, task rows, and the dashed create-task action.
- Matched task selection with the demo's light-blue fill and blue hairline; node selection uses the narrow blue outline.
- Matched the no-stage form with a direct flat task list and the same selected-row treatment.
- Rebuilt “子 Issue”, “更多属性”, and “交付” as compact rows. “更多属性” opens by default and uses status, priority, tags, iteration, participants, requirement, and assignment rows instead of the previous pill block.
- Reduced “动态” to the demo's compact read-only section inside the Issue panel; the large empty state and sticky composer no longer dominate this surface.
- Preserved the separate neutral attachment footer.

**Interaction Verification**

- Current-stage selection is the default.
- Clicking another DAG node switches the lower stage panel and selected-node outline.
- Clicking the current node restores the current-stage panel.
- Stage advancement resets manual selection to the new current stage.
- Required deliverables render before stage tasks.
- The create-task action renders after the stage task list.
- Staged and non-staged Issue forms both remain operational.

**Automated Verification**

- Focused Vitest: `IssueWorkflowDag.test.tsx` and `TodoEditor.test.tsx`.
- TypeScript: `tsc --noEmit`.
- ESLint and Prettier passed for changed Wework files.
- Real desktop checkpoint: `project-automation` passed with real Tauri and backend requests.
- Desktop regression scrolls the taller demo-matched DAG before asserting task statuses and verifies node-selection linkage.

final result: passed
