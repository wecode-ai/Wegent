# Workspace action sizing

- Transaction: tx-0a9e862a96f0; base A00000005.
- Intent: investigate the apparent mismatch between workspace Settings and New Project buttons and align their standard geometry.
- Affected stable ID: arch://wegent/ui/617dc728; shared UI arch://wegent/ui/287398da was read.
- State: source implementation and component geometry verified, not deployed or real-Electron confirmed.

The source used different button styles: platform secondary actions had a 34px minimum height, 9px radius and 15px icons; project creation had a 36px minimum height, 8px radius and 16px icons. The secondary style is used by the workspace settings action and one other standard platform action. Its geometry now matches the existing primary action dimensions. Width remains content-derived; project creation includes a second, trailing dropdown icon. No behavior, permission, API or translation changed.

Verification uses the actual ActionMenu trigger, Settings SVG, shared theme and current product styles in an isolated fixture. Desktop 1280px viewport measurements:

| Action | Height | Top | Width | Icon | Radius | Font | Weight |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Settings | 36px | 28px | 104px | 16px | 8px | 14px | 445 |
| New Project | 36px | 28px | 128px | 16px | 8px | 14px | 445 |

At 390px viewport, both action heights measure 44px. Wework typography guard and scoped diff whitespace checks passed. Product CSS bundled successfully for the preview. No additional unit tests or TypeScript checks were needed for this reversible stylesheet-only change; no E2E or ai:verify was run.

Artifacts: `/Users/hongyu9/.codex/visualizations/2026/10/14/01a1396f-5259-73a3-8676-25fae7740e09/workspace-actions/`.

Other open transactions were preserved. The modification is limited to the existing secondary-button height, radius and icon dimensions and has no semantic overlap with unread Issue handling or permission implementation work.
