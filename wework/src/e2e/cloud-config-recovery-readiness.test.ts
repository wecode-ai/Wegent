// @vitest-environment node

import { expect, test, vi } from 'vitest'
import { createDesktopScenario } from '../../e2e/desktop/scenarios/codex-cloud-config-recovery.scenario.mjs'
import { requestExecutor } from '../../e2e/desktop/modules/executor-rpc.mjs'

const fixture = vi.hoisted(() => ({
  failBundle: vi.fn(),
  plan: vi.fn(),
}))
vi.mock('../../e2e/desktop/modules/cloud-config-model-service.mjs', () => ({
  createCloudConfigModelService: () => ({
    ...fixture,
    diagnostics: () => ({
      bundleSuccesses: 1,
      requests: [{ marker: 'WEWORK_CLOUD_CONFIG_RECOVERY_OLD' }],
    }),
  }),
}))
vi.mock('../../e2e/desktop/modules/executor-rpc.mjs', () => ({ requestExecutor: vi.fn() }))
vi.mock('../../e2e/desktop/modules/shared.mjs', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createSingleRootLocalProject: vi.fn(),
}))

test('does not inject the cloud failure while a completed task still owns a prediction', async () => {
  const reachedFault = new Error('The idle fixture can now inject the failure')
  fixture.failBundle.mockImplementation(async () => {
    throw reachedFault
  })
  vi.mocked(requestExecutor).mockImplementation(async (_control, method: string) => {
    if (method === 'runtime.tasks.create') return { accepted: true, deviceId: 'local' }
    if (method === 'runtime.tasks.get') return { task: { status: 'done', threadId: 'original' } }
    if (method === 'runtime.tasks.transcript')
      return {
        turns: [{ status: 'done' }],
        running: false,
        messages: ['WEWORK_CLOUD_CONFIG_RECOVERY_OLD_COMPLETE'],
      }
    throw new Error(`Unexpected fixture request: ${method}`)
  })
  let entered!: () => void
  const waiting = new Promise<void>(resolve => {
    entered = resolve
  })
  let release!: () => void
  const idle = new Promise<void>(resolve => {
    release = resolve
  })
  let attempts = 0
  const command = vi.fn(async (action: string) => {
    if (action === 'ensureLocalModelCatalogReady') return null
    expect(action).toBe('restartLocalCodexAppServerIfIdle')
    if (++attempts === 1)
      return JSON.stringify({ restarted: false, activeTaskCount: 1, pendingRequestCount: 0 })
    entered()
    await idle
    return JSON.stringify({
      restarted: true,
      requiresConfirmation: false,
      activeTaskCount: 0,
      pendingRequestCount: 0,
    })
  })
  const verification = createDesktopScenario({ resultDir: '/unused', workspacePath: '/unused' })
    .verify({ command })
    .catch((error: unknown) => error)
  await Promise.race([waiting, verification])
  const prematureFaults = fixture.failBundle.mock.calls.length
  release()
  expect(await verification).toBe(reachedFault)
  expect(prematureFaults).toBe(0)
  expect(attempts).toBe(2)
  expect(fixture.failBundle).toHaveBeenCalledOnce()
})
