import { expect, test, vi } from 'vitest'

import { createDesktopScenario } from '../../e2e/desktop/scenarios/stand-in-identities.scenario.mjs'

vi.mock('../../e2e/desktop/modules/shared.mjs', () => ({
  selectE2EModel: vi.fn(),
}))
vi.mock('../../e2e/desktop/modules/preferences-automation-flows.mjs', () => ({
  ensureExperimentalFeaturesEnabled: vi.fn(),
}))
vi.mock('../../e2e/desktop/modules/executor-rpc.mjs', () => ({
  requestExecutor: vi.fn(async (_control, method: string) =>
    method === 'runtime.stand_in.work.list'
      ? { items: [] }
      : {
          version: 1,
          primary: { preferences: '回复简洁；需要决策时先问我。' },
          roles: [],
          executionDeviceId: 'device',
        }
  ),
}))
vi.mock('../../e2e/desktop/modules/response-protocol.mjs', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readRequestBody: vi.fn(async () => ({ input: ['IDENTITY_CREATE_REVIEW_ROLE'] })),
  mcpToolRequestEvents: vi.fn(() => ({ mode: 'direct', events: [] })),
}))

test('waits for role settings to load before opening source connections', async () => {
  const scenario = createDesktopScenario({
    captureScreenshot: vi.fn(),
    uiTimeoutMs: 1000,
    modelResponseTimeoutMs: 1000,
    workspacePath: '/fixture',
  })
  await scenario.handleHttp(
    { method: 'POST' },
    { writeHead: vi.fn(), end: vi.fn() },
    new URL('http://fixture/responses')
  )
  let personalReads = 0
  const { requestExecutor } = await import('../../e2e/desktop/modules/executor-rpc.mjs')
  vi.mocked(requestExecutor).mockImplementation(async (_control, method: string) => {
    if (method === 'runtime.stand_in.work.list') return { items: [] }
    return {
      version: personalReads++ === 0 ? 0 : 1,
      primary: { preferences: '回复简洁；需要决策时先问我。' },
      roles: [],
      executionDeviceId: 'device',
    }
  })
  let settingsLoaded!: () => void
  let waitingStarted!: () => void
  const loading = new Promise<void>(resolve => {
    settingsLoaded = resolve
  })
  const waiting = new Promise<void>(resolve => {
    waitingStarted = resolve
  })
  const reachedConnections = new Error('Source connections are ready')
  const command = vi.fn(async (action: string, selector: string) => {
    if (selector === '[data-testid="stand-in-connections-open"]') {
      expect(action).toBe('clickWhenEnabled')
      waitingStarted()
      await loading
    }
    if (selector === '[data-testid="stand-in-add-connection"]') throw reachedConnections
  })
  const verified = expect(scenario.verify({ command })).rejects.toBe(reachedConnections)

  await waiting
  expect(command).not.toHaveBeenCalledWith('click', '[data-testid="stand-in-add-connection"]')
  settingsLoaded()
  await verified
  expect(command).toHaveBeenCalledWith('click', '[data-testid="stand-in-add-connection"]')
})
