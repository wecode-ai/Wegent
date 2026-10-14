# Issue metadata popover redesign

- Date: 2026-10-14
- Transaction: tx-7fd37a0703f6; base A00000003.
- Human intent: align the Issue ellipsis / more-properties surface with the overall UI, especially its typography.
- Affected IDs: arch://wegent/ui/aab71205 and arch://wegent/test/aab71206. Shared UI arch://wegent/ui/287398da is a read dependency.
- State: implemented and statically/test verified; not deployed or confirmed in real Electron.

## Implementation and boundaries

The metadata editor is a portaled surface. The old workspace-layout font and density selectors did not apply outside that ancestry, leaving medium-weight RailProp defaults. The popover now owns its accessible heading, scoped system font, regular-weight fields, compact aligned rows, standard ellipsis icon, non-overlapping participant targets, neutral links and elevation, viewport constraints, and mobile touch targets. Styles moved out of the large task-layout stylesheet into the owning component stylesheet; obsolete heading declarations were removed.

Priority/tag/collaborator/assignment state and permission guards remain in SharedIssueDetailEditor. No CP invariant, API, schema or execution behavior changed. Existing unrelated working-tree modifications, including the other open architecture transaction, were preserved.

## Verification

Commands ran against the combined working tree:

- `pnpm --filter @wegent/collaboration test src/issue-detail/IssuePropertiesPopover.test.tsx src/issue-detail/IssueDetailControls.test.tsx --maxWorkers=1`: 4 passed.
- `pnpm --filter wework test src/features/todo/TodoEditor.test.tsx`: 60 passed.
- Shared collaboration TypeScript build, Wework typecheck, frontend `tsc --noEmit`: passed.
- ESLint checked popup, popup tests, TagEditor and TodoEditor tests: passed, no ignored files.
- Prettier checks on new popup source/style/tests and updated TodoEditor tests, focused diff whitespace checks, and Wework typography guard: passed.

The tests cover scoped theme/font-size propagation, accessible dialog heading, Escape blur before unmount and asynchronous Radix focus return, actual tag draft persistence, read-only metadata, priority/tag saves, collaborator additions, archive/delete behavior and outside-click dismissal. The initial focus assertion used a synchronous check before Radix's documented asynchronous unmount focus lifecycle; it was corrected to wait for that lifecycle, without relaxing the assertion or altering production behavior.

## Component visual inspection

Isolated browser fixture using the actual IssuePropertiesPopover, TagEditor, theme and product CSS, with sample metadata markup and a simplified surrounding panel. This is a component preview, not an end-to-end or real Electron run. Preview artifacts live outside the repository:

`/Users/hongyu9/.codex/visualizations/2026/10/14/01a1396f-5259-73a3-8676-25fae7740e09/issue-properties/`

- Light and dark surfaces inspected.
- Default typography: heading 14px / 500; fields and tag input 13px / 400; system font stack.
- At UI font setting 16, field token scales to 15px.
- 390px viewport with long Chinese/English tag: document width 390px, popup width 280px, horizontal scrollWidth equals clientWidth (278px), participant/tag removal targets at least 44 by 44px.
- E2E and ai:verify were not run, following the repository execution policy.

The full-editor standalone preview initially could not bundle unrelated file-viewer Node dependencies. The component fixture was narrowed to the changed popup and tag components, without changes to production dependencies or claims about application integration.
