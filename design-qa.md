# Smart Workbench Card Design QA

## Evidence

- Source visual truth:
  - Marketplace: `/Users/junlong5/.codex/attachments/eac378b1-df14-4f78-a237-47cee84467bb/image-3.png`
  - My workbenches: `/Users/junlong5/.codex/attachments/eac378b1-df14-4f78-a237-47cee84467bb/image-4.png`
- Rendered implementation:
  - Marketplace: `/Users/junlong5/Documents/ai3c_workspace/Wegent/wework/test-results/desktop-e2e/2026-08-22T03-31-44-835Z-23569/harness-apps-03-marketplace.png`
  - My workbenches: `/Users/junlong5/Documents/ai3c_workspace/Wegent/wework/test-results/ai-verify/2026-08-22T03-14-28-928Z-8807/owned-final.png`
  - My workbench action menu: `/Users/junlong5/Documents/ai3c_workspace/Wegent/wework/test-results/ai-verify/2026-08-22T03-14-28-928Z-8807/owned-actions-final.png`
- Combined comparison inputs:
  - `/Users/junlong5/Documents/ai3c_workspace/Wegent/wework/test-results/design-qa-smart-apps/marketplace-full-comparison.png`
  - `/Users/junlong5/Documents/ai3c_workspace/Wegent/wework/test-results/design-qa-smart-apps/marketplace-cards-comparison.png`
  - `/Users/junlong5/Documents/ai3c_workspace/Wegent/wework/test-results/design-qa-smart-apps/owned-full-comparison.png`
  - `/Users/junlong5/Documents/ai3c_workspace/Wegent/wework/test-results/design-qa-smart-apps/owned-cards-comparison.png`

## Viewport and state

- Source pixels: Marketplace `1586 x 992`; My workbenches `1584 x 993`.
- Automated desktop capture: `1280 x 720`, light theme, macOS Wework shell.
- Final manual Tauri capture: `2560 x 1440` Retina capture of a `1280 x 720` window.
- States checked: installable Marketplace card, running Marketplace card, imported/created My cards, model selector, publish/run/open actions, visibility state, overflow actions, and local removal entry.
- Full comparisons normalize each side to a common `1280 x 720` panel for one-input inspection. Dynamic catalog count and fixture icon differences are not treated as layout differences.

## Style details checked

- Card shell: two-column grid, compact `16px` radius, neutral hairline border, white surface, no decorative shadow.
- Marketplace card: approximately `208px` high with icon/title/source, two-line description, tags, visibility/status/version, model/size, and a right-aligned primary action.
- My card: approximately `256px` high with the same top grammar plus model/update/member metadata and management actions anchored at the bottom.
- Typography: existing Wework system font and text tokens; title, secondary copy, tags, and metadata preserve the source hierarchy and truncation behavior.
- Icons: real catalog icon when supplied; Circle Plus for `创建工作台`; Download for `导入工作台`; existing Lucide icons for visibility, status, version, run/open, and overflow.
- Controls: visibility is a compact outlined control; status colors remain semantic; destructive local removal is isolated in the overflow menu.
- Header and filters: `市场 / 我的` remain the only Smart Workbench section tabs; My owns the title, description, create/import actions, search, and segmented ownership filters.

## Product-copy decisions

- The explicit user instruction overrides the Marketplace reference copy: `智能工作台市场` and `发现官方工作台，以及成员定向分享给你的工作台。` are intentionally absent.
- The creation action is `创建工作台`, not `创建智能工作台`.
- The My action label is `管理范围`, matching the visibility-management intent.

## Findings and fixes

1. P1 card fidelity: production cards used a different information order and action density from the selected design.
   - Fix: both modes now share one card grammar while keeping their state-specific metadata and actions.
2. P1 content hierarchy: My previously rendered its page title inside the list section, which separated the create/import actions from the page identity.
   - Fix: My title and actions now occupy the top page header; the card section starts after the shared application-type and section navigation.
3. P2 card density: My cards briefly compressed below the reference management-card height.
   - Fix: My cards use a `256px` minimum height; Marketplace cards remain `208px`.
4. P2 icon and copy mismatch: the create action used the wrong icon and longer name.
   - Fix: it now uses Circle Plus and `创建工作台`.
5. P1 interaction regression coverage: the desktop scenario still searched for the old direct Stop buttons after Stop moved into overflow.
   - Fix: the scenario now opens the matching card action menu and selects Stop, including duplicate installation IDs by scoping to the running card.

## Final comparison

- Marketplace: card height, inner padding, information order, metadata grouping, and install/open action placement match the selected compact card direction. The surrounding page header intentionally follows the explicit copy-removal requirement rather than the reference title block.
- My: title/actions, card height, visibility/status/version row, model row, bottom actions, and overflow menu match the selected management-card direction.
- Responsive behavior: cards collapse to one column below the existing desktop breakpoint; header actions return to normal document flow below `md`, preventing overlap.
- Accessibility: native buttons/selects remain keyboard reachable, icon-only overflow controls retain accessible labels, focus styles are preserved, and destructive removal remains a labeled menu action followed by confirmation.
- No actionable P0, P1, or P2 visual differences remain.

## Verification

- `pnpm --filter wework typecheck`
- `pnpm --filter wework test src/pages/SmartAppsMarketplacePage.test.tsx src/components/sites/SitesWorkspace.test.tsx` — 32 tests passed.
- Focused ESLint and Prettier checks passed for the changed page, workspace shell, translations, tests, and desktop scenario.
- `pnpm --filter wework e2e:desktop -- --segment harness-apps` passed with no assertion errors. Evidence: `/Users/junlong5/Documents/ai3c_workspace/Wegent/wework/test-results/desktop-e2e/2026-08-22T03-31-44-835Z-23569/`.
- Final current-code Tauri visual evidence: `/Users/junlong5/Documents/ai3c_workspace/Wegent/wework/test-results/ai-verify/2026-08-22T03-14-28-928Z-8807/`.

## Installed state and package export follow-up

- The installed state now uses the semantic success token defined by the Wework design system: `#00A240` in light mode and `#40C977` in dark mode. This fixes the previously muted/gray installed label without introducing green product chrome.
- Created or locally imported workbenches expose `导出安装包` in the existing overflow menu. Marketplace packages installed from another owner do not expose this redistribution action.
- Export invokes the deterministic local package exporter, copies the resulting ZIP into the user's Downloads directory, and reports success or failure without removing the card.
- Current-code Tauri evidence after restarting the real desktop build so the Tailwind configuration was reloaded:
  - Installed success color and export menu: `/Users/junlong5/Documents/ai3c_workspace/Wegent/wework/test-results/ai-verify/2026-08-22T04-15-00-018Z-49727/owned-installed-green-export-menu.png`
  - Export confirmation: `/Users/junlong5/Documents/ai3c_workspace/Wegent/wework/test-results/ai-verify/2026-08-22T04-15-00-018Z-49727/owned-export-success.png`
  - Exported ZIP evidence: `/Users/junlong5/Documents/ai3c_workspace/Wegent/wework/test-results/ai-verify/2026-08-22T04-15-00-018Z-49727/exported-dsh-e2e-smoke-0.1.0.zip`
- Focused Vitest coverage passed: 12 tests across the page interaction and local export API. TypeScript, ESLint, and Prettier checks also passed.
- The complete `harness-apps` desktop E2E segment passed in `3m 4s`; evidence: `/Users/junlong5/Documents/ai3c_workspace/Wegent/wework/test-results/desktop-e2e/2026-08-22T03-57-25-039Z-38966/`.

## Smart Workbench detail-dialog follow-up

### Evidence

- Source baseline: `/var/folders/v7/cdzm7jt91951hnc_97lch7h40000gn/T/codex-clipboard-907fdcc0-19a4-47bd-a701-3ff63a999283.png`
- Final real-Tauri capture: `/Users/junlong5/Documents/ai3c_workspace/Wegent/wework/test-results/desktop-e2e/2026-08-22T04-34-05-147Z-62472/harness-apps-03-details.png`
- One-input before/after comparison: `/Users/junlong5/Documents/ai3c_workspace/Wegent/wework/test-results/design-qa-smart-app-details/detail-dialog-before-after.png`
- The source is a `2774 x 1738` Retina screenshot. The implementation is a `1280 x 720` automated desktop capture. Both were normalized to `1280 x 720` panels for the combined inspection.

### Findings and fixes

1. P1 content hierarchy: the source rendered Markdown as a dense text block, so headings, capability lists, and narrative copy were difficult to scan.
   - Fix: explicit semantic renderers now provide visible heading levels, list markers, paragraph rhythm, code styling, and blockquote treatment. A duplicated first heading matching the app title is removed.
2. P1 long-content behavior: the source allowed the whole dialog to become one tall surface, which could move identity and the primary action out of view.
   - Fix: the dialog is a bounded flex column with a fixed identity header, independently scrolling content, and a fixed action footer.
3. P2 metadata density: the source used one oversized gray strip with weak separation between scan status, package size, and update date.
   - Fix: the trust row is a compact three-part hairline group with semantic icons and success color reserved for the scan result.
4. P2 action balance: the source footer felt visually detached and oversized relative to the content.
   - Fix: the action now uses the shared small-button density in a bordered footer, with download, loading, and installed icons reflecting state.
5. Accessibility: the source lacked a labelled dialog relationship and predictable keyboard close behavior.
   - Fix: the dialog is labelled by its visible title, close receives initial focus, Escape and backdrop close are supported, and all new interactive surfaces retain visible focus treatment.

### Final comparison

- The final dialog preserves the existing neutral Wework system, icon asset, information, and install flow.
- The combined comparison confirms a clearer identity-to-trust-to-description-to-action reading order, visible Markdown list semantics, tighter spacing, and a stable footer.
- Responsive bounds use the existing desktop/mobile breakpoints; the bottom corners flatten only on narrow viewports where the dialog behaves as a bottom sheet.
- No actionable P0, P1, or P2 visual differences remain for the requested redesign.

### Verification

- Focused Vitest: `12` tests passed, including long Markdown structure, fixed regions, duplicate-heading removal, and Escape close.
- TypeScript, focused ESLint, and Prettier checks passed.
- `pnpm --filter wework e2e:desktop -- --segment harness-apps` passed with no assertion errors after exercising detail open, long Markdown rendering, fixed footer, Escape close, install, launch, stop, export, and removal paths.
- E2E evidence: `/Users/junlong5/Documents/ai3c_workspace/Wegent/wework/test-results/desktop-e2e/2026-08-22T04-34-05-147Z-62472/`.

final result: passed
