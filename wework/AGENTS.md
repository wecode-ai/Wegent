# Wework contributor guide

This directory implements the Wework desktop workbench: Tauri, Vite, React, TypeScript, and the local coding runtime. Follow the repository-wide rules in `../AGENTS.md` first.

## UI and component rules

- Mobile is `<=767px`, tablet `768px–1023px`, desktop `>=1024px`. Split mobile and desktop components when layout or interaction differs materially; otherwise use responsive classes. Mobile controls must be at least `44px × 44px`.
- Follow the calm UI tokens: low contrast, sparse shadows, teal primary (`#14B8A6`), `bg-base`, `bg-surface`, `text-text-primary`, and `border-border`. Dialog primary actions use `variant="primary"`.
- Desktop workbench controls use `h-8`; icon-only controls use `h-8 w-8`, standard icons use `h-4 w-4`, and toolbar gaps use `gap-1` or `gap-1.5`. Do not introduce other desktop button heights without a documented reason.

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

## Real desktop verification

Any Wework UI behavior change requires isolated real-Tauri verification in addition to unit tests. Use `scripts/ai-verify.mjs`; do not drive a personal Wework window, external Chrome, or browser plug-ins.

```bash
pnpm --filter wework ai:verify start
pnpm --filter wework ai:verify snapshot --session <session-path>
pnpm --filter wework ai:verify click --session <session-path> --selector '[data-testid="..."]'
pnpm --filter wework ai:verify fill --session <session-path> --selector '[data-testid="..."]' --value '...'
pnpm --filter wework ai:verify wait-for --session <session-path> --selector '[data-testid="..."]' --text '...'
pnpm --filter wework ai:verify stop --session <session-path>
```

- `start` waits for the WebView, creates an isolated executor home, links local Codex authentication only for that session, and uses a short temporary IPC socket path.
- Session files and credentials are secrets: never print their contents. Always stop the session; it removes the auth link and terminates the isolated process group.
- Begin with `snapshot`, use existing `data-testid` selectors, and assert a visible text or stable element after each critical action.
- On failure, inspect `app.log`, `executor.log`, and Tauri logs under `test-results/ai-verify/`; do not silently downgrade to mocked verification.

## Local runtime boundaries

- Keep the local runtime and desktop UI isolated from a developer's normal Codex home. Do not copy or log credentials.
- Local coding tasks and desktop workbench behavior must remain functional when the cloud connection is unavailable; do not hide primary-path state or synchronization bugs behind fallback behavior.
