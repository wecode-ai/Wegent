# Wework contributor guide

This directory implements the Wework desktop workbench: Electron, Vite, React, TypeScript, and the local coding runtime. Follow the repository-wide rules in `../AGENTS.md` first.

## Wework product model

Wework is a desktop workbench for organizing work and running AI coding agents.

Its main product areas are:

- **Tasks**: standalone work items that can start and continue AI coding sessions.
- **Project spaces**: business workspaces containing boards, project tasks, comments, agents, automation, and execution history.
- **Local project spaces**: stored locally and executed by local executors.
- **Cloud project spaces**: stored in the backend and accessible across devices; their AI work can run on either local or cloud executors.
- **Code workspaces**: device-owned source directories used by executions. A project space and a code workspace are related but are not the same object.
- **Executions**: individual AI runs started from tasks, project tasks, comments, or automation.
- **Sessions**: persistent Codex conversations associated with executions and continued by follow-up comments.

Do not treat task ownership, project-space storage, code-workspace location, executor location, and session lifecycle as the same dimension.

Before changing a Wework flow, identify the affected product area and trace its source object, storage owner, workspace, executor, and session lifecycle. If the requested behavior does not make these boundaries clear, ask the user before implementation.

## Startup availability and fault isolation

Opening Wework is a primary availability requirement. Application-managed failures
must leave an operable window available, including after a restart. Data corruption,
the risk of irreversible data loss, missing or unreadable credentials, failed
authentication, incompatible versions, damaged release history, and failed updates
or migrations do not justify refusing to open the entire application.

- Separate opening the interface from enabling a capability or modifying data.
  Keep unaffected workbench features usable. If the core runtime cannot load,
  open an independent recovery interface that does not require that runtime,
  its database, credentials, or a cloud connection.
- Keep data integrity and permission protections at the operation they guard.
  Refuse unsafe writes, migrations, restores, credential access, or unauthorized
  requests; isolate the affected data or capability while the application stays
  open. Never weaken permission invariants or security assertions to satisfy
  startup availability.
- Missing credentials disable only the capabilities that require them and must
  leave a sign-in or repair entry accessible. Never clear credentials, reset user
  state, overwrite damaged data, or restore a snapshot automatically just to make
  startup succeed.
- Remove unnecessary startup checks and dependencies. Optional services,
  maintenance, diagnostics, preference persistence, update bookkeeping, and one
  page's initial requests must not gate opening the workbench. Handle failures in
  their owning feature with an actionable retry or repair entry.
- For every retained rejection, identify the exact operation being refused and
  substantiate its concrete data or permission consequence from code or evidence.
  A version mismatch or hypothetical risk alone is not grounds for an application
  exit, an endless splash, or a restart loop.
- Do not hide defects by swallowing errors or reporting failed components as
  ready. Preserve truthful feature status and useful diagnostics. Reuse the
  existing recovery mechanisms, fix the primary flow, and remove obsolete paths.
- Cover failure isolation as well as successful startup: the window remains
  usable, unaffected features remain available, unsafe operations stay blocked,
  original data and credentials remain intact, and retry and subsequent launch
  can recover after the cause is repaired. Follow the repository's test execution
  policy; a visible recovery window is not proof that the normal runtime is ready.

## UI and component rules

- Before changing Wework UI or interaction behavior, read and follow [`DESIGN.md`](DESIGN.md). It is the source of truth for product-level visual, interaction, accessibility, and responsive-design decisions.
- Follow the shared [page data loading and error isolation rules](../frontend/AGENTS.md#page-data-loading-and-error-isolation), including for `packages/collaboration/`: active pages own their requests; unrelated pages never share a blocking loading or failure boundary.
- Mobile is `<=767px`, tablet `768px–1023px`, desktop `>=1024px`. Split mobile and desktop components when layout or interaction differs materially; otherwise use responsive classes. Mobile controls must be at least `44px × 44px`.
- Follow the Codex-derived, neutral-first visual system in `DESIGN.md`: grayscale surfaces, `14px` default desktop UI text, sparse hairlines and shadows, inverse-neutral primary actions, and blue only for focus, links, or narrow selection accents. Green and teal are restricted to semantic success/addition states and must never define product chrome or default actions.
- Use the Codex component density documented in `DESIGN.md`: `30px` sidebar rows, `28px` app-shell tabs and composer actions, `16px` standard desktop icons, and `4px–8px` action-group gaps. Reuse the shared component's established size instead of inventing a local height.
- Use the shared typography scale and semantic `heading-*`, `text-chat`, and `text-code` roles. Never add arbitrary `text-[Npx]`, literal CSS `font-size`, or literal inline `fontSize` values; `pnpm lint` enforces this rule.
- Custom Markdown renderers must preserve semantic attributes supplied by the parser, such as an ordered list's `start` value.
- Preserve platform text-navigation semantics in the ProseMirror chat composer. Register only composer-specific key bindings instead of the document-level `baseKeymap`, and scope mention caret workarounds to unmodified arrow keys.
- Focus popup composers through their exact editor target; a mixed `querySelector` returns the first matching element in DOM order, not the first selector in the list. In WKWebView, keep a completely empty contenteditable position native instead of replacing it with a decoration widget so programmatic focus can start the platform text input session.
- Always keep task model selector controls mounted, including initial catalog loading, refresh failures, empty catalogs, and deleted task models. Model readiness may block sending but must never hide the recovery entry.
- In project-board hover conversations, handle self-contained actions such as sending, retrying, answering runtime input, and loading or reverting diffs inside the popup. Actions that require workbench UI, including opening files, skills, reviews, plans, or switching the retry model, must navigate to the bound Runtime task. Never render an enabled conversation action without a real handler.

## Native application menu

The Electron host declares the native application menu
(`electron/src/host/application-menu.ts`) and the renderer executes the actions
it dispatches (`src/desktop/applicationMenu.ts` and
`src/desktop/ApplicationMenuWorkspaceBridge.tsx`). When adding menu items:

- Prefer attaching a new product action to an existing top-level menu
  (`application`, `file`, `work`, `edit`, `view`, `window`, `help`); do not add a
  new top-level menu without discussing it first.
- Reuse an action the UI already has. Menu items must call the same handler or
  command as the existing control, never a second navigation or state path.
- Only add menu items that are unambiguous and useful in every state, or that
  declare a capability so they hide when unavailable. A menu item that looks
  enabled but does nothing is a defect, not a fallback.
- The host owns item ids, labels, and menu structure. Actions and capabilities
  are declared in both `src/desktop/applicationMenuModel.ts` (renderer) and
  `electron/src/host/application-menu.ts` (host); a contract test fails when
  those two declarations drift, and the `application-menu` E2E checkpoint fails
  when an item id disappears.
- Declaring a capability is a promise that some code reports it. Only declare a
  capability when the renderer actually reports it for the focused window, and
  cover the item becoming _visible_ in the E2E checkpoint. An item whose
  capability is never reported is a permanently hidden dead entry, which the
  contract test cannot detect.
- Hiding an item does not disable its accelerator: Electron still fires a
  `visible: false` item whose accelerator is pressed. Never rely on the hidden
  state to block an action — the renderer handler must guard itself against the
  state where the action is not available.
- Cover a new item in the `application-menu` desktop E2E checkpoint: assert it
  exists, that its visibility matches the capability matrix, and that activating
  it performs its action.

This is a recommendation, not a requirement: a feature that only makes sense
inside its own surface can stay without a menu entry.

## i18n

- Use the local `@/hooks/useTranslation` wrapper for new Wework code.
- Add new copy to the appropriate Wework namespace in both `src/i18n/locales/en/` and `src/i18n/locales/zh-CN/`; register a new namespace in `src/i18n/index.ts`.

## User-facing navigation documentation

- When adding, removing, renaming or moving a user-facing entry, update `docs/{zh,en}/wework/interface-navigation.md` and its owning usage guide in the same change. Record the visible starting region, click path, purpose and visibility conditions; do not substitute an internal route or test selector for user instructions.
- Review all affected surfaces: top tabs, sidebar, account/native menus, composer, project/Issue menus, right workspace, bottom panel and settings. Registered settings/sidebar entries have automatic coverage; controls outside those registries, nested controls, dynamic plugin entries and permissions-dependent paths still require explicit review against actual code and existing verification evidence.
- Each `*Page.tsx` under `wework/src` and `packages/collaboration/src` must have one owning topic in both languages, declared with `<!-- ui-source: src/... -->` or `<!-- ui-source: ../packages/collaboration/src/... -->` in that topic. Keep source ownership identical across languages. The contract checks literal JSX field labels and General's literal helper labels against visible documentation; metadata alone does not count. Update the topic's purpose, visible path, action steps, activation/save behavior and restrictions when changing a field. Page ownership and literal-label coverage do not prove dynamic menus, delegated forms or all behaviors are documented: review non-Page first-party operation groups too, including shared collaboration UI, Applications, notifications, delivery, drag/stash, memory and conditional project-lead controls. Do not exclude an entry merely because it is experimental or permission-dependent. Keep the navigation page as links to topic sections, not a second copy of the procedures, and remove obsolete paths instead of appending competing instructions.
- Run `pnpm --filter wework test scripts/wework-navigation-docs.test.mjs scripts/bundled-wework-docs.test.mjs` for navigation documentation changes. The existing Lint workflow's settings-configuration job runs them even for docs-only PRs; keep the index linked from both language READMEs and the bundled skill. Update maintained docs, not generated or installed `references/` copies. Do not claim a running UI was verified from a static documentation check.

## Testing

- Before modifying code, locate and understand the tests and E2E coverage for
  the affected behavior, including its scenarios, fixtures, assertions, and
  desktop runner or checkpoint integration. Use that understanding to preserve
  existing coverage and determine the verification required by the change.

Run focused tests before committing:

```bash
pnpm --filter wework test
pnpm --filter wework test <test-file>
pnpm --filter wework exec prettier --check <changed-files>
pnpm --filter wework exec eslint <changed-files>
```

- Pass Vitest file paths and filters directly after `test`. The test runner
  also removes one leading `--` for compatibility with generated commands, so
  both `pnpm --filter wework test <test-file>` and
  `pnpm --filter wework test -- <test-file>` remain focused. When running a
  focused test, confirm the initial collection output matches the requested
  files and stop the run immediately if it starts collecting unrelated tests.

E2E tests use real backend requests. Do not skip, silently fail, or replace a failing integration with frontend mocks.

- Design verification cases as a QA test plan before running them. For every changed behavior, cover the preconditions, environment and test data, exact steps, expected results, negative and recovery paths, and cleanup. Record the actual result and retain reproducible evidence for failures and critical-path success.
- Changes to a core user flow must add or update automated E2E regression coverage in the same change. Treat task creation and launch, agent interaction, local-runtime lifecycle, permissions, and failure recovery as core flows when they are affected.
- Add Wework E2E regression cases under `e2e/desktop/` and integrate them with the existing desktop runner so the GitHub desktop E2E jobs execute them. Do not place desktop regressions behind standalone local-only entry points.
- Keep `no-undef` enabled for desktop E2E JavaScript. Declare supported Node/browser globals in the central ESLint configuration; do not suppress missing local references when refactoring checkpoint helpers.
- Reuse the existing `e2e:desktop` command and its established CI variants. Do not add a package script or GitHub Actions command for each scenario; extend the desktop runner or its scenario discovery instead. Add a new command only when the test requires a genuinely different CI environment or job boundary.
- Register long main-runner sections in the ordered desktop checkpoint list. `--segment <checkpoint>` must run that checkpoint alone after common bootstrap; `--from-segment <checkpoint>` must run it and every later checkpoint. Each checkpoint must create its own minimal fixtures when an earlier checkpoint is skipped, and must never silently rely on task IDs, model state, or UI state produced only by a previous checkpoint.
- Ordinary desktop E2E UI actions and waits use the shared 10-second step timeout. Pass an explicit `timeoutMs` only for a genuinely slow operation such as application startup, workbench reconnection, or a deliberately held model response; do not restore a broad 120-second default.
- Synchronize with the product state that gates an action or assertion: wait for an enabled submit action before keyboard submission, and for the refreshed owner surface after saving. A mounted composer or visible sidebar does not prove that model selection or page data is ready. Tool fixtures must assert the real operation's success, rather than accepting a filename echoed by a failed command.
- Never use a fixed `sleep`, `delay`, or `setTimeout` as proof that a UI update has completed. Reuse `waitFor`, `clickWhenEnabled`, `waitForSnapshot`, and existing layout or runtime wait helpers to observe the exact prerequisite, then verify the action's business result. Re-query stable product selectors on each check; do not reuse detached elements or stale coordinates. Use `stableMs` only when a condition must remain true for an observation window; it does not prove that geometry or asynchronous work has settled.
- Keep bounded polling intervals, deliberate fixture timing, timer tests, and negative observation windows that verify an event does not occur. Do not replace those windows with an immediately passing absence check. Diagnose each suspected UI sleep with reproducible logs before changing an existing E2E: retain the expected condition, observed state, and action sequence; distinguish a premature test action from a product update defect. Do not increase global timeouts, repeat submissions, rerun tests, or weaken assertions to hide a race.
- In virtualized content, do not rely on test-added DOM attributes across scrolling or rendering updates. Locate the element with stable product selectors and text first, wait for layout to settle, then add any temporary marker needed by later assertions.
- E2E coverage complements, but never replaces, verification in the real Electron application.

## Upgrade and rollback maintenance contract

- Release-gate exception: macOS x64 adopts successful macOS arm64 paths and minimum source versions instead of running release-pair E2E. Preserve x64 package identities, require matching source revisions at both ends, and record arm64 hashes under `verification.kind=architecture-equivalence`. Keep independent Windows x64 release verification. Ordinary PRs do not run packaged upgrade E2E.

- Extend the existing Electron/component manifests with optional upgrade policy fields; preserve legacy fields and endpoints. Legacy clients continue upgrading directly to the advertised latest version. Verified-path enforcement starts once a client contains the new updater; do not pin the legacy channel to a bridge or claim that new fields constrain old clients. Do not introduce a parallel update discovery protocol.
- Each target release declares its minimum source version. A verified A-to-D pair covers published sources in [A, D) within the same platform, architecture, and channel catalog, subject to the target minimum. These intermediate direct upgrades are accepted without separate pair verification; retain only actual pair evidence rather than generating synthetic verified edges. Unknown sources are ineligible. Revoked targets, witness edges, and witness source releases cannot authorize inferred upgrades; an explicitly revoked source-to-target pair overrides interval coverage. An installed revoked source may still leave through its own non-revoked verified pair. Use the same interval policy for discovery and installation revalidation.
- Prepare the next release in an isolated slot while the current release remains usable. Do not show restart readiness before extraction, integrity checks, and target-owned runtime/profile preparation finish. Keep mutable application data separate from versioned program files.
- Deliver high file-count bundled components as archives bound to both archive and complete content hashes. The target owns materialization before restart readiness; component publication must verify and reuse the exact sealed archive bytes. Keep archive caches outside signed package resources.
- Switch the complete host and component set through one atomic release selection. An independent launcher must supervise activation; only both runtime and renderer readiness confirm health. Preserve the previous healthy release and prevent automatic rollback loops.
- Take consistent migration-data snapshots only after writers stop. Compatible rollback may switch directly; incompatible rollback requires explicit confirmation before restoring a snapshot and must preserve the failed release's newer data. Never restore user repositories, cloud records, or personal agent credentials.
- Preserve active Goal recovery journals when the executor or app-server stops. A previous turn's completed outcome does not complete its still-active Goal; neither an exit notification nor a closed stream may finalize that Goal using the older outcome.
- Maintain three layers of verification: pure policy/transaction tests, reusable real-package upgrade/rollback scenarios, and a release-edge matrix. Keep scenario behavior independent of version numbers: add a source/target pair to matrix data instead of copying a test for every release.
- Select credential acceptance from the actual delivered host's native storage metadata and observed format, never from a version range. A format-preserving v2 pair must prove upgrade, authenticated writes after rollback, and preserved quarantine or explicit retry consent without downloading the target. Any pair involving v3 must additionally re-upgrade. Shared-store v3 pairs authenticate the rollback-written credential after re-upgrade. An `isolated-copy-once` host imports legacy credentials once into `protected-credentials`, retains legacy files unchanged for old releases, and never synchronizes later writes between stores: prove an authenticated target write, unchanged legacy files, an authenticated rollback write, and independent target credentials after re-upgrade. Keep all stages bound to the exact package identities; never clear rollback history or modify a historical package to force a retry.
- Upgrade E2E must start the actual source package, perform the real UI update, restart into the actual target package, verify persisted task/plugin/configuration data and task continuation, then exercise rollback. Consume prebuilt release packages instead of building regression fixture packages. Release evidence must use the immutable delivered source and target archives without changing their package identity or signatures. Renaming or editing an existing archive is not cross-version verification. Pre-protocol legacy clients are outside this new E2E matrix.
- Verify the complete selected release: host, Core runtime, executor, Codex, and DWS paths must match that slot's prepared composition. Do not carry fixed source-package binary overrides into the target or rollback process. Build an installed source's prerequisites through its shipped preparation entry, and keep test output separate from formal packages and unrelated checkpoints.
- Maintain the scenario list, phase budgets, and acceptance version in `e2e/desktop/upgrade-suite.mjs`. Bound sequential preparation phases independently, reject stalled or regressing phases, and retain `logs/release-preparation.log` stage timings; never apply one operation's timeout to the entire serial preparation. Run the complete `upgrade-and-rollback` group on macOS arm64. Windows x64 certifies the core `app-rollback` checkpoint: real source-to-target UI upgrade, persisted task/configuration data, task continuation, and normal rollback. Interrupted rollback and failed-activation recovery remain covered by the macOS group and may be run as non-publishing Windows diagnostics. Use fixed A-to-B pairs with B newer than A; B need not be the newest release. Meaningful changes to the acceptance contract increment the suite version and invalidate older proof for new edges.
- Packaged upgrade E2E runs only in the `Wework App` release workflow, including release dry runs; ordinary PR workflows do not run it. Verification consumes the release build artifacts and immutable historical downloads without compiling, packaging, or signing. Preserve the shared checkpoint group on macOS arm64 and Windows x64; macOS x64 follows the architecture-equivalence release-gate exception above.
- Freeze published catalogs and every baseline, previous, and required source before dispatching package-pair shards. Limit verification to eight concurrent runners. Prepare shared immutable source runtimes before starting workers; warmed reads must not rewrite their catalog. Keep mutable catalogs, profiles and release slots isolated. The target may publish immutable programs to `.prepared`, keyed by fingerprint, version, archive hash and size, for later preparations to reuse after checking their own delivered archive. Never add future target roles to the source runtime catalog. Keep checkpoints serial within each pair: Windows shares the native legacy application-data and singleton identity, while macOS replaces the shared application bundle. Aggregate all source results before generating policies; missing proof must block promotion. Report complete execution against the ten-minute optimization target, including input resolution, downloads, preparation, scenarios, cleanup, uploads, and aggregation. Duration alone does not block publication; successful exact-package functional verification remains mandatory. Exclude external runner queues, but count additional scheduling waves under the concurrency limit.
- Register every new scenario with the shared desktop checkpoint runner and CI. Each checkpoint establishes its own fixtures and cleanup. Only model services may be mocked; package download, extraction, launcher, storage, executor, and Electron integration must be real. Deterministic fault injection must exercise the production transaction rather than fabricate a result.
- Changes to updating, rollback, migration, packaging, or release gates require focused packaged-Electron upgrade and rollback E2E. Do not replace these with unit tests, skips, weakened assertions, or retries. Preserve full failure diagnostics without credentials or session files.
- Candidate edge configuration is authored; verified edge records are generated only by successful CI runs. Bind records to both package hashes, source revisions, scenario suite version, and CI evidence. Package changes invalidate previous verification. Publish immutable artifacts before atomically promoting the catalog, and retain every intermediate artifact referenced by an active path.
- Match edge `fromSourceSha`/`toSourceSha` to the delivered package `sourceSha` values and record them in E2E evidence. Diagnostic log failures must not block preparation or hide its original error. Before timeout recovery restores data, the native launcher must stop the complete runtime process tree, including writers in independent process groups.

## Real desktop verification

Any Wework UI, Electron host command, local-runtime, IPC, or desktop integration behavior change requires isolated real-Electron verification in addition to unit and E2E tests. A browser-only or mocked run is not sufficient. Use `scripts/ai-verify.mjs`; do not drive a personal Wework window, external Chrome, or browser plug-ins.

```bash
pnpm --filter wework ai:verify start
pnpm --filter wework ai:verify start --packaged true
pnpm --filter wework ai:verify snapshot --session <session-path>
pnpm --filter wework ai:verify debug --session <session-path>
pnpm --filter wework ai:verify active-element --session <session-path>
pnpm --filter wework ai:verify click --session <session-path> --selector '[data-testid="..."]'
pnpm --filter wework ai:verify click-at --session <session-path> --value '{"x":640,"y":360}'
pnpm --filter wework ai:verify click-then-macrotask --session <session-path> --selector '[data-testid="..."]' --target '[data-testid="..."]'
pnpm --filter wework ai:verify drag --session <session-path> --selector '[data-testid="..."]' --target '[data-testid="..."]'
pnpm --filter wework ai:verify fill --session <session-path> --selector '[data-testid="..."]' --value '...'
pnpm --filter wework ai:verify hover --session <session-path> --selector '[data-testid="..."]'
pnpm --filter wework ai:verify pointer-move --session <session-path> --selector 'body'
pnpm --filter wework ai:verify seed-local-project --session <session-path> --value '{"name":"AI Verify","path":"/absolute/workspace/path"}'
pnpm --filter wework ai:verify reload --session <session-path>
pnpm --filter wework ai:verify wait-for --session <session-path> --selector 'body' --text '<expected post-reload text>'
pnpm --filter wework ai:verify wait-for --session <session-path> --selector '[data-testid="..."]' --text '...'
pnpm --filter wework ai:verify capture --session <session-path> --output <png-path>
pnpm --filter wework ai:verify request-close --session <session-path>
pnpm --filter wework ai:verify close-to-tray --session <session-path>
pnpm --filter wework ai:verify stop --session <session-path>
```

- `start` prepares and launches Electron directly from the source application directory, waits for the WebView, creates an isolated executor home, links local Codex authentication only for that session, and gives the app its own stdio-managed executor child. `start --packaged true` builds the app bundle before launching it; use that mode only when validating packaged resources or macOS application identity.
- Use `start --codex-home-initialization true` to verify the first-run Codex migration flow with a session-local native Codex home and synthetic authentication; it does not read or modify personal Codex credentials.
- Session files and credentials are secrets: never print their contents. Always stop the session; it removes the auth link and terminates the isolated process group.
- Begin with `snapshot`, use existing `data-testid` selectors, and assert a visible text or stable element after each critical action.
- Use `seed-local-project` only to establish an isolated local-project fixture when a native folder picker would block automation. `reload` waits for the new control client to reconnect; always follow it with `wait-for` so the expected post-reload UI state is asserted.
- Prefer selector-based actions. Use `click-at` only for visible controls that cannot expose a stable selector, including controls inside open shadow roots, and retain a screenshot showing the target coordinates.
- Execute the complete QA test plan in the isolated Electron session, including the primary path, relevant boundary and error cases, and recovery. Document the environment, cases run, actual results, and evidence in the change handoff or pull request.
- Use `capture` after the final assertion when a visual verification artifact is required. It renders the current WebView without macOS screen-recording permission.
- Use `request-close` to exercise the native main-window close request and its close-to-tray preference or confirmation flow.
- Use `close-to-tray` only for window-lifecycle verification. It hides the controlled window while preserving its renderer and the isolated Electron process so native reopen behavior can be tested.
- On failure, inspect `app.log`, `executor.log`, and Electron host logs under `test-results/ai-verify/`; do not silently downgrade to mocked verification.

## Local runtime boundaries

- Keep the local runtime and desktop UI isolated from a developer's normal Codex home. Do not copy or log credentials.
- Local coding tasks and desktop workbench behavior must remain functional when the cloud connection is unavailable; do not hide primary-path state or synchronization bugs behind fallback behavior.
- Keep project-space conversation semantics identical for cloud and local projects. Ordinary task comments retain one independent executor session per top-level activity thread; replies continue that session. Project stand-ins instead retain one conversation per user, role, project store, project and Issue: assignments and mentions only wake it, and public root-agent messages become separate comments. Cloud and local storage differences must not change these user-visible boundaries or expose private transcripts.
