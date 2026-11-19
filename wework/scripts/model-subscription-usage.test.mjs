// @vitest-environment node

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { DesktopE2EServer } from '../e2e/desktop/modules/desktop-server.mjs'
import { createSubscriptionConfigRegression } from '../e2e/desktop/modules/stand-in-subscription-config.mjs'
import { createCloudConfigModelService } from '../e2e/desktop/modules/cloud-config-model-service.mjs'

function assertUsage(usage) {
  assert.ok(['pro', 'enterprise'].includes(usage.plan_type), 'Official Codex requires plan_type')
  assert.equal(usage.rate_limit.allowed, true)
  assert.equal(usage.rate_limit.limit_reached, false)
  assert.equal(usage.rate_limit.primary_window.used_percent, 0)
  assert.equal(usage.rate_limit.primary_window.limit_window_seconds, 18_000)
  assert.ok(usage.rate_limit.primary_window.reset_at > Date.now() / 1000)
}

test('shared subscription model route serves valid native quota without substituting Backend APIs', async () => {
  const control = new DesktopE2EServer('/workspace')
  await control.start()
  try {
    const response = await fetch(`${control.url}/backend-api/wham/usage`)
    assert.equal(response.status, 200)
    assertUsage(await response.json())
    assert.equal((await fetch(`${control.url}/api/users/me`)).status, 404)
  } finally {
    await control.close()
  }
})

test.each([
  ['stand-in subscription', createSubscriptionConfigRegression, 'cleanup'],
  ['cloud configuration', createCloudConfigModelService, 'close'],
])('%s model bootstrap serves valid native quota', async (_, create, closeMethod) => {
  const home = await mkdtemp(join(tmpdir(), 'wework-model-usage-'))
  const service = create()
  try {
    const codexHome = join(home, 'runtime-codex')
    await mkdir(codexHome)
    await writeFile(join(codexHome, 'config.toml'), '')
    await service.prepareApp({
      appEnvironment: { HOME: home },
      codexHome,
      control: { url: 'http://127.0.0.1:1', httpRequests: [] },
    })
    const config = await readFile(join(codexHome, 'config.toml'), 'utf8')
    const baseUrl = config.match(/^chatgpt_base_url = "([^"]+)"/m)?.[1]
    assert.ok(baseUrl)
    const response = await fetch(new URL('wham/usage', baseUrl))
    assert.equal(response.status, 200)
    assertUsage(await response.json())
  } finally {
    await service[closeMethod]()
    await rm(home, { recursive: true, force: true })
  }
})

test('shared usage routing preserves quota-exhaustion overrides and rejects unrelated routes', async () => {
  const { handleModelSubscriptionUsage } =
    await import('../e2e/desktop/modules/model-subscription-usage.mjs')
  const exhausted = { plan_type: 'enterprise', rate_limit: { allowed: false, limit_reached: true } }
  let body
  const response = {
    writeHead(status) {
      assert.equal(status, 200)
    },
    end(value) {
      body = JSON.parse(value)
    },
  }
  assert.equal(
    handleModelSubscriptionUsage(
      { method: 'GET', url: '/backend-api/wham/usage?test=1' },
      response,
      () => exhausted
    ),
    true
  )
  assert.deepEqual(body, exhausted)
  for (const request of [
    { method: 'POST', url: '/backend-api/wham/usage' },
    { method: 'GET', url: '/api/users/me' },
  ])
    assert.equal(handleModelSubscriptionUsage(request, response), false)
})

test('subscription configuration evidence identifies bootstrap, outage and recovery responses', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wework-model-config-diagnostics-'))
  const service = createCloudConfigModelService()
  const control = { url: 'http://127.0.0.1:1', httpRequests: [] }
  try {
    const codexHome = join(home, 'runtime-codex')
    await mkdir(codexHome)
    await writeFile(join(codexHome, 'config.toml'), '')
    await service.prepareApp({ appEnvironment: { HOME: home }, codexHome, control })
    const config = await readFile(join(codexHome, 'config.toml'), 'utf8')
    const baseUrl = config.match(/^chatgpt_base_url = "([^"]+)"/m)?.[1]
    assert.ok(baseUrl)
    const bundle = new URL('config/bundle', baseUrl)
    await service.failBundle()
    assert.equal((await fetch(bundle)).status, 200)
    assert.equal((await fetch(bundle)).status, 503)
    service.recoverBundle()
    assert.equal((await fetch(bundle)).status, 200)
    const usage = new URL('wham/usage?private=synthetic-query-secret', baseUrl)
    assert.equal(
      (
        await fetch(usage, {
          headers: { authorization: 'Bearer synthetic-header-secret' },
        })
      ).status,
      200
    )
    assert.deepEqual(
      control.httpRequests.map(x => x.status),
      [200, 503, 200, 200]
    )
    assert.deepEqual(
      control.httpRequests.map(x => x.fixtureUnavailable),
      [true, true, false, false]
    )
    assert.deepEqual(
      control.httpRequests.map(x => x.bootstrapBundlesRemaining),
      [1, 0, 0, 0]
    )
    assert.ok(
      control.httpRequests.every(
        x =>
          x.service === 'subscription-configuration' &&
          x.finishedAtUnixMs >= x.startedAtUnixMs &&
          x.durationMs >= 0
      )
    )
    assert.equal(control.httpRequests[3].pathname, '/backend-api/wham/usage')
    assert.doesNotMatch(
      JSON.stringify(control.httpRequests),
      /synthetic-query-secret|synthetic-header-secret/
    )
  } finally {
    await service.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('shared usage routing waits for asynchronous quota preflight and reports rejection', async () => {
  const { handleModelSubscriptionUsage } =
    await import('../e2e/desktop/modules/model-subscription-usage.mjs')
  let release
  const held = new Promise(resolve => {
    release = resolve
  })
  const writes = []
  const response = {
    writeHead: status => writes.push(status),
    end: body => writes.push(JSON.parse(body)),
  }
  assert.equal(
    handleModelSubscriptionUsage(
      { method: 'GET', url: '/backend-api/wham/usage' },
      response,
      () => held
    ),
    true
  )
  assert.deepEqual(writes, [], 'Held quota preflight must not send an empty response')
  const usage = { plan_type: 'enterprise', rate_limit: { allowed: false } }
  release(usage)
  await held
  await Promise.resolve()
  assert.deepEqual(writes, [200, usage])
  const failure = new Error('Synthetic usage failure')
  const original = console.error
  const errors = []
  console.error = (...args) => errors.push(args)
  try {
    const rejected = Promise.reject(failure)
    handleModelSubscriptionUsage(
      { method: 'GET', url: '/backend-api/wham/usage' },
      response,
      () => rejected
    )
    await rejected.catch(() => {})
    await Promise.resolve()
    assert.deepEqual(writes.slice(2), [500, { error: 'Model usage fixture failed' }])
    assert.deepEqual(errors, [['[desktop-e2e] Model usage fixture failed', failure]])
  } finally {
    console.error = original
  }
})
