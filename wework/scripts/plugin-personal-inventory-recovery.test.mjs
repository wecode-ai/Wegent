// @vitest-environment node

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onTestFinished, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('../e2e/desktop/modules/plugin-regression-fixture.mjs', async importOriginal => ({
  ...(await importOriginal()),
  requestPluginExecutor: mocks.request,
  assertInventory: vi.fn(),
}))
vi.mock('../e2e/desktop/modules/zip-fixtures.mjs', () => ({ createZipFixture: vi.fn() }))
vi.mock('../e2e/desktop/modules/plugin-inventory-state.mjs', () => ({
  refreshPluginInventory: vi.fn(),
}))
vi.mock('../e2e/desktop/modules/runtime-transport-gates.mjs', () => ({
  runtimeTransportGates: () => ({ reset: vi.fn() }),
}))

import { verifyPersonalInventoryRecovery } from '../e2e/desktop/modules/plugin-personal-inventory-recovery.mjs'

const name = 'personal-inventory-recovery'

async function fixture(importedResponse = JSON.stringify({ pluginName: name })) {
  const root = await mkdtemp(join(tmpdir(), 'personal-inventory-cleanup-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const marketplace = join(root, 'marketplace')
  await mkdir(marketplace)
  mocks.request.mockResolvedValue({ status: 200, payload: { ok: true, result: { plugins: [] } } })
  const control = {
    command: vi.fn(async action => {
      if (action === 'getBundledPluginUpdates')
        return JSON.stringify({ marketplace: { path: marketplace } })
      if (action === 'previewPluginImport')
        return JSON.stringify({ valid: true, name, existing: false })
      if (action === 'importPluginPackage') return importedResponse
    }),
  }
  return {
    control,
    verify: () => verifyPersonalInventoryRecovery({ control, resultDir: root }),
    report: async () => JSON.parse(await readFile(join(root, `${name}-evidence.json`), 'utf8')),
    deletions: () =>
      control.command.mock.calls
        .filter(([action]) => action === 'deleteLocalPluginPackage')
        .map(([, , params]) => JSON.parse(params.value)),
  }
}

test.each(['{}', '{invalid'])(
  'cleans up a committed import with malformed receipt %s',
  async receipt => {
    const f = await fixture(receipt)
    await assert.rejects(f.verify())
    assert.deepEqual(f.deletions(), [{ pluginId: `${name}@wework-personal`, pluginName: name }])
    assert.equal((await f.report()).imported, true)
  }
)

test.each([false, true])(
  'cleans up a rejected import when the local mutation committed=%s',
  async commits => {
    const f = await fixture()
    const failure = new Error('local_plugin_commit_timeout: still committing')
    let committed = false
    const original = f.control.command.getMockImplementation()
    f.control.command.mockImplementation((action, ...args) => {
      if (action === 'importPluginPackage') {
        committed = commits
        throw failure
      }
      if (action === 'deleteLocalPluginPackage') committed = false
      return original(action, ...args)
    })
    await assert.rejects(f.verify(), error => error === failure)
    assert.equal(f.deletions().length, 1)
    assert.equal(committed, false)
    const report = await f.report()
    assert.equal(report.importAttempted, true)
    assert.equal(report.imported, undefined)
  }
)

test.each([
  { name, existing: true },
  { name: 'other-plugin', existing: false },
])('does not claim cleanup ownership for an unsafe preview %j', async preview => {
  const f = await fixture()
  const original = f.control.command.getMockImplementation()
  f.control.command.mockImplementation((action, ...args) =>
    action === 'previewPluginImport'
      ? JSON.stringify({ valid: true, ...preview })
      : original(action, ...args)
  )
  await assert.rejects(f.verify())
  assert.equal(
    f.control.command.mock.calls.some(([action]) => action === 'importPluginPackage'),
    false
  )
  assert.equal(f.deletions().length, 0)
})

test('removes cache written by a delayed install between uninstall and source deletion', async () => {
  const f = await fixture()
  const failure = new Error('local_plugin_commit_timeout: still committing')
  let cacheExists = false
  const cleanup = []
  const original = f.control.command.getMockImplementation()
  f.control.command.mockImplementation((action, ...args) => {
    if (action === 'importPluginPackage') throw failure
    if (action === 'deleteLocalPluginPackage') {
      // Local uninstall releases its cache lock before personal source deletion.
      cacheExists = true
      cleanup.push('source-deleted-after-late-cache-write')
    }
    if (action === 'uninstallInstalledPlugin') {
      assert.equal(args[1].value, `${name}@wework-personal`)
      cacheExists = false
      cleanup.push('cache-removed-after-source')
    }
    return original(action, ...args)
  })
  await assert.rejects(f.verify(), error => error === failure)
  assert.equal(cacheExists, false)
  assert.deepEqual(cleanup, ['source-deleted-after-late-cache-write', 'cache-removed-after-source'])
})

test.each([false, true])(
  'retains the post-import RPC failure when cleanup fails=%s',
  async cleanupFails => {
    const f = await fixture()
    const failure = new Error('Personal source read failed after import')
    mocks.request.mockRejectedValue(failure)
    if (cleanupFails) {
      const original = f.control.command.getMockImplementation()
      f.control.command.mockImplementation((action, ...args) => {
        if (action === 'deleteLocalPluginPackage') throw new Error('Cleanup failed')
        return original(action, ...args)
      })
    }
    await assert.rejects(f.verify(), error => error === failure)
    assert.equal(f.deletions().length, 1)
    const report = await f.report()
    assert.equal(report.passed, false)
    assert.match(report.error, /Personal source read failed after import/)
    if (cleanupFails) assert.match(report.cleanupError, /Cleanup failed/)
  }
)

test.each([
  ['HTTP failure', { status: 500 }],
  ['RPC failure', { status: 200, payload: { ok: false } }],
  ['missing plugin', { status: 200, payload: { ok: true, result: { plugins: [] } } }],
  [
    'source outside isolation',
    { status: 200, payload: { ok: true, result: { plugins: [{ name, pluginPath: tmpdir() }] } } },
  ],
])('cleans up when post-import validation finds %s', async (_name, response) => {
  const f = await fixture()
  mocks.request.mockResolvedValue(response)
  await assert.rejects(f.verify())
  assert.equal(f.deletions().length, 1)
  assert.equal((await f.report()).imported, true)
})
