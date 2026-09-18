import assert from 'node:assert/strict'
import test from 'node:test'
import { findForbiddenTelemetryImports } from './check-telemetry-boundary.mjs'

test('rejects direct telemetry imports in Smart App UI', () => {
  assert.deepEqual(
    findForbiddenTelemetryImports({
      'dsh/ui-applications/src/SmartAppsMarketplacePage.tsx':
        "import { track } from '@/telemetry/client'",
    }),
    ['dsh/ui-applications/src/SmartAppsMarketplacePage.tsx']
  )
})

test('rejects direct telemetry calls in Smart App UI', () => {
  assert.deepEqual(
    findForbiddenTelemetryImports({
      'src/features/harness-apps/HarnessAppActions.ts': "track('smart_app_opened', {})",
      'src/features/harness-apps/HarnessAppRenderer.tsx': "posthog.capture('smart_app_opened')",
    }),
    [
      'src/features/harness-apps/HarnessAppActions.ts',
      'src/features/harness-apps/HarnessAppRenderer.tsx',
    ]
  )
})

test('allows telemetry infrastructure and centralized operation publication', () => {
  assert.deepEqual(
    findForbiddenTelemetryImports({
      'src/features/harness-apps/smartAppOperations.ts':
        "import { beginOperation } from '@/telemetry/operationBus'",
      'src/telemetry/TelemetryAgent.tsx': "import { trackEvent } from './client'",
    }),
    []
  )
})
