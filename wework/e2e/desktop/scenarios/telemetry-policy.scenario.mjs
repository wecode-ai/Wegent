import assert from 'node:assert/strict'
import { createDesktopScenario as createStandInScenario } from './stand-in-telemetry.scenario.mjs'
import { waitForBoardValue } from '../modules/collaboration-board-flows.mjs'
import { telemetryEvents } from '../modules/response-protocol.mjs'

/** Extend the real Executor-to-receiver flow without changing its existing assertions. */
export function createDesktopScenario(options) {
  const scenario = createStandInScenario(options)
  return {
    ...scenario,
    async verify(control) {
      await scenario.verify(control)
      const events = control.telemetryRequests.flatMap(request => telemetryEvents(request.payload))
      assert.ok(events.some(event => event.event === 'stand_in_execution_completed'))
      for (const event of events) {
        for (const key of [
          'user_id',
          'user_name',
          'email',
          'email_prefix',
          'smart_app_key',
          'smart_app_name',
          'smart_app_version',
          'smart_app_source',
          'plugin_key',
          'plugin_marketplace',
          'plugin_version',
          'tool_name',
          'tool_duration_ms',
        ]) {
          assert.ok(!Object.hasOwn(event.properties, key), `Default policy leaked ${key}`)
        }
        assert.equal(event.properties.platform, event.properties.os)
        assert.equal(event.properties.event_schema_version, 1)
      }
      console.log('[telemetry-policy] Unified delivery and default privacy verified')

      await options.restartDesktopApp({
        appEnvironmentOverrides: {
          WEWORK_E2E_TELEMETRY_IDENTITY: 'email_prefix',
        },
      })
      await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]')
      const connection = JSON.parse(
        await control.command('getLocalStorageItem', 'body', {
          value: 'wework.cloudConnection',
        })
      )
      assert.ok(connection?.user?.email, 'The signed-in fixture must expose its account email')
      const prefix = connection.user.email.split('@')[0]
      const requestBoundary = control.telemetryRequestCount()
      await control.command('navigate', 'body', { value: '/sites?app_type=smart_app' })
      const request = await control.awaitTelemetryEventAfter(
        'smart_app_marketplace_opened',
        requestBoundary
      )
      const event = telemetryEvents(request.payload).find(
        event => event.event === 'smart_app_marketplace_opened'
      )
      assert.equal(event.properties.distinct_id, prefix)
      for (const key of ['email', 'email_prefix', 'user_id', 'user_name'])
        assert.ok(!Object.hasOwn(event.properties, key), `Unexpected account attribute: ${key}`)
      assert.ok(!JSON.stringify(request.payload).includes(connection.user.email))

      const toggle = '[data-testid="general-telemetry-toggle"]'
      await control.command('click', '[data-testid="settings-button"]')
      await control.command('click', '[data-testid="settings-menu-button"]')
      await control.command('waitFor', toggle)
      assert.equal(await control.command('getAttribute', toggle, { value: 'aria-checked' }), 'true')
      await control.command('waitFor', '[data-testid="telemetry-collection-notice"]')
      await control.command('click', toggle)
      await waitForBoardValue(
        () => control.command('getAttribute', toggle, { value: 'aria-checked' }),
        'false',
        'Telemetry refusal must persist',
        options.uiTimeoutMs
      )
      const disabledBoundary = control.telemetryRequestCount()
      await control.command('navigate', 'body', { value: '/sites?app_type=smart_app&view=owned' })
      // Observe beyond one SDK batching interval after triggering another real route event.
      await new Promise(resolve => setTimeout(resolve, 5500))
      assert.equal(
        control.telemetryRequestCount(),
        disabledBoundary,
        'Configured identity must not bypass consent'
      )
      console.log('[telemetry-policy] Configured user identifier and consent revocation verified')
    },
  }
}
