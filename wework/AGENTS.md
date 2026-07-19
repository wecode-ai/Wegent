# Wework contributor guide

This directory implements the Wework desktop workbench: Tauri, Vite, React, TypeScript, and the local coding runtime. Follow the repository-wide rules in `../AGENTS.md` first.

## UI and component rules

- Before changing Wework UI or interaction behavior, read and follow [`DESIGN.md`](DESIGN.md). It is the source of truth for product-level visual, interaction, accessibility, and responsive-design decisions.
- Mobile is `<=767px`, tablet `768px–1023px`, desktop `>=1024px`. Split mobile and desktop components when layout or interaction differs materially; otherwise use responsive classes. Mobile controls must be at least `44px × 44px`.
- Follow the Codex-derived, neutral-first visual system in `DESIGN.md`: grayscale surfaces, `14px` default desktop UI text, sparse hairlines and shadows, inverse-neutral primary actions, and blue only for focus, links, or narrow selection accents. Green and teal are restricted to semantic success/addition states and must never define product chrome or default actions.
- Use the Codex component density documented in `DESIGN.md`: `30px` sidebar rows, `28px` app-shell tabs and composer actions, `16px` standard desktop icons, and `4px–8px` action-group gaps. Reuse the shared component's established size instead of inventing a local height.
- Use the shared typography scale and semantic `heading-*`, `text-chat`, and `text-code` roles. Never add arbitrary `text-[Npx]`, literal CSS `font-size`, or literal inline `fontSize` values; `pnpm lint` enforces this rule.

## i18n

- Use the local `@/hooks/useTranslation` wrapper for new Wework code.
- Add new copy to the appropriate Wework namespace in both `src/i18n/locales/en/` and `src/i18n/locales/zh-CN/`; register a new namespace in `src/i18n/index.ts`.

## Testing

Run focused tests before committing:

```bash
pnpm --filter wework test
pnpm --filter wework exec prettier --check <changed-files>
pnpm --filter wework exec eslint <changed-files>
```

E2E tests use real backend requests. Do not skip, silently fail, or replace a failing integration with frontend mocks.

- Design verification cases as a QA test plan before running them. For every changed behavior, cover the preconditions, environment and test data, exact steps, expected results, negative and recovery paths, and cleanup. Record the actual result and retain reproducible evidence for failures and critical-path success.
- Changes to a core user flow must add or update automated E2E regression coverage in the same change. Treat task creation and launch, agent interaction, local-runtime lifecycle, permissions, and failure recovery as core flows when they are affected.
- E2E coverage complements, but never replaces, verification in the real Tauri application.

## Real desktop verification

Any Wework UI, Tauri command, local-runtime, IPC, or desktop integration behavior change requires isolated real-Tauri verification in addition to unit and E2E tests. A browser-only or mocked run is not sufficient. Use `scripts/ai-verify.mjs`; do not drive a personal Wework window, external Chrome, or browser plug-ins.

```bash
pnpm --filter wework ai:verify start
pnpm --filter wework ai:verify snapshot --session <session-path>
pnpm --filter wework ai:verify click --session <session-path> --selector '[data-testid="..."]'
pnpm --filter wework ai:verify fill --session <session-path> --selector '[data-testid="..."]' --value '...'
pnpm --filter wework ai:verify hover --session <session-path> --selector '[data-testid="..."]'
pnpm --filter wework ai:verify pointer-move --session <session-path> --selector 'body'
pnpm --filter wework ai:verify wait-for --session <session-path> --selector '[data-testid="..."]' --text '...'
pnpm --filter wework ai:verify capture --session <session-path> --output <png-path>
pnpm --filter wework ai:verify close-to-tray --session <session-path>
pnpm --filter wework ai:verify stop --session <session-path>
```

- `start` waits for the WebView, creates an isolated executor home, links local Codex authentication only for that session, and gives the app its own stdio-managed executor child.
- Session files and credentials are secrets: never print their contents. Always stop the session; it removes the auth link and terminates the isolated process group.
- Begin with `snapshot`, use existing `data-testid` selectors, and assert a visible text or stable element after each critical action.
- Execute the complete QA test plan in the isolated Tauri session, including the primary path, relevant boundary and error cases, and recovery. Document the environment, cases run, actual results, and evidence in the change handoff or pull request.
- Use `capture` after the final assertion when a visual verification artifact is required. It renders the current WebView without macOS screen-recording permission.
- Use `close-to-tray` only for window-lifecycle verification. It destroys the controlled WebView while leaving the isolated Tauri process running so native reopen behavior can be tested.
- On failure, inspect `app.log`, `executor.log`, and Tauri logs under `test-results/ai-verify/`; do not silently downgrade to mocked verification.

## Local runtime boundaries

- Keep the local runtime and desktop UI isolated from a developer's normal Codex home. Do not copy or log credentials.
- Local coding tasks and desktop workbench behavior must remain functional when the cloud connection is unavailable; do not hide primary-path state or synchronization bugs behind fallback behavior.
