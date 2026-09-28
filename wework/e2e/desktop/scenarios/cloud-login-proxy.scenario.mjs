import assert from 'node:assert/strict'

import { startCloudLoginProxyFixture } from '../modules/cloud-login-proxy-fixtures.mjs'

const WORKBENCH_READY_TIMEOUT_MS = 120_000
const CLOUD_CONNECTION_TIMEOUT_MS = 60_000
const STORED_CONNECTION_KEY = 'wework.cloudConnection'

async function storedCloudConnection(control) {
  const raw = await control.command('getLocalStorageItem', 'body', {
    value: STORED_CONNECTION_KEY,
  })
  try {
    return JSON.parse(raw || 'null')
  } catch {
    return null
  }
}

async function cloudConnectionError(control) {
  try {
    const text = await control.command('getText', '[data-testid="cloud-connection-error"]')
    return typeof text === 'string' && text.trim() ? text.trim() : null
  } catch {
    return null
  }
}

// Desktop sign-in must reach the cloud through the operating system's proxy configuration, exactly
// like the renderer and the authorization window. The fixture publishes the backend on a host name
// that only resolves through the local proxy, so the main-process authorization poll only succeeds
// when it travels through the same network stack as the renderer. Before that fix the renderer opened
// the authorization page while the poll reported that the cloud was unreachable.
export async function createDesktopScenario() {
  const fixture = await startCloudLoginProxyFixture()
  return {
    // Start the workbench without the harness stub cloud session so the checkpoint can drive the real
    // authorization flow through the connection dialog.
    authToken: '',
    electronLaunchArguments: [`--proxy-server=${fixture.proxyUrl}`],

    async verify(control) {
      await control.command('waitFor', '[data-testid="sidebar-cloud-connection-button"]', {
        timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
      })
      await control.command('clickWhenEnabled', '[data-testid="sidebar-cloud-connection-button"]')
      await control.command('waitFor', '[data-testid="cloud-authorization-form"]')
      await control.command('fill', '[data-testid="cloud-backend-url-input"]', {
        value: fixture.backendUrl,
      })
      await control.command('clickWhenEnabled', '[data-testid="cloud-authorization-submit-button"]')

      const startedAt = Date.now()
      let connection = null
      while (Date.now() - startedAt < CLOUD_CONNECTION_TIMEOUT_MS) {
        connection = await storedCloudConnection(control)
        if (connection?.backendUrl === fixture.backendUrl && connection?.user) break
        await new Promise(resolve => setTimeout(resolve, 250))
      }

      if (!connection || connection.backendUrl !== fixture.backendUrl || !connection.user) {
        const reportedError = await cloudConnectionError(control)
        assert.fail(
          `Desktop cloud sign-in did not persist a connected session for ${fixture.backendUrl}. ` +
            `Dialog error: ${reportedError ?? 'none'}. ` +
            `Proxy requests: ${JSON.stringify(fixture.proxyRequests)}. ` +
            `Backend requests: ${JSON.stringify(fixture.backendRequests)}`
        )
      }

      assert.equal(
        connection.apiBaseUrl,
        `${fixture.backendUrl}/api`,
        'Desktop cloud sign-in persisted an unexpected cloud API address'
      )
      // The desktop credential mode is only stored after the poll returned a refresh token for this
      // device, which is exactly the response the main process failed to collect before the fix.
      assert.equal(
        connection.credentialMode,
        'desktop_refresh',
        'Desktop cloud sign-in did not claim desktop refresh credentials'
      )
      assert.equal(
        connection.user.user_name,
        'e2e-cloud-login',
        'Desktop cloud sign-in read an unexpected cloud user'
      )
      // The renderer never requests the poll endpoint itself, so these requests can only come from the
      // main-process authorization poll.
      assert.ok(
        fixture.pollProxyRequests().length > 0,
        'The authorization poll did not use the proxied Chromium network stack. ' +
          `Proxy requests: ${JSON.stringify(fixture.proxyRequests)}`
      )
      assert.equal(
        await cloudConnectionError(control),
        null,
        'Desktop cloud sign-in reported an error after the authorization poll'
      )
    },

    diagnostics() {
      return {
        cloudLoginProxy: {
          backendRequests: fixture.backendRequests,
          pollProxyRequests: fixture.pollProxyRequests(),
          proxyRequests: fixture.proxyRequests,
        },
      }
    },

    async cleanup() {
      await fixture.stop()
    },
  }
}
