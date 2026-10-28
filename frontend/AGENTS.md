# Wegent web frontend contributor guide

This directory contains the Wegent web frontend (Next.js, React, and TypeScript). Follow the repository-wide rules in `../AGENTS.md` first.

## Messages and state

- Chat display and export must use `messages` from `useUnifiedMessages`; `selectedTaskDetail.subtasks` is stale backend cache only.

## Page data loading and error isolation

These rules also apply to shared UI in `packages/collaboration/` and its Wework hosts.

- A page or tab owns the requests needed to display its current content. Load inactive pages, unopened dialogs and optional editors only when activated. Sharing a route, settings shell or domain does not make their data a prerequisite for one another.
- Keep loading, error and retry state scoped to the content that depends on the request. A slow or failed agent catalog must not block a member list, navigation or another independent section. Combine requests with `Promise.all` only when the current operation requires every result; otherwise publish independent results independently.
- Shared controllers load shared navigation and authorization context only. Feature pages own their feature data. Reuse a scoped query/cache for identical reads instead of fetching the same data in both the shell and the page. Cache identity must include the relevant user, backend and resource; mutations and permission changes must invalidate affected data.
- Distinguish initial loading, successful empty results, refresh and failure. Keep valid same-scope data visible during refresh and show a local error with an explicit retry on failure; never present a failed request as an empty list. Resource or account changes must not display the previous scope's data, and late responses must not overwrite the new scope.
- List and picker requests return only the data required for discovery and display. Fetch full definitions, credentials and execution readiness only for the selected action that needs them. The server must still enforce current authorization for every read and mutation; discovery is not execution permission.
- Test request boundaries, independent pending/failure states, recovery, scope changes and mutation invalidation. A test must fail if an unrelated request becomes a prerequisite again.

## i18n

- Import translations from `@/hooks/useTranslation`; only i18n infrastructure imports `react-i18next` directly.
- Feature text belongs in its owning feature namespace. Add every key to both `src/i18n/locales/en/` and `src/i18n/locales/zh-CN/`.
- Use one explicit primary namespace per component. For cross-namespace copy, use a prefixed key or named translation alias; do not rely on namespace-array fallback or literal fallbacks.
- Register a new namespace in `src/i18n/setup.ts` and add both locale files.

## Responsive UI

- Mobile is `<=767px`, tablet `768px–1023px`, and desktop `>=1024px`.
- Split mobile and desktop components when layout or interaction differs materially; otherwise use responsive classes. Mobile controls must be at least `44px × 44px`.
- Use the existing design tokens and shared UI components. Dialog primary actions use `variant="primary"`.

## Shared collaboration UI

- Web collaboration pages import `@wegent/collaboration/styles.css`, and Tailwind scans `packages/collaboration/src`. Keep shared collaboration structure and visual rules in that package instead of duplicating overrides under `frontend/`.
- Add browser coverage for collaboration layout or style regressions under `frontend/e2e/tests/collaboration/`; those specs run in the default Chromium CI project.
