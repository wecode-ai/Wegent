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

## UI and component rules

- Before changing Wework UI or interaction behavior, read and follow [`DESIGN.md`](DESIGN.md). It is the source of truth for product-level visual, interaction, accessibility, and responsive-design decisions.
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
- In virtualized content, do not rely on test-added DOM attributes across scrolling or rendering updates. Locate the element with stable product selectors and text first, wait for layout to settle, then add any temporary marker needed by later assertions.
- E2E coverage complements, but never replaces, verification in the real Electron application.

## Upgrade and rollback maintenance contract

- Extend the existing Electron/component manifests with optional upgrade policy fields; preserve legacy fields and endpoints. Legacy clients continue upgrading directly to the advertised latest version. Verified-path enforcement starts once a client contains the new updater; do not pin the legacy channel to a bridge or claim that new fields constrain old clients. Do not introduce a parallel update discovery protocol.
- Each target release declares its minimum source version. Only exact source-to-target edges verified for the same platform, architecture, channel policy, and delivered package hashes may be offered. Never infer an edge from a version range or silently bypass the upgrade policy.
- Prepare the next release in an isolated slot while the current release remains usable. Do not show restart readiness before extraction, integrity checks, and target-owned runtime/profile preparation finish. Keep mutable application data separate from versioned program files.
- Switch the complete host and component set through one atomic release selection. An independent launcher must supervise activation; only both runtime and renderer readiness confirm health. Preserve the previous healthy release and prevent automatic rollback loops.
- Take consistent migration-data snapshots only after writers stop. Compatible rollback may switch directly; incompatible rollback requires explicit confirmation before restoring a snapshot and must preserve the failed release's newer data. Never restore user repositories, cloud records, or personal agent credentials.
- Maintain three layers of verification: pure policy/transaction tests, reusable real-package upgrade/rollback scenarios, and a release-edge matrix. Keep scenario behavior independent of version numbers: add a source/target pair to matrix data instead of copying a test for every release.
- Upgrade E2E must start the actual source package, perform the real UI update, restart into the actual target package, verify persisted task/plugin/configuration data and task continuation, then exercise rollback. Independently built regression fixture packages exercise the mechanism; their results never authorize production edges. Release evidence must use the immutable delivered source and target archives without changing their package identity or signatures. Renaming or editing an existing archive is not cross-version verification. Pre-protocol legacy clients are outside this new E2E matrix.
- Verify the complete selected release: host, Core runtime, executor, Codex, and DWS paths must match that slot's prepared composition. Do not carry fixed source-package binary overrides into the target or rollback process. Build an installed source's prerequisites through its shipped preparation entry, and keep fixture output separate from formal packages and unrelated checkpoints.
- Maintain the scenario list, phase budgets, and acceptance version in `e2e/desktop/upgrade-suite.mjs`. Bound sequential preparation phases independently, reject stalled or regressing phases, and retain `logs/release-preparation.log` stage timings; never apply one operation's timeout to the entire serial preparation. Run the `upgrade-and-rollback` checkpoint group on both macOS and Windows. Use fixed A-to-B pairs with B newer than A; B need not be the newest release. Meaningful changes to the acceptance contract increment the suite version and invalidate older proof for new edges.
- The `Wework Upgrade E2E` workflow runs macOS arm64, macOS x64, and Windows x64 under `ci:all` for non-draft PRs and supports manual dispatch. Preserve all three matrix entries and the shared checkpoint group when changing CI.
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
- Keep project-space conversation semantics identical for cloud and local projects. Each top-level activity comment owns one independent executor session; replies inside that activity thread continue the owning session; a new top-level comment starts a new session. Cloud and local implementations may differ in storage and dispatch, but must not differ in these user-visible session boundaries.
