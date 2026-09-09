---
sidebar_position: 1
title: "[已废弃] Smart App Telemetry Domain Implementation Plan"
status: superseded
superseded_by: 2026-09-09-wework-automatic-telemetry.md
---

# [已废弃] Smart App Telemetry Domain Implementation Plan

> 本计划已由
> [Wework 自动统计实施计划](./2026-09-09-wework-automatic-telemetry.md)
> 取代，不得继续执行。本文仅保留为已经落地的早期实现记录。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every first-release Smart App telemetry payload queryable by `domain: 'smart_app'` while preserving the platform's shared event taxonomy and privacy filtering.

**Architecture:** Extend the typed telemetry contract, property allowlist, and value constraints with the single coarse domain value. Route classification derives the domain only for the three Smart App features, so the global `feature_opened` event remains shared and unrelated routes retain their current payload. The marketplace calls attach the same domain to every success and failure fact after the real operation settles.

**Tech Stack:** TypeScript, React, Vitest, PostHog client wrapper, Vite/Electron desktop application.

---

## File structure

- Modify: `wework/src/telemetry/events.ts` — declare and allow the Smart App domain property for the three event shapes.
- Modify: `wework/src/telemetry/routes.ts` — derive the Smart App domain from the existing route feature classification.
- Modify: `wework/src/App.tsx` — attach the derived domain to route-level `feature_opened` without restoring duplicate reports on unrelated query-string changes.
- Modify: `wework/dsh/ui-applications/src/SmartAppsMarketplacePage.tsx` — attach the domain to actual install, update, import, and failure facts.
- Modify: `wework/src/App.plugins.test.tsx` — cover Smart App route payloads and retain the generic-route duplicate guard.
- Modify: `wework/dsh/ui-applications/src/SmartAppsMarketplacePage.test.tsx` — cover complete payloads and success-after-settlement behavior.
- Modify: `wework/src/telemetry/client.test.ts` — verify allowlisted Smart App domain fields reach PostHog while private fields remain stripped.

### Task 1: Add the telemetry contract and sanitization regression test

**Files:**
- Modify: `wework/src/telemetry/events.ts:1-550`
- Test: `wework/src/telemetry/client.test.ts:639-682`

- [ ] **Step 1: Write the failing privacy-and-allowlist test**

  Update `captures smart app events with coarse properties only` so each Smart App call includes `domain: 'smart_app'` and each emitted capture requires it:

  ```ts
  track('smart_app_installed', {
    domain: 'smart_app',
    install_source: 'marketplace',
    smart_app_id: 'private-smart-app',
    file_path: '/Users/private/Downloads/workbench.zip',
  } as {
    domain: 'smart_app'
    install_source: 'marketplace'
    smart_app_id: string
    file_path: string
  })

  expect(posthogMocks.capture).toHaveBeenNthCalledWith(
    1,
    'smart_app_installed',
    expect.objectContaining({ domain: 'smart_app', install_source: 'marketplace' })
  )
  ```

  Add `domain: 'smart_app'` and equivalent `expect.objectContaining` assertions for `feature_action_completed` and `operation_failed`. Keep the existing negative assertions for `smart_app_id`, `file_path`, `app_name`, and `error_message`.

- [ ] **Step 2: Run the focused test and verify it fails**

  Run:

  ```bash
  pnpm --filter wework test src/telemetry/client.test.ts
  ```

  Expected: the new `domain` assertion fails because the current allowlists remove it from `smart_app_installed` and `operation_failed` payloads.

- [ ] **Step 3: Extend the event map, property allowlists, and value constraints**

  In `wework/src/telemetry/events.ts`, introduce the local type alias next to the other telemetry value aliases:

  ```ts
  export type SmartAppTelemetryDomain = 'smart_app'
  ```

  Add `domain?: SmartAppTelemetryDomain` to the existing `feature_opened` object immediately after its unchanged `feature` union. Add required `domain: SmartAppTelemetryDomain` before `install_source` in `smart_app_installed`. Add `domain?: SmartAppTelemetryDomain` before the unchanged `operation` union in `operation_failed`. The optional properties preserve all pre-existing non-Smart-App call sites.

  Then update the two matching contract tables in the same file:

  Change the property-key table entries to `feature_opened: ['feature', 'domain']`, `smart_app_installed: ['domain', 'install_source']`, and `operation_failed: ['domain', 'operation']`. In the value-constraint table, add `domain: ['smart_app']` to each of those existing event entries while retaining every current `feature`, `install_source`, and `operation` enum value unchanged.

  Do not add a free-form property or a `smart_app: true` boolean. The only new value is the coarse enum `domain: 'smart_app'`.

- [ ] **Step 4: Run the focused test and typecheck**

  Run:

  ```bash
  pnpm --filter wework test src/telemetry/client.test.ts
  pnpm --filter wework typecheck
  ```

  Expected: the client test passes, PostHog receives the allowed domain, private values remain absent, and TypeScript validates every event contract.

- [ ] **Step 5: Commit the contract change**

  ```bash
  git add wework/src/telemetry/events.ts wework/src/telemetry/client.test.ts
  git commit -m "feat(wework): classify smart app telemetry"
  ```

### Task 2: Derive the domain for route-level Smart App opens

**Files:**
- Modify: `wework/src/telemetry/routes.ts:1-19`
- Modify: `wework/src/App.tsx:565-579`
- Test: `wework/src/App.plugins.test.tsx:1086-1153`

- [ ] **Step 1: Write failing route and application assertions**

  Import the planned route-domain helper in `App.plugins.test.tsx`. Add direct assertions that the three existing Smart App feature values map to `'smart_app'` and generic values map to `undefined`:

  ```ts
  expect(telemetryDomainForFeature('smart_apps_marketplace')).toBe('smart_app')
  expect(telemetryDomainForFeature('smart_apps_owned')).toBe('smart_app')
  expect(telemetryDomainForFeature('smart_app')).toBe('smart_app')
  expect(telemetryDomainForFeature('sites')).toBeUndefined()
  ```

  Update the two Smart App `feature_opened` expectations to require:

  ```ts
  { domain: 'smart_app', feature: 'smart_apps_marketplace' }
  { domain: 'smart_app', feature: 'smart_apps_owned' }
  ```

  Add a specific `/app/harness-research-desk` render assertion for `{ domain: 'smart_app', feature: 'smart_app' }`. Keep the existing generic `/sites?app_type=web` expectation without a `domain` key and retain the regression assertion that query-only generic page changes do not emit a second open event.

- [ ] **Step 2: Run the focused test and verify it fails**

  Run:

  ```bash
  pnpm --filter wework test src/App.plugins.test.tsx
  ```

  Expected: the helper import is unresolved and Smart App `feature_opened` payload assertions fail because the application currently sends only `feature`.

- [ ] **Step 3: Implement a focused route-domain helper**

  In `wework/src/telemetry/routes.ts`, import `AnalyticsEventMap` as a type and define the route feature alias:

  ```ts
  import type { AnalyticsEventMap } from './events'

  type TelemetryFeature = AnalyticsEventMap['feature_opened']['feature']

  const SMART_APP_FEATURES = new Set<TelemetryFeature>([
    'smart_apps_marketplace',
    'smart_apps_owned',
    'smart_app',
  ])

  export function telemetryDomainForFeature(feature: TelemetryFeature) {
    return SMART_APP_FEATURES.has(feature) ? ('smart_app' as const) : undefined
  }
  ```

  Keep `telemetryFeatureForLocation()` as the only path-to-feature classifier. The new helper must classify from its returned feature rather than duplicate pathname or query-string conditions.

- [ ] **Step 4: Attach the route domain without changing duplicate-report protection**

  In `wework/src/App.tsx`, import `telemetryDomainForFeature`, calculate a primitive `telemetryDomain` next to the existing `telemetryFeature`, and track the conditional payload:

  ```ts
  const telemetryDomain = telemetryDomainForFeature(telemetryFeature)

  useEffect(() => {
    track(
      'feature_opened',
      telemetryDomain ? { domain: telemetryDomain, feature: telemetryFeature } : { feature: telemetryFeature }
    )
  }, [path, telemetryDomain, telemetryEnabled, telemetryFeature])
  ```

  Preserve `telemetryFeature` as a primitive dependency. Do not depend directly on `search` or on a freshly allocated object; that would reintroduce the previously fixed duplicate event for unrelated query-string changes.

- [ ] **Step 5: Run the route regression tests**

  Run:

  ```bash
  pnpm --filter wework test src/App.plugins.test.tsx
  ```

  Expected: marketplace, owned, and `/app/harness-*` reports include the domain; generic routes remain domain-free; the query-only duplicate guard remains green.

- [ ] **Step 6: Commit the route integration**

  ```bash
  git add wework/src/telemetry/routes.ts wework/src/App.tsx wework/src/App.plugins.test.tsx
  git commit -m "feat(wework): tag smart app route telemetry"
  ```

### Task 3: Attach the domain to marketplace success and failure facts

**Files:**
- Modify: `wework/dsh/ui-applications/src/SmartAppsMarketplacePage.tsx:465-530, 670-700`
- Test: `wework/dsh/ui-applications/src/SmartAppsMarketplacePage.test.tsx:303-470`

- [ ] **Step 1: Update success-path tests first**

  Change the existing real-settlement assertions to require full payloads:

  ```ts
  expect(trackMock).toHaveBeenCalledWith('smart_app_installed', {
    domain: 'smart_app',
    install_source: 'marketplace',
  })

  expect(trackMock).toHaveBeenCalledWith('feature_action_completed', {
    domain: 'smart_app',
    action: 'update',
  })

  expect(trackMock).toHaveBeenCalledWith('smart_app_installed', {
    domain: 'smart_app',
    install_source: 'zip_import',
  })
  ```

  Keep each deferred installation promise and the pre-resolution `expect(trackMock).not.toHaveBeenCalled()` assertion. These establish that telemetry follows real completion rather than a click.

- [ ] **Step 2: Update failure-path tests first**

  For download, marketplace install, marketplace update, and invalid ZIP import failures, require the exact domain with the existing operation value:

  ```ts
  expect(trackMock).toHaveBeenCalledWith('operation_failed', {
    domain: 'smart_app',
    operation: 'smart_app_marketplace_install',
  })
  ```

  Repeat with each operation enum. Keep the assertions that `smart_app_installed` was not sent for failure scenarios, and keep the ZIP file-path privacy assertion.

- [ ] **Step 3: Run the marketplace tests and verify they fail**

  Run:

  ```bash
  pnpm --filter wework test dsh/ui-applications/src/SmartAppsMarketplacePage.test.tsx
  ```

  Expected: each changed exact-payload assertion fails because the component does not yet attach `domain` to Smart App installs or failures.

- [ ] **Step 4: Attach the exact coarse domain at every existing fact point**

  In `SmartAppsMarketplacePage.tsx`, update only the existing tracking calls:

  ```ts
  track('operation_failed', {
    domain: 'smart_app',
    operation: 'smart_app_marketplace_download',
  })

  track('smart_app_installed', {
    domain: 'smart_app',
    install_source: 'marketplace',
  })

  track('operation_failed', {
    domain: 'smart_app',
    operation: 'smart_app_zip_import',
  })
  ```

  Add the same `domain` to marketplace install/update failure calls and ZIP-import success. Do not add tracking to directory linking, package preview, cancellation, or UI selection: those actions are explicitly outside the first-release funnel.

- [ ] **Step 5: Run focused marketplace verification**

  Run:

  ```bash
  pnpm --filter wework test dsh/ui-applications/src/SmartAppsMarketplacePage.test.tsx
  ```

  Expected: all installation, update, import, failure, timing, and privacy assertions pass.

- [ ] **Step 6: Commit the business-call changes**

  ```bash
  git add wework/dsh/ui-applications/src/SmartAppsMarketplacePage.tsx wework/dsh/ui-applications/src/SmartAppsMarketplacePage.test.tsx
  git commit -m "feat(wework): tag smart app telemetry facts"
  ```

### Task 4: Run the integration verification and record the result

**Files:**
- Verify: `wework/src/telemetry/events.ts`
- Verify: `wework/src/telemetry/routes.ts`
- Verify: `wework/src/App.tsx`
- Verify: `wework/dsh/ui-applications/src/SmartAppsMarketplacePage.tsx`

- [ ] **Step 1: Run the focused contract, route, and business suites together**

  Run:

  ```bash
  pnpm --filter wework test src/telemetry/client.test.ts src/App.plugins.test.tsx dsh/ui-applications/src/SmartAppsMarketplacePage.test.tsx
  ```

  Expected: all three focused suites pass; the collection header lists only these requested files.

- [ ] **Step 2: Run static checks on every modified TypeScript file**

  Run:

  ```bash
  pnpm --filter wework typecheck
  pnpm --filter wework exec prettier --check src/telemetry/events.ts src/telemetry/routes.ts src/App.tsx src/App.plugins.test.tsx dsh/ui-applications/src/SmartAppsMarketplacePage.tsx dsh/ui-applications/src/SmartAppsMarketplacePage.test.tsx src/telemetry/client.test.ts
  pnpm --filter wework exec eslint src/telemetry/events.ts src/telemetry/routes.ts src/App.tsx src/App.plugins.test.tsx dsh/ui-applications/src/SmartAppsMarketplacePage.tsx dsh/ui-applications/src/SmartAppsMarketplacePage.test.tsx src/telemetry/client.test.ts
  git diff --check
  ```

  Expected: each command exits 0 and the diff has no whitespace errors.

- [ ] **Step 3: Validate the real desktop startup in an isolated session**

  Run:

  ```bash
  WEWORK_VERIFY_MARKER="$(mktemp)"
  pnpm --filter wework ai:verify start
  WEWORK_AI_VERIFY_SESSION="$(find wework/test-results/ai-verify -type f -name session.json -newer "$WEWORK_VERIFY_MARKER" -print -quit)"
  test -n "$WEWORK_AI_VERIFY_SESSION"
  pnpm --filter wework ai:verify snapshot --session "$WEWORK_AI_VERIFY_SESSION"
  pnpm --filter wework ai:verify stop --session "$WEWORK_AI_VERIFY_SESSION"
  rm "$WEWORK_VERIFY_MARKER"
  ```

  Expected: the isolated Electron application reaches the workbench shell without startup errors. Do not print or commit the session path, session token, credentials, or any telemetry key.

- [ ] **Step 4: Confirm the implementation commits and worktree state**

  Run:

  ```bash
  git status --short
  git log --oneline -3
  ```

  Expected: the three implementation commits are the latest commits and no uncommitted product-code or test changes remain. Do not create a no-op verification commit.

## Plan self-review

- Spec coverage: Task 1 implements the three-part contract and sanitization boundary; Task 2 covers all three route opens; Task 3 covers both successful and failed first-release business facts; Task 4 covers focused, static, and isolated-Electron verification.
- Naming consistency: every new property is exactly `domain: 'smart_app'`; all dedicated event and operation names retain the existing `smart_app_` prefix; no suffix pattern is introduced.
- Scope: no search, filtering, detail, create, copy, directory-link, export, delete, developer-assistant, or plugin-add telemetry is added.
