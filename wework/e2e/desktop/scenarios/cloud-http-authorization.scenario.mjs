import assert from 'node:assert/strict'

import { disconnectDesktopCloud, signInDesktopCloud } from '../modules/desktop-cloud-login.mjs'
import { prepareExternalBrowserFixture } from '../modules/external-browser-fixture.mjs'
import { until } from '../modules/plugin-regression-fixture.mjs'
import { TransportFaultProxy } from '../modules/transport-fault-proxy.mjs'

async function startLoopbackProxy(target, hostname) {
  const proxy = new TransportFaultProxy(target)
  await new Promise((resolve, reject) => {
    proxy.server.once('error', reject)
    proxy.server.listen(0, hostname, resolve)
  })
  proxy.url = 'http://' + hostname + ':' + proxy.server.address().port
  return proxy
}

export function createDesktopScenario({ resultDir, uiTimeoutMs }) {
  let cloud
  let externalBrowser
  let backendProxy
  let frontendProxy
  let originalFrontendUrl

  return {
    requiresCloudEnvironment: true,
    requiresRemoteExecutor: false,
    authToken: '',
    setCloudEnvironment(environment) {
      cloud = environment
    },
    async prepareApp({ appEnvironment }) {
      externalBrowser = await prepareExternalBrowserFixture(resultDir, uiTimeoutMs)
      Object.assign(appEnvironment, externalBrowser.appEnvironment)
    },

    async verify(control) {
      await externalBrowser.start()
      // Extra loopback addresses exercise HTTP hosts outside the Connector
      // allowlist while keeping both real service proxies local to the runner.
      const origin = await control.command('getLocationOrigin', 'body')
      backendProxy = await startLoopbackProxy(cloud.backendUrl, '127.0.0.2')
      frontendProxy = await startLoopbackProxy(origin, '127.0.0.3')
      let authorizationUrl
      frontendProxy.rule = (entry, request) => {
        if (entry.path === '/auth/wework/authorize') {
          authorizationUrl = new URL(request.url, frontendProxy.url).href
        }
        return null
      }
      originalFrontendUrl = cloud.backendEnv.FRONTEND_URL
      await cloud.restartBackendWithFrontendUrl(frontendProxy.url)

      const response = await fetch(backendProxy.url + '/api/auth/wework/config')
      assert.equal(response.ok, true)
      assert.equal((await response.json()).web_url, frontendProxy.url)

      // Drive the original production sign-in and one-time credential claim.
      // No Backend response, native browser launch, or credential flow is mocked.
      await signInDesktopCloud(control, cloud, {
        backendUrl: backendProxy.url,
        timeoutMs: uiTimeoutMs,
      })
      await until(
        () => frontendProxy.requests,
        requests =>
          requests.some(
            entry => entry.path === '/auth/wework/authorize' && entry.responseCompleted
          ),
        'The system browser did not load the HTTP cloud authorization URL',
        uiTimeoutMs
      )
      assert.ok(authorizationUrl, 'The cloud authorization URL was not requested')
      await externalBrowser.waitForPage(authorizationUrl, '')
      assert.ok(
        backendProxy.requests.some(entry => entry.path === '/api/users/me'),
        'The HTTP cloud connection did not verify its authenticated user'
      )
      await disconnectDesktopCloud(control)
    },

    diagnostics() {
      return {
        backendRequests: backendProxy?.requests ?? [],
        frontendRequests: frontendProxy?.requests ?? [],
      }
    },

    async cleanup() {
      try {
        if (originalFrontendUrl) await cloud.restartBackendWithFrontendUrl(originalFrontendUrl)
      } finally {
        await Promise.all([externalBrowser?.dispose(), backendProxy?.stop(), frontendProxy?.stop()])
      }
    },
  }
}
