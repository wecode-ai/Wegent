// @vitest-environment node

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onTestFinished, test, vi } from 'vitest'
import {
  verifyRunningSmartAppInstallRejected,
  verifyStoppedSmartAppInstallAllowed,
} from '../e2e/desktop/modules/smart-app-running-install-guard.mjs'

vi.mock('../e2e/desktop/modules/harness-app-fixture.mjs', async importOriginal => ({
  ...(await importOriginal()),
  async createHarnessPackage(resultDir, installationId, dshVersion, options) {
    assert.equal(dshVersion, '0.2.0-rc.2')
    const archive = join(resultDir, `${options.archiveName}.zip`)
    await writeFile(archive, JSON.stringify({ name: installationId, version: options.version }))
    return archive
  },
}))

// Protocol coverage only; the registered lifecycle checkpoint uses real ZIPs, Host, and DSH.
async function fixture({ rejectionStatus = 400, rejectionOk = false, mutate = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'running-install-guard-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const origin = 'http://127.0.0.1:9137'
  const installationId = 'guard-app'
  const modelKey = 'selected-model'
  const original = {
    id: installationId,
    state: 'running',
    webUrl: `${origin}/workbench`,
    modelKey,
    manifest: { name: installationId, version: '0.1.0' },
  }
  let current = structuredClone(original)
  let pending
  const events = []
  const response = (result, error, status = 200, ok = true) =>
    JSON.stringify({ status, body: JSON.stringify(error ? { ok, error } : { ok, result }) })
  const control = {
    async command(action, selector, options = {}) {
      assert.equal(selector, 'body')
      if (action === 'getLocationOrigin') return origin
      if (action === 'workbenchApp') {
        const input = JSON.parse(options.value)
        assert.equal(input.action, 'installation')
        assert.ok(pending, 'Only a stopped replacement may request native confirmation')
        if (!input.choice) return JSON.stringify({ visible: true, ready: true })
        assert.equal(input.choice, 'accept')
        events.push('native:accepted')
        current = { ...current, manifest: { ...current.manifest, version: '0.1.1' } }
        pending(response(current))
        pending = null
        return JSON.stringify({ clicked: true })
      }
      assert.equal(action, 'fetchLocalRuntime')
      const request = JSON.parse(options.value)
      assert.equal(request.url, `${origin}/wework/electron-host/v1/invoke`)
      assert.equal(request.method, 'POST')
      const { capability, params } = JSON.parse(request.body)
      events.push(capability)
      if (capability === 'smartApps.list') {
        assert.deepEqual(params, {})
        return response([current])
      }
      const archive = join(root, `${installationId}-running-install-guard.zip`)
      assert.equal(params.archivePath, archive)
      if (capability === 'smartApps.preview') {
        const manifest = JSON.parse(await readFile(archive, 'utf8'))
        assert.deepEqual(manifest, { name: installationId, version: '0.1.1' })
        return response({ valid: true, manifest, sha256: 'verified-package-sha256' })
      }
      assert.equal(capability, 'smartApps.install')
      assert.equal(params.expectedSha256, 'verified-package-sha256')
      if (current.state === 'running') {
        assert.equal(params.modelKey, `${modelKey}-blocked`)
        if (mutate) current = mutate(structuredClone(current))
        return response(
          null,
          { message: 'Stop the workbench before installing a new version' },
          rejectionStatus,
          rejectionOk
        )
      }
      assert.equal(current.state, 'installed')
      assert.equal(current.webUrl, null)
      assert.equal(params.modelKey, modelKey)
      return new Promise(resolve => {
        pending = resolve
      })
    },
  }
  return {
    control,
    events,
    original,
    get current() {
      return current
    },
    reject: () =>
      verifyRunningSmartAppInstallRejected(control, { installationId, modelKey, resultDir: root }),
    async replaceAfterStop(input) {
      current = { ...current, state: 'installed', webUrl: null }
      await verifyStoppedSmartAppInstallAllowed(control, input)
    },
  }
}

test('rejects a running replacement without mutation, then confirms and persists the stopped update', async () => {
  const app = await fixture()
  const input = await app.reject()
  assert.deepEqual(app.current, app.original)
  assert.deepEqual(input.before, app.original)
  assert.equal(input.params.modelKey, app.original.modelKey)
  assert.equal(app.events.includes('native:accepted'), false)
  await app.replaceAfterStop(input)
  assert.equal(app.current.state, 'installed')
  assert.equal(app.current.webUrl, null)
  assert.equal(app.current.modelKey, app.original.modelKey)
  assert.equal(app.current.manifest.version, '0.1.1')
  assert.deepEqual(app.events, [
    'smartApps.list',
    'smartApps.preview',
    'smartApps.install',
    'smartApps.list',
    'smartApps.list',
    'smartApps.install',
    'native:accepted',
    'smartApps.list',
  ])
  await assert.rejects(readFile(input.params.archivePath), { code: 'ENOENT' })
})

test.each([{ rejectionStatus: 200 }, { rejectionOk: true }])(
  'requires both HTTP and response-envelope rejection: %j',
  async options => {
    const app = await fixture(options)
    await assert.rejects(app.reject(), /smartApps\.install/)
    assert.equal(app.events.filter(event => event === 'smartApps.list').length, 1)
  }
)

test.each([
  ['model', value => ({ ...value, modelKey: 'blocked-model' })],
  ['runtime', value => ({ ...value, state: 'installed', webUrl: null })],
  ['version', value => ({ ...value, manifest: { ...value.manifest, version: '0.1.1' } })],
])(
  'retains the complete before/after assertion for rejected %s mutation',
  async (_name, mutate) => {
    const app = await fixture({ mutate })
    await assert.rejects(app.reject(), /Rejected installation changed the running app or its model/)
  }
)
