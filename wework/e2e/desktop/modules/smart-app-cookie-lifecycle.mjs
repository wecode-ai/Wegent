import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createDevtoolsClient } from '../../../scripts/ai-verify-devtools.mjs'
import { fetchLocalRuntimeJson } from './runtime-request.mjs'

const cookieName = url =>
  `dsh-auth-${createHash('sha256').update(new URL(url).host).digest('base64url')}`

/** Generate unknown cookies without colliding with any active or stored authentication. */
export function createUnownedDshCookieFixtures(protectedNames) {
  const protectedSet = new Set(protectedNames)
  const cookies = []
  for (let port = 55000; port <= 65535 && cookies.length < 100; port++) {
    const name = cookieName(`http://127.0.0.1:${port}/`)
    if (protectedSet.has(name)) continue
    cookies.push({
      name,
      value: 'historical-fixture-'.padEnd(173, 'a'),
      url: 'http://127.0.0.1/',
      path: '/',
      httpOnly: true,
      sameSite: 'Strict',
      expires: Date.now() / 1000 + 30 * 86400,
    })
  }
  assert.equal(cookies.length, 100, 'Could not allocate nonconflicting cookie fixtures')
  return cookies
}

/** Extend the existing close/reopen flow with real shared-session cookie regression checks. */
export async function prepareSmartAppCookieRegression(control, resultDir, installationId) {
  const mainOrigin = await control.command('getLocationOrigin', 'body')
  const client = await createDevtoolsClient(resultDir)
  const targetFor = async (origin, type) => {
    const targets = await client({ action: 'targets' })
    const target = targets.find(item => item.type === type && item.url.startsWith(origin + '/'))
    assert.ok(target, `Missing ${type} target for Smart app cookie verification`)
    return target.id
  }
  const command = (target, method, params) => client({ action: 'command', target, method, params })
  const names = async target => {
    const { cookies } = await command(target, 'Network.getCookies', {
      urls: ['http://127.0.0.1/'],
    })
    return cookies
      .filter(cookie => /^dsh-auth-[A-Za-z0-9_-]{43}$/.test(cookie.name))
      .map(cookie => cookie.name)
      .sort()
  }
  const appUrl = async () => {
    const payload = await fetchLocalRuntimeJson(
      control,
      `${mainOrigin}/wework/electron-host/v1/invoke`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ capability: 'smartApps.list', params: {} }),
      }
    )
    assert.equal(payload.ok, true)
    const app = payload.result.find(item => item.id === installationId)
    assert.equal(app?.state, 'running')
    assert.ok(app.webUrl)
    return app.webUrl
  }
  const pageStatus = async target => {
    const result = await command(target, 'Runtime.evaluate', {
      expression: 'fetch(location.href, { cache: "no-store" }).then(response => response.status)',
      awaitPromise: true,
      returnByValue: true,
    })
    assert.equal(result.exceptionDetails, undefined)
    return result.result.value
  }
  const oldName = cookieName(await appUrl())
  const main = await targetFor(mainOrigin, 'window')
  const browser = await targetFor(new URL(await appUrl()).origin, 'webview')
  const mainBefore = await names(main)
  const browserBefore = await names(browser)
  assert.ok(mainBefore.includes(oldName))
  assert.ok(browserBefore.includes(oldName))
  const stale = createUnownedDshCookieFixtures([...mainBefore, ...browserBefore])
  try {
    assert.equal(await pageStatus(browser), 200)
    await command(browser, 'Network.setCookies', { cookies: stale })
    await command(main, 'Network.setCookies', { cookies: stale })
    assert.equal(
      await pageStatus(main),
      200,
      'Unknown cookies must not overflow the default session request'
    )
    assert.equal(
      await pageStatus(browser),
      200,
      'Unknown stored cookies must not overflow a managed DSH request'
    )
    assert.deepEqual(await names(main), [...mainBefore, ...stale.map(cookie => cookie.name)].sort())
    assert.deepEqual(
      await names(browser),
      [...browserBefore, ...stale.map(cookie => cookie.name)].sort()
    )
  } finally {
    await client({ action: 'detach', target: browser })
  }
  return {
    async assertStopped() {
      try {
        assert.deepEqual(
          await names(main),
          [
            ...mainBefore.filter(name => name !== oldName),
            ...stale.map(cookie => cookie.name),
          ].sort()
        )
      } finally {
        await client({ action: 'detach', target: main })
      }
    },
    async assertReopened() {
      const url = await appUrl()
      const reopened = await targetFor(new URL(url).origin, 'webview')
      try {
        assert.deepEqual(
          await names(main),
          [
            ...mainBefore.filter(name => name !== oldName),
            ...stale.map(cookie => cookie.name),
            cookieName(url),
          ].sort()
        )
        assert.deepEqual(
          await names(reopened),
          [
            ...browserBefore.filter(name => name !== oldName),
            ...stale.map(cookie => cookie.name),
            cookieName(url),
          ].sort()
        )
        assert.equal(
          await pageStatus(reopened),
          200,
          'Reopening must recover real browser navigation'
        )
      } finally {
        await client({ action: 'detach', target: main })
        await client({ action: 'detach', target: reopened })
      }
    },
  }
}
