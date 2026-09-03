# Applications layout design QA

## Comparison target

- Source visual truth:
  - My: `/Users/junlong5/.codex/generated_images/01a03d17-3e77-7ef2-a61b-ba2ab3de9a90/exec-72fff9de-aa43-4eb8-92ae-2765bf454277.png`
  - Market: `/Users/junlong5/.codex/generated_images/01a03d17-3e77-7ef2-a61b-ba2ab3de9a90/exec-46eee616-97d2-4f73-8cca-99ffd9a945c5.png`
  - Site: `/Users/junlong5/.codex/generated_images/01a03d17-3e77-7ef2-a61b-ba2ab3de9a90/exec-9be266aa-53d7-415f-be2f-dfd5709c5ba2.png`
  - Mini Program: `/Users/junlong5/.codex/generated_images/01a03d17-3e77-7ef2-a61b-ba2ab3de9a90/exec-f3bb0013-fcbe-4036-b20c-eb4a9bad8a13.png`
- Rendered implementation:
  - Market: `/Users/junlong5/Documents/ai3c_workspace/Wegent/wework/test-results/design-qa/market-iteration-1.png`
  - My empty: `/Users/junlong5/Documents/ai3c_workspace/Wegent/wework/test-results/design-qa/owned-iteration-1.png`
  - My with card: `/Users/junlong5/Documents/ai3c_workspace/Wegent/wework/test-results/design-qa/owned-card-iteration-1.png`
  - Site: `/Users/junlong5/Documents/ai3c_workspace/Wegent/wework/test-results/design-qa/site-iteration-1.png`
  - Mini Program: `/Users/junlong5/Documents/ai3c_workspace/Wegent/wework/test-results/design-qa/miniapp-iteration-1.png`

## Environment and normalization

- Runtime: isolated packaged Electron application, local-first mode, light theme, Chinese locale.
- CSS viewport: `1386 x 869`; implementation capture: `2772 x 1738`; `deviceScaleFactor: 2`.
- Source visuals: `1584 x 993`; conceptual desktop density `1`.
- Both sets use the same desktop aspect ratio. Comparisons were normalized by full-frame aspect ratio and application content bounds. Geometry findings use Electron CSS-pixel metrics, not raw image pixels.
- State: disconnected cloud marketplace, local owned collection, unavailable Site and Mini Program services.

## Full-view comparison evidence

The four source images and five Electron captures covering four application states were opened together in the same comparison input. The implementation preserves the selected visual hierarchy: constant Applications header, invariant primary tabs, one aligned context toolbar, matching neutral controls, and a shared bordered content surface.

Measured Electron geometry across Market, My, Site, and Mini Program:

- Shared content container: `1120px` wide.
- Context toolbar: `1056 x 36`, `left: 285`, `top: 242.8828125` in every state.
- Site and Mini Program unavailable surfaces: `1056 x 320`, `left: 285`, `top: 298.8828125`.
- Owned card: `520 x 211`; with the `16px` grid gap, two tracks resolve exactly to `(1056 - 16) / 2 = 520px`.

No horizontal or vertical layout shift was observed while switching all four states.

## Focused region comparison evidence

- Header and action slot: the My actions align with the title block and retain outline/primary hierarchy; Site and Mini Program use the same inverse-neutral Create control.
- Primary and secondary navigation: the application underline tabs remain fixed while Market/My use the selected segmented control treatment.
- Toolbar: search, marketplace selects, and owned filters share the same height, radius, border, and focus token.
- Empty states: Market, Site, and Mini Program share one 320px surface and icon/title/body rhythm, with state-specific copy.
- Card: the isolated created-workbench fixture confirms the target two-column width, 211px height, icon/title hierarchy, semantic status color, divider, model selector, and right-aligned action group.

## Findings

- No actionable P0, P1, or P2 differences remain.
- P3: the isolated My capture contains one created card rather than the two installed cards in the source. This is test-data variance; grid metrics and a rendered real card confirm the selected two-column geometry.

Required fidelity surfaces:

- Fonts and typography: existing Wework font stack, semantic sizes, weights, line heights, truncation, and wrapping match the source hierarchy.
- Spacing and layout rhythm: shared width, fixed toolbar position, 16px card gap, surface radius, borders, and vertical rhythm match the selected design.
- Colors and tokens: neutral application chrome, blue experimental badge/focus, and green semantic runtime state are correctly scoped.
- Image quality and assets: no raster product imagery is required; all visible symbols use the existing Lucide icon library and render sharply at `@2x`.
- Copy and content: constant Applications title/subtitle and state-specific marketplace/Site/Mini Program copy match the approved direction.
- Accessibility and responsiveness: semantic tabs and labels are retained, focus rings use shared tokens, desktop controls are 36px, and mobile variants remain at least 44px.

## Interaction and runtime checks

- Switched Market to My and back through the segmented navigation.
- Switched Smart Workbench, Site, and Mini Program through the primary tab list.
- Exercised the owned `Installed` zero-result filter and recovered with `All`.
- Created an isolated blank workbench and verified the resulting real card.
- Verified disconnected marketplace, Site unavailable, and Mini Program unavailable states.
- Electron debug snapshot reported `workbench.error: null` and no runtime logs.
- The isolated Electron session was stopped and the temporary fixture directory was moved to Trash.

## Comparison history

- Pass 1: compared all four valid post-build Electron captures with their source visuals. No P0/P1/P2 findings were identified, so no post-comparison visual fix iteration was required.
- A pre-build stale package capture was discarded as build troubleshooting and was not used as design-QA evidence.

## Implementation checklist

- [x] Constant header and 1120px application shell
- [x] Fixed primary tabs and header action slot
- [x] Shared 36px context toolbar in all four states
- [x] Segmented Market/My navigation
- [x] Equal two-column card geometry and aligned actions
- [x] State-specific unavailable copy and icons
- [x] Real Electron interaction, geometry, screenshot, and error verification

Applications result: passed

# Wework plugin sharing and enterprise publication design QA

## Comparison target

- Source visual truth:
  - Visibility scope: `/var/folders/v7/cdzm7jt91951hnc_97lch7h40000gn/T/codex-clipboard-54264685-bee1-4844-82d2-6f321df22e54.png`
  - Publication progress: `/var/folders/v7/cdzm7jt91951hnc_97lch7h40000gn/T/codex-clipboard-95f3ec07-c1bb-4888-b666-0db30e86cf7f.png`
  - Version and risk form: `/var/folders/v7/cdzm7jt91951hnc_97lch7h40000gn/T/codex-clipboard-00007236-6f37-4df7-8b8a-b1fd03f2cb55.png`
  - Plugin detail: `/var/folders/v7/cdzm7jt91951hnc_97lch7h40000gn/T/codex-clipboard-a853ac42-2c1e-47a1-9fd2-4a680c268a7c.png`
- Latest real implementation capture:
  - Electron run: `/Users/junlong5/Documents/ai3c_workspace/Wegent/wework/test-results/desktop-e2e/2026-08-29T04-15-24-805Z-52498`
  - Side-by-side comparison: `/Users/junlong5/Documents/ai3c_workspace/Wegent/wework/test-results/design-qa/plugin-publication-flow-comparison.png`
  - Ordered interaction sequence: `/Users/junlong5/Documents/ai3c_workspace/Wegent/wework/test-results/design-qa/plugin-publication-interaction-sequence.png`

## Environment and normalization

- Runtime: packaged Electron application with real backend requests and a fresh migrated database, macOS arm64, light theme, Chinese locale.
- CSS viewport: `1387 x 869`; capture: `2774 x 1738`; `deviceScaleFactor: 2`.
- Reference and implementation frames were opened together in one comparison input. Differences caused only by the real Task workspace background and E2E fixture content were not treated as component defects.

## Approved interaction sequence

1. A plugin created in a Task workspace is persisted as a personal plugin and exposes `分享` on the personal detail/result surface.
2. `分享与发布` contains exactly two intents: `指定成员或部门` and `全员可见`; the organization root is represented by the department selector rather than a third organization option. Every authenticated owner may submit the current personal plugin for enterprise-wide publication; there is no people allowlist or application-level publication switch.
3. Restricted sharing becomes effective after scanning and requires no administrator review.
4. Enterprise-wide publication opens the three-step drawer: `确认版本` -> `权限与风险` -> `确认提交`.
5. Final submission freezes the selected version as an immutable revision, runs automatic checks, and then enters administrator review.
6. The personal plugin remains usable and editable during review. Its detail surface shows a five-stage card: `提交申请` -> `自动检查` -> `管理员审核` -> `代码审核` -> `发布`.
7. `查看申请进度` opens the revision, SHA256, check results, history, refresh, and context-appropriate withdrawal/action controls.
8. Administrator approval is handled in the Web admin queue; acceptance creates or advances the Draft GitLab MR. Protected `master` remains the only release source, and its pipeline calls the internal release endpoint through a scoped release key.

## Detail-page continuity

- Personal detail preserves the existing task examples, Share action, overflow actions, install/chat action by state, automatic-update setting, application authorization, capability list, and information sections.
- Owner-only actions remain in the overflow menu: continue editing, uninstall, and delete. Deleting a personal plugin with an active enterprise request requires withdrawing or closing that request first.
- Submitted enterprise publication adds progress visibility without replacing the existing detail flow.

## Visual findings

- The latest scope dialog matches the approved neutral modal treatment and selection hierarchy, and explicitly shows `自动检查 -> 管理员审核 -> 代码审核 -> 发布`.
- The three-step drawer preserves the selected right-side panel, step indicator, bottom action bar, form density, and read-only final review treatment.
- The personal detail removes duplicate source metadata and places the five-stage status card between existing task examples and capability content.
- The progress drawer preserves the implementation's information density while using the approved status hierarchy and real check-result content.
- No actionable P0, P1, or P2 visual differences remain on the desktop submission and progress path.

## Verification evidence

- Packaged Electron E2E, `plugin-workspace-publication`: passed in 52 seconds with real backend requests and no publication-switch, allowlist, or marketplace-capability endpoint.
- Post-cleanup regression: 124 focused backend tests, 233 Wework plugin/publication tests, 17 Web-admin tests, and 8 Executor publication tests passed; Backend Ruff, Wework/Frontend type checks and lint, Rust formatting, locale JSON parsing, and `git diff --check` also passed.
- Backend publication, marketplace, configuration, internal-release, and HTTP-contract coverage: 142 focused tests passed, including ordinary-user request creation, owner isolation, submitter-row locking, terminal-request reactivation, and the active-request capacity boundary.
- Real MySQL/InnoDB two-connection validation passed for concurrent new submissions, concurrent terminal-request reactivation, and the create-versus-complete lock order: each capacity-one scenario admitted exactly one active request and rejected the other with `429`, while both lock-order transactions committed without a deadlock.
- Latest changed Wework publication suites: 152 tests passed; TypeScript type-check and the packaged Electron build also passed.
- Wework HTTP and adapter regression suites: 44 tests passed after removing the obsolete capability request.
- FastAPI route inspection confirmed `/api/plugins/capabilities` is absent and `/api/plugins/publication-requests` remains registered.
- Wework lint for every changed publication file passed with no errors.
- Web admin publication queue/review APIs and components are covered by focused frontend tests; the desktop visual comparison does not claim a live Web-admin screenshot.
- Focused Web-admin publication API, queue, review drawer, marketplace integration, and i18n coverage: 17 Jest tests passed.
- Plugin repository CI contract and publisher coverage: 40 tests and 5 subtests passed; 3 native-Windows checks were skipped on macOS.

## Release-readiness boundary

- Local implementation and documentation are complete on `feature/wework-plugin-publication`; no commit, push, merge request, remote pipeline, deployment, or production publication was performed.
- There is no application-level publication switch to turn on after deployment. Protected GitLab branches/environments, macOS and Windows runners, CI variables and TLS connectivity, release-key provisioning, historical token rotation, and a migration/rollback drill must therefore be completed before the coordinated production deployment.
- Native Windows compatibility remains a release gate; a portable macOS-hosted check cannot substitute for a real Windows runner.

final result: passed
