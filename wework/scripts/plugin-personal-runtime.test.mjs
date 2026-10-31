import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test, vi } from 'vitest'
import {
  restorePersonalPluginRuntime,
  resetPersonalRecipientAccount,
  switchPersonalPluginAccount,
  verifyPersonalSourcePersistence,
} from '../e2e/desktop/modules/plugin-personal-uninstall-flow.mjs'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

test('checks author source after each existing real restart without adding another restart', async () => {
  const events = []
  const restarts = await verifyPersonalSourcePersistence({
    runLifecycle: async restart => {
      events.push('disable')
      await restart()
      events.push('verify-disabled', 'enable')
      await restart()
      events.push('verify-enabled')
    },
    restartDesktopApp: async () => events.push('restart'),
    verifyUninstalled: async () => events.push('verify-source'),
  })
  assert.equal(restarts, 2)
  assert.deepEqual(events, [
    'disable',
    'restart',
    'verify-source',
    'verify-disabled',
    'enable',
    'restart',
    'verify-source',
    'verify-enabled',
  ])
})

test.each([0, 1, 3])(
  'rejects a shared lifecycle with %s restarts instead of both persistence boundaries',
  async count => {
    await assert.rejects(
      verifyPersonalSourcePersistence({
        runLifecycle: async restart => {
          for (let index = 0; index < count; index += 1) await restart()
        },
        restartDesktopApp: async () => {},
        verifyUninstalled: async () => {},
      }),
      /must execute both real restarts/
    )
  }
)

test('rejects a shared restart that would change the author Runtime Home', async () => {
  const restartDesktopApp = vi.fn()
  await assert.rejects(
    verifyPersonalSourcePersistence({
      runLifecycle: restart =>
        restart({ appEnvironmentOverrides: { WEGENT_EXECUTOR_HOME: '/other' } }),
      restartDesktopApp,
      verifyUninstalled: async () => {},
    }),
    /must retain the author Runtime Home/
  )
  assert.equal(restartDesktopApp.mock.calls.length, 0)
})

test.each(['restart', 'source', 'lifecycle'])(
  'propagates %s failure without proceeding or retrying',
  async phase => {
    const failure = new Error(`${phase} failed`)
    const restartDesktopApp = vi.fn(async () => {
      if (phase === 'restart') throw failure
    })
    const verifyUninstalled = vi.fn(async () => {
      if (phase === 'source') throw failure
    })
    await assert.rejects(
      verifyPersonalSourcePersistence({
        runLifecycle: async restart => {
          if (phase === 'lifecycle') throw failure
          await restart()
          await restart()
        },
        restartDesktopApp,
        verifyUninstalled,
      }),
      error => error === failure
    )
    assert.equal(restartDesktopApp.mock.calls.length, phase === 'lifecycle' ? 0 : 1)
    assert.equal(verifyUninstalled.mock.calls.length, phase === 'source' ? 1 : 0)
  }
)

async function recipientResetFixture(verify) {
  const root = await mkdtemp(join(tmpdir(), 'personal-recipient-reset-'))
  const sourcePath = join(root, 'source')
  const registryPath = join(root, 'cloud-links.json')
  const bytes = 'Author source must survive recipient fixture cleanup\n'
  const registry = '{"cloudLinks":[]}'
  const hash = value => createHash('sha256').update(value).digest('hex')
  await mkdir(sourcePath)
  await writeFile(join(sourcePath, 'README.md'), bytes)
  await writeFile(registryPath, registry)
  const plugin = { id: 7, name: 'personal-source', latestReleaseId: 8, version: '1.1.1' }
  const recipient = { id: '42', pluginId: 7, releaseId: 6, enabled: true }
  const access = { pluginId: 7, scope: 'restricted', targets: [{ entityId: '3' }], allowCopy: true }
  const account = {
    metadata: { labels: { id: recipient.id } },
    spec: { ...recipient, source: { pluginKey: plugin.name } },
  }
  let member = account
  const deletes = []
  const fetch = vi.fn(async (url, options) => {
    const token = options.headers.Authorization
    if (options.method === 'DELETE') {
      deletes.push({ url, token })
      assert.equal(token, 'Bearer recipient-token')
      assert.ok(url.endsWith('/plugins/installed/42'))
      member = null
      return new Response(null, { status: 204 })
    }
    if (url.endsWith('/plugins/installed'))
      return Response.json({ items: token === 'Bearer owner-token' || !member ? [] : [member] })
    if (url.endsWith('/access')) return Response.json(access)
    assert.ok(url.endsWith('/plugins/marketplace/7'))
    return Response.json(plugin)
  })
  vi.stubGlobal('fetch', fetch)
  const input = {
    cloudEnvironment: { backendUrl: 'https://cloud.example', authToken: 'owner-token' },
    recipientCloud: { backendUrl: 'https://cloud.example', authToken: 'recipient-token' },
    plugin,
    recipient,
    access,
    source: {
      sourcePath,
      registryPath,
      files: { 'README.md': hash(bytes) },
      registryDigest: hash(registry),
    },
  }
  try {
    await verify({ input, fetch, deletes, sourcePath, bytes })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('resets only the checked recipient membership after the author lifecycle and preserves source', async () => {
  await recipientResetFixture(async ({ input, deletes, sourcePath, bytes }) => {
    assert.equal(await resetPersonalRecipientAccount(input), '42')
    assert.deepEqual(deletes, [
      { url: 'https://cloud.example/api/plugins/installed/42', token: 'Bearer recipient-token' },
    ])
    assert.equal(await readFile(join(sourcePath, 'README.md'), 'utf8'), bytes)
  })
})

test('rejects a changed recipient identity before deleting any membership', async () => {
  await recipientResetFixture(async ({ input, deletes }) => {
    input.recipient.id = '43'
    await assert.rejects(
      resetPersonalRecipientAccount(input),
      /changed another account installation/
    )
    assert.deepEqual(deletes, [])
  })
})

test('propagates recipient cleanup failure without retrying the destructive request', async () => {
  await recipientResetFixture(async ({ input, fetch }) => {
    fetch.mockResolvedValueOnce(
      Response.json({
        items: [
          {
            metadata: { labels: { id: '42' } },
            spec: {
              pluginId: 7,
              releaseId: 6,
              enabled: true,
              source: { pluginKey: input.plugin.name },
            },
          },
        ],
      })
    )
    fetch.mockResolvedValueOnce(new Response(null, { status: 500 }))
    await assert.rejects(resetPersonalRecipientAccount(input), /DELETE.*HTTP 500/)
    assert.equal(fetch.mock.calls.length, 2)
    assert.deepEqual(
      fetch.mock.calls.map(([, options]) => options.method),
      ['GET', 'DELETE']
    )
  })
})

test('detects author source damage during recipient fixture cleanup', async () => {
  await recipientResetFixture(async ({ input, fetch, sourcePath }) => {
    const respond = fetch.getMockImplementation()
    fetch.mockImplementation(async (url, options) => {
      const response = await respond(url, options)
      if (options.method === 'DELETE')
        await writeFile(join(sourcePath, 'README.md'), 'Unexpected source replacement\n')
      return response
    })
    await assert.rejects(resetPersonalRecipientAccount(input), /changed author source bytes/)
  })
})

test('same-account recovery waits for both real connection surfaces without reloading', async () => {
  vi.useFakeTimers()
  let status = { backend: { configured: true, connected: false }, rendererConnected: false }
  const command = vi.fn(async action => {
    if (action === 'reconnectLocalExecutorCloud') return ''
    assert.equal(action, 'getPluginSyncDiagnostics')
    return JSON.stringify(status)
  })
  let finished = false
  const restoring = restorePersonalPluginRuntime({ command }, 'existing-device').then(() => {
    finished = true
  })
  await vi.advanceTimersByTimeAsync(0)
  assert.equal(finished, false)
  status.backend.connected = true
  await vi.advanceTimersByTimeAsync(100)
  assert.equal(finished, false, 'Native connection alone must not imply renderer recovery')
  status = { backend: { configured: false, connected: true }, rendererConnected: true }
  await vi.advanceTimersByTimeAsync(100)
  assert.equal(finished, false, 'A missing Native profile must not count as recovery')
  status.backend.configured = true
  await vi.advanceTimersByTimeAsync(100)
  await restoring
  assert.equal(finished, true)
  assert.deepEqual(command.mock.calls[0], ['reconnectLocalExecutorCloud', 'body'])
  for (const args of command.mock.calls.slice(1))
    assert.deepEqual(args, ['getPluginSyncDiagnostics', 'body', { value: 'existing-device' }])
})

test('same-account recovery propagates the connection failure without reloading or retrying', async () => {
  const failure = new Error('Runtime token issuing failed')
  const command = vi.fn().mockRejectedValue(failure)
  await assert.rejects(
    restorePersonalPluginRuntime({ command }, 'existing-device'),
    error => error === failure
  )
  assert.equal(command.mock.calls.length, 1)
})

test('account switching reloads once, verifies the new identity and keeps the device', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 42 }) }))
  const control = {
    readyCount: 7,
    awaitReadyAfter: vi.fn().mockResolvedValue(undefined),
    command: vi.fn(async action => {
      if (action === 'getLocalExecutorStatus')
        return JSON.stringify({ ready: true, deviceId: 'existing-device' })
      if (action === 'disconnectLocalExecutorCloud')
        return JSON.stringify({ configured: false, connected: false })
      if (action === 'getPluginSyncDiagnostics')
        return JSON.stringify({
          backend: { configured: true, connected: true },
          rendererConnected: true,
        })
      if (action === 'getLocalStorageItem') return JSON.stringify({ user: { id: 42 } })
      assert.ok(['setCloudSessionToken', 'reloadMainWindow', 'waitFor'].includes(action))
      return ''
    }),
  }
  const result = await switchPersonalPluginAccount(control, {
    backendUrl: 'https://cloud.example',
    authToken: 'selected-account-token',
  })
  assert.equal(result.userId, 42)
  assert.equal(result.deviceId, 'existing-device')
  assert.deepEqual(control.awaitReadyAfter.mock.calls, [[7]])
  const actions = control.command.mock.calls.map(([action]) => action)
  assert.deepEqual(actions, [
    'getLocalExecutorStatus',
    'disconnectLocalExecutorCloud',
    'setCloudSessionToken',
    'reloadMainWindow',
    'waitFor',
    'getPluginSyncDiagnostics',
    'getLocalStorageItem',
    'getLocalExecutorStatus',
  ])
})
