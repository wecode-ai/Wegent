# Wegent web frontend contributor guide

This directory contains the Wegent web frontend (Next.js, React, and TypeScript). Follow the repository-wide rules in `../AGENTS.md` first.

## Messages and state

- Chat display and export must use `messages` from `useUnifiedMessages`; `selectedTaskDetail.subtasks` is stale backend cache only.

## i18n

- Import translations from `@/hooks/useTranslation`; only i18n infrastructure imports `react-i18next` directly.
- Feature text belongs in its owning feature namespace. Add every key to both `src/i18n/locales/en/` and `src/i18n/locales/zh-CN/`.
- Use one explicit primary namespace per component. For cross-namespace copy, use a prefixed key or named translation alias; do not rely on namespace-array fallback or literal fallbacks.
- Register a new namespace in `src/i18n/setup.ts` and add both locale files.

## Responsive UI

- Mobile is `<=767px`, tablet `768px–1023px`, and desktop `>=1024px`.
- Split mobile and desktop components when layout or interaction differs materially; otherwise use responsive classes. Mobile controls must be at least `44px × 44px`.
- Use the existing design tokens and shared UI components. Dialog primary actions use `variant="primary"`.
