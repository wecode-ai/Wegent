// @vitest-environment node

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, onTestFinished, test, vi } from 'vitest'
import {
  assertReconcileSchedule,
  settleReconcileBaselines,
  settleRetainedPluginBaseline,
} from '../e2e/desktop/scenarios/plugin-periodic-reconcile.scenario.mjs'

test('measures periodic scheduling from registration despite variable request latency', () => {
  const registeredAt = 1_795_007_158_095
  const reconciliations = [
    { at: 1_795_007_248_258, reconcile: true },
    { at: 1_795_007_338_152, reconcile: true },
  ]
  expect(reconciliations[1].at - reconciliations[0].at).toBe(89_894)
  expect(assertReconcileSchedule({ reconciliations }, registeredAt, reconciliations[1])).toEqual({
    ticks: 2,
    elapsedMs: 180_057,
  })
  for (const at of [registeredAt + 179_999, registeredAt + 226_001]) {
    const request = { at, reconcile: true }
    expect(() =>
      assertReconcileSchedule(
        { reconciliations: [reconciliations[0], request] },
        registeredAt,
        request
      )
    ).toThrow('did not use the configured')
  }
})

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'plugin-reconcile-baseline-'))
  onTestFinished(() => rm(home, { recursive: true, force: true }))
  await mkdir(join(home, 'capabilities'))
  const retained = { installedId: 75 }
  const before = {
    managed: true,
    installed_plugin_id: 75,
    name: 'retained',
    checksum: 'sha256:unchanged',
    enabled: true,
    component_states: { 'skill:retained': true },
    runtime: { codex_link: '/unchanged/plugin' },
    plugin_sync_generation: 25,
  }
  const request = {
    at: 200,
    namespace: '/local-executor,',
    id: '6',
    pluginIds: ['74', '75'],
    pluginSync: { version: 2, generation: 31, complete: true },
  }
  const acknowledgement = { ...request, at: 210, success: true }
  const target = {
    home,
    kind: 'app',
    retainedBefore: before,
    baseline: { retained: before },
    observation: { capabilities: [request], acknowledgements: [acknowledgement] },
  }
  async function write(plugin) {
    await writeFile(
      join(home, 'capabilities/manifest-v2.json'),
      JSON.stringify({ plugins: { retained: plugin } })
    )
  }
  await write({ ...before, plugin_sync_generation: 31 })
  return { target, retained, before, acknowledgement, write }
}

test('uses an acknowledged full sync that occurred while aligning another Runtime window', async () => {
  const { target, retained, before, acknowledgement } = await fixture()
  const settled = await settleRetainedPluginBaseline(target, retained, 1000)
  expect(target.baseline.retained.plugin_sync_generation).toBe(25)
  expect(settled.plugin).toEqual({ ...before, plugin_sync_generation: 31 })
  expect(settled.acknowledgement).toEqual(acknowledgement)
})

test('does not accept unacknowledged ordering metadata as the recovery baseline', async () => {
  const { target, retained } = await fixture()
  target.observation.acknowledgements = []
  await expect(settleRetainedPluginBaseline(target, retained, 1)).rejects.toThrow(
    'retained plugin baseline did not settle'
  )
})

test('revalidates every timer window after asynchronous baseline settlement', async () => {
  const first = await fixture()
  const second = await fixture()
  const targets = [first.target, second.target]
  let now = 1000
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
  onTestFinished(() => clock.mockRestore())
  for (const target of targets) {
    target.baseline.registeredAt = now
    target.baseline.scheduledAt = now
    target.observation.reconciliations = []
  }
  const capabilities = second.target.observation.capabilities
  let advanced = false
  Object.defineProperty(second.target.observation, 'capabilities', {
    get() {
      if (!advanced) {
        advanced = true
        now = 61_001
        const timer = setTimeout(async () => {
          now = 95_000
          for (const item of [first, second]) {
            const { target } = item
            target.observation.reconciliations.push({ at: 94_999, completedAt: 95_000 })
            const request = {
              ...capabilities[0],
              at: 94_999,
              id: 'timer-sync',
              pluginSync: { version: 2, generation: 32, complete: true },
            }
            target.observation.capabilities.push(request)
            target.observation.acknowledgements.push({ ...request, at: 95_000, success: true })
            await item.write({ ...item.before, plugin_sync_generation: 32 })
          }
        }, 100)
        onTestFinished(() => clearTimeout(timer))
      }
      return capabilities
    },
  })
  const settled = await settleReconcileBaselines(targets, first.retained, 1000)
  expect(settled).toHaveLength(2)
  for (const target of targets) expect(target.baseline.scheduledAt).toBe(94_999)
})

test.each(['checksum', 'enabled', 'component_states', 'runtime'])(
  'still rejects changes to the retained plugin %s before fault injection',
  async field => {
    const { target, retained, before, write } = await fixture()
    const changed = {
      checksum: 'sha256:changed',
      enabled: false,
      component_states: { 'skill:retained': false },
      runtime: { codex_link: '/changed/plugin' },
    }
    await write({ ...before, plugin_sync_generation: 31, [field]: changed[field] })
    await expect(settleRetainedPluginBaseline(target, retained, 1000)).rejects.toThrow(
      'Reconcile window alignment altered the retained plugin runtime'
    )
  }
)

test('waits for a timer request already in flight to be acknowledged before baseline', async () => {
  const { target, retained, before, write } = await fixture()
  target.observation.reconciliations = [{ at: 220 }]
  let settled = false
  const pending = settleRetainedPluginBaseline(target, retained, 1000).then(value => {
    settled = true
    return value
  })
  // The old on-disk generation has a valid ACK, but predates the timer request.
  await new Promise(resolve => setTimeout(resolve, 150))
  expect(settled).toBe(false)
  const request = {
    ...target.observation.capabilities[0],
    at: 230,
    id: '7',
    pluginSync: { version: 2, generation: 32, complete: true },
  }
  target.observation.capabilities.push(request)
  target.observation.acknowledgements.push({ ...request, at: 240, success: true })
  await write({ ...before, plugin_sync_generation: 32 })
  await new Promise(resolve => setTimeout(resolve, 150))
  expect(settled).toBe(false)
  target.observation.reconciliations[0].completedAt = 245
  expect((await pending).plugin.plugin_sync_generation).toBe(32)
})
