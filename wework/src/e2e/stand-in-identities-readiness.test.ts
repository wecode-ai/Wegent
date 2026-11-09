// @vitest-environment node

import { expect, test, vi } from 'vitest'

import { createDesktopScenario } from '../../e2e/desktop/scenarios/stand-in-identities.scenario.mjs'

vi.mock('../../e2e/desktop/modules/stand-in-dingtalk-fixture.mjs', () => ({
  createStandInDingTalkFixture: () => ({
    prepareApp: vi.fn(),
    install: vi.fn().mockResolvedValue(undefined),
  }),
}))

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

async function readyIdentityScenario() {
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
  return scenario
}

test('waits for role settings to load before opening source connections', async () => {
  const scenario = await readyIdentityScenario()
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
    if (action === 'getText') return '收到，我来拟定评审角色。'
    if (action === 'getElementCount') return '0'
    if (selector === '[data-testid="stand-in-connections-open"]') {
      expect(action).toBe('clickWhenEnabled')
      waitingStarted()
      await loading
    }
    if (selector === '[data-testid="stand-in-connection-type-picker"]') throw reachedConnections
  })
  const verified = scenario.verify({ command }).catch((error: unknown) => error)

  await Promise.race([
    waiting,
    verified.then((error: unknown) => {
      throw error
    }),
  ])
  expect(command).not.toHaveBeenCalledWith(
    'waitFor',
    '[data-testid="stand-in-connection-type-picker"]'
  )
  settingsLoaded()
  expect(await verified).toBe(reachedConnections)
  expect(command).toHaveBeenCalledWith('waitFor', '[data-testid="stand-in-connection-type-picker"]')
})

test('waits for the asynchronous provider catalog before opening DingTalk connections', async () => {
  const scenario = await readyIdentityScenario()
  let catalogLoaded!: () => void
  let providerRequested!: () => void
  const loading = new Promise<void>(resolve => {
    catalogLoaded = resolve
  })
  const waiting = new Promise<void>(resolve => {
    providerRequested = resolve
  })
  const sourceEditor = '[data-testid="stand-in-dingtalk-scope-selected"]'
  const reachedSourceEditor = new Error('The source editor is ready')
  const command = vi.fn(async (action: string, selector: string) => {
    if (selector === '[data-testid="stand-in-add-dingtalk-connection"]') {
      providerRequested()
      if (action === 'click') throw new Error('The provider catalog is still loading')
      expect(action).toBe('clickWhenEnabled')
      await loading
    }
    if (selector === sourceEditor) throw reachedSourceEditor
  })
  const verified = scenario.verify({ command }).catch((error: unknown) => error)

  await waiting
  expect(command).not.toHaveBeenCalledWith('click', sourceEditor)
  catalogLoaded()
  expect(await verified).toBe(reachedSourceEditor)
})
