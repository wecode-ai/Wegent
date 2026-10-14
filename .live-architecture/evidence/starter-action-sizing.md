# Workspace starter action sizing

- Transaction: tx-f43d9c444a01; base A00000006.
- Human intent: inspect and align the New Project, Configure Agents and Invite Members action group.
- Affected stable ID: arch://wegent/ui/617dc728; read shared UI arch://wegent/ui/287398da.
- State: source and component geometry verified; not deployed or confirmed in real Electron.

Before: primary project creation had a 36px desktop minimum height, while the other two controls used a local 32px rule. The flex container stretched both direct secondary buttons to match the menu wrapper in a single desktop row, so the measured desktop heights were already 36px. On a 390px viewport with the complete product stylesheet, New Project and Configure Agents measured 44px on the first row, while wrapped Invite Members measured 32px. This was a real sizing inconsistency exposed by wrapping, not a font difference.

Fix: reuse the standard platform secondary button class for both controls; delete the custom 32px rule; center controls within the wrapping row; apply the existing 44px mobile rule to all starter actions. Primary/secondary emphasis and content-derived widths are retained. Navigation callbacks, selectors, permissions and APIs are unchanged. Other existing source changes were preserved.

Component inspection with the actual ActionMenu, icons, theme and complete shared product stylesheet:

| Action | Desktop height | Desktop top | Radius | Font / weight | Mobile height |
| --- | --- | --- | --- | --- | --- |
| New Project | 36px | 157px | 8px | 14px / 445 | 44px |
| Configure Agents | 36px | 157px | 8px | 14px / 445 | 44px |
| Invite Members | 36px | 157px | 8px | 14px / 445 | 44px |

Three existing targeted interaction tests passed: first-space onboarding navigation (including configure/invite), local-space invitation exclusion, and the empty-local-space project creation menu. The runner filtered to these cases; the remainder of that test file was not run. Shared collaboration TypeScript build, Wework typography guard, product CSS preview bundling and scoped diff whitespace checks passed. No new tests that merely assert class names were added.

Preview artifacts: `/Users/hongyu9/.codex/visualizations/2026/10/14/01a1396f-5259-73a3-8676-25fae7740e09/starter-actions/`. These are isolated component fixtures, not E2E or real Electron runs. E2E and ai:verify were not run per repository policy.
