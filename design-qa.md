# Design QA

**Source visual truth**

- Edit project: `/Users/axb-mac/.wegent-executor/workspace/attachments/draft/1784873788814/image.png`
- Project picker: `/Users/axb-mac/.wegent-executor/workspace/attachments/draft/1784873491209/image.png`
- Create project: `/Users/axb-mac/.wegent-executor/workspace/attachments/draft/1784876851519/image.png`

**Implementation evidence**

- Create dialog: `wework/test-results/ai-verify/final-01-create-project-dialog.png`
- Edit dialog with two roots: `wework/test-results/ai-verify/final-02-edit-project-dialog.png`
- Primary-root change: `wework/test-results/ai-verify/final-03-primary-changed.png`
- Saved project: `wework/test-results/ai-verify/final-04-edit-saved.png`
- Single-row project picker: `wework/test-results/ai-verify/final-05-project-picker-single-row.png`
- Local/cloud source dialog: `wework/test-results/ai-verify/final-06-source-dialog.png`
- Create form after folder selection: `wework/test-results/ai-verify/final-07-create-project-form.png`
- Create form with two roots: `wework/test-results/ai-verify/final-08-create-project-multi-root.png`
- Created project: `wework/test-results/ai-verify/final-09-project-created.png`
- Edit comparison: `wework/test-results/ai-verify/review/edit-comparison.png`
- Picker comparison: `wework/test-results/ai-verify/review/picker-comparison.png`
- Create comparison: `wework/test-results/ai-verify/review/create-comparison.png`

**Viewport and normalization**

- Implementation viewport and capture: 2560 × 1440 pixels, desktop Wework Tauri window, light theme.
- Edit source: 1238 × 880 pixels; normalized to fit within 1000 × 700. The implementation dialog was cropped from the full viewport to 1200 × 760 and normalized to fit within 1000 × 700.
- Picker source: 518 × 396 pixels; normalized to fit within 700 × 540. The implementation picker was cropped from the full viewport to 760 × 620 and normalized to fit within 700 × 540.
- Create source: 1112 × 666 pixels; normalized to fit within 1000 × 650. The implementation form was cropped from the full viewport to 1200 × 820 and normalized to fit within 1000 × 650.
- The comparison judges component geometry and hierarchy after density normalization; surrounding desktop content is intentionally excluded.

**State**

- Local Codex mode with a two-folder project.
- Edit dialog shows both roots, the primary marker, make-primary action, remove actions, add-folder action, rename input, delete, cancel, and save.
- Project picker shows one project row with only the primary folder as secondary context; it does not expand every source folder.

**Full-view comparison evidence**

- The centered modal, dimmed overlay, rounded frame, input treatment, folder-list grouping, destructive action, and footer action hierarchy match the supplied edit-project reference.
- The project picker keeps the supplied search/list visual hierarchy while representing the multi-root project as one row, as requested.

**Focused region comparison evidence**

- `edit-comparison.png` verifies the input, source-folder rows, primary controls, add-folder row, and footer actions at readable scale.
- `picker-comparison.png` verifies the search field, folder icon, project name, muted primary-folder label, selection mark, divider, and create actions at readable scale.
- `create-comparison.png` verifies the title, name input, source-folder list, remove and add-folder actions, and create/cancel footer at readable scale.

**Required fidelity surfaces**

- Fonts and typography: existing Wework typography tokens preserve the source hierarchy and readable optical weights; truncation is limited to the narrow project picker row.
- Spacing and layout rhythm: modal padding, row heights, borders, radii, overlay, and footer alignment are consistent with the references and existing Wework components.
- Colors and visual tokens: implementation uses Wework semantic tokens for surfaces, borders, muted text, destructive actions, and the primary button.
- Image and asset fidelity: no raster product assets are required; icons use the repository's existing Lucide icon system.
- Copy and content: Chinese copy is localized and accurately describes local/cloud creation and multi-folder editing.

**Findings**

- No actionable P0, P1, or P2 visual differences remain.

**Primary interactions tested**

- Open the centered create-project dialog.
- Choose Local project without an intermediate new/existing split.
- Select a folder, enter the create-project form, add a second source folder, name the project, and confirm creation.
- Open Edit project from the project menu.
- Add a second source folder.
- Rename the project.
- Change the primary folder.
- Save and confirm the project name persists.
- Open the project picker and confirm the project remains a single row showing only the primary-folder context.

**Console and runtime errors**

- The verified interaction chain completed without a UI error state. Tauri and executor logs were checked for errors related to project creation, update, or rendering; none were found.

**Comparison history**

- Initial implementation comparison: no P0/P1/P2 findings; no corrective visual iteration was required.
- Follow-up create-flow comparison: removed the separate new-folder/existing-folder actions and added the post-selection create form requested in the second reference. The revised `create-comparison.png` has no P0/P1/P2 findings.

---

# Plugin Marketplace Fidelity QA

## Source visual truth

- Interactive design: `/Users/md/Desktop/Wework-插件市场/wework-assistant-plugin-codex-demo.html`
- UI specification: `/Users/md/Desktop/Wework-插件市场/wework-plugin-market-ui-development-spec.md`
- Marketplace: `/Users/md/.codex/visualizations/2026/07/30/019fb297-cb7b-77f3-b396-71b85be63d98/plugin-ui-audit/01-demo-market.png`
- GitHub detail: `/Users/md/.codex/visualizations/2026/07/30/019fb297-cb7b-77f3-b396-71b85be63d98/plugin-ui-audit/02-demo-detail.png`
- Plugin management: `/Users/md/.codex/visualizations/2026/07/30/019fb297-cb7b-77f3-b396-71b85be63d98/plugin-ui-audit/03-demo-management.png`
- Add-market dialog: `/Users/md/.codex/visualizations/2026/07/30/019fb297-cb7b-77f3-b396-71b85be63d98/plugin-ui-audit/10-demo-add-market.png`

## Implementation evidence

- Marketplace: `wework/test-results/ai-verify/plugin-market-fidelity/01-market-after.png`
- Add-market dialog: `wework/test-results/ai-verify/plugin-market-fidelity/02-add-market-after.png`
- GitHub detail: `wework/test-results/ai-verify/plugin-market-fidelity/03-github-detail-after.png`
- Plugin management: `wework/test-results/ai-verify/plugin-market-fidelity/04-management-after.png`
- Marketplace comparison: `wework/test-results/ai-verify/plugin-market-fidelity/compare-market-final.png`
- Detail comparison: `wework/test-results/ai-verify/plugin-market-fidelity/compare-detail-final.png`
- Management comparison: `wework/test-results/ai-verify/plugin-market-fidelity/compare-management-final.png`
- Add-market comparison: `wework/test-results/ai-verify/plugin-market-fidelity/compare-add-market-final.png`

## Viewport and state

- Every source and implementation capture is 1280 × 720 pixels in the light desktop layout.
- Implementation captures come from an isolated real Tauri session on `feature/wework-marketplace`.
- The source uses fixed demo plugin data. The implementation uses the real isolated Codex catalog and installed-plugin state, so plugin names, counts, descriptions, and available prompt templates are intentionally data-dependent.
- GitHub is installed in the implementation state. Its market card, detail primary action, version, and management row were compared as the same installed lifecycle state.

## Required fidelity surfaces

- Typography, card geometry, section spacing, borders, radii, controls, and two-column density match the reference at the shared viewport.
- The installed-plugin strip now uses the reference 38px control and 34px logo density.
- GitHub uses the same brand asset in the marketplace, detail, and management views.
- Repository revision hashes are removed from displayed plugin versions while semantic prerelease versions remain unchanged.
- The add-market dialog matches the reference 600px frame, 18px radius, separated header/body/footer, three fields, textarea treatment, overlay, and disabled primary action.
- The dialog has a named modal role, initial focus, focus containment, Escape dismissal, focus restoration, immediate field-level source validation, and stable test IDs.

## Findings

- No actionable P0, P1, or P2 visual differences remain.
- P3: the implementation retains the existing marketplace refresh icon because it is an active product recovery control; the demo omits it.
- P3: the repository desktop shell sidebar is 240px while the demo shell is 251px. Plugin-page internal spacing and component geometry align after that inherited shell offset.
- Accepted data constraint: the real GitHub catalog currently supplies one prompt template and no demo-only simulated authorization row, while the source fixture supplies three templates and a mock GitHub App authorization. The responsive three-column template and authorization components remain available when those fields exist.

## Primary interactions tested

- Open the plugin marketplace and confirm the installed strip and catalog render.
- Open the installed GitHub card and confirm the detail page shows the GitHub logo, normalized version, action menu, and `立即试用` rather than an install action.
- Open Add marketplace from the Create menu.
- Confirm an invalid source shows a field-level error and keeps the submit action disabled.
- Recover with the valid `openai/plugins` shorthand.
- Close the dialog with Escape and return to the marketplace.
- Open plugin management and confirm the installed rows, brand icons, toggles, trial actions, and menus render.

## Verification

- Full Wework test suite: 225 files passed, 2228 tests passed.
- Focused plugin tests after the final iteration: 2 files passed, 35 tests passed.
- TypeScript project check passed.
- Focused ESLint check passed.
- Real Tauri visual and interaction verification passed.
- No frontend render or Tauri process error occurred. The isolated executor recorded one remote GitHub plugin-detail lookup returning 404; the installed/catalog data still rendered correctly, and this external lookup did not affect the verified UI states.

**Final result:** passed

**Implementation checklist**

- [x] Centered local/cloud create-project dialog.
- [x] One local action group for creating or choosing folders.
- [x] Multi-folder local Codex persistence.
- [x] Single-row project representation.
- [x] Edit, rename, add, remove, reorder primary, save, and delete controls.
- [x] Real desktop interaction verification and screenshot chain.

final result: passed
