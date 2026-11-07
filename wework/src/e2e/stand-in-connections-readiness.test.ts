// @vitest-environment node

import { expect, test, vi } from 'vitest'
import { createDesktopScenario } from '../../e2e/desktop/scenarios/stand-in-connections.scenario.mjs'
import { requestExecutor } from '../../e2e/desktop/modules/executor-rpc.mjs'

vi.mock('../../e2e/desktop/modules/stand-in-dingtalk-fixture.mjs', () => ({
  createStandInDingTalkFixture: () => ({ prepareApp: vi.fn(), install: vi.fn() }),
}))

vi.mock('../../e2e/desktop/modules/executor-rpc.mjs', () => ({
  requestExecutor: vi.fn(),
}))

test('waits for startup reconciliation before checking connections on the UI budget', async () => {
  const reachedCatalog = new Error('Reached the initialized connection catalog')
  vi.mocked(requestExecutor).mockImplementation(async (_control, method: string) => {
    if (method === 'runtime.connections.catalog') throw reachedCatalog
    return { version: 1, primary: {} }
  })
  let releaseStartup!: () => void
  let observeStartup!: () => void
  const startup = new Promise<void>(resolve => {
    releaseStartup = resolve
  })
  const observed = new Promise<void>(resolve => {
    observeStartup = resolve
  })
  const command = vi.fn(async () => {
    observeStartup()
    await startup
  })
  const control = { command }
  const scenario = createDesktopScenario({ uiTimeoutMs: 1000, workbenchReadyTimeoutMs: 20000 })
  const verified = expect(scenario.verify(control)).rejects.toBe(reachedCatalog)

  await observed
  expect(command).toHaveBeenCalledWith('ensureLocalModelCatalogReady', 'body', {
    timeoutMs: 20000,
  })
  expect(requestExecutor).not.toHaveBeenCalledWith(
    control,
    'runtime.connections.catalog',
    {},
    expect.anything()
  )
  releaseStartup()
  await verified
  expect(requestExecutor).toHaveBeenCalledWith(control, 'runtime.connections.catalog', {}, 1000)
})
