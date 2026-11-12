// @vitest-environment node

import { expect, test, vi } from 'vitest'

import { verifyConcurrentMcpUserInput } from '../../e2e/desktop/modules/mcp-concurrent-input-flow.mjs'
import { requestExecutor } from '../../e2e/desktop/modules/executor-rpc.mjs'
import { DEFAULT_MODEL_ID, selectE2EModel } from '../../e2e/desktop/modules/shared.mjs'

vi.mock('../../e2e/desktop/modules/executor-rpc.mjs', () => ({ requestExecutor: vi.fn() }))
vi.mock('../../e2e/desktop/modules/shared.mjs', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  selectE2EModel: vi.fn(),
}))

test('does not start concurrent MCP cases while the catalog restart is deferred', async () => {
  const reachedModel = new Error('The refreshed model is ready')
  vi.mocked(selectE2EModel).mockImplementation(async () => {
    throw reachedModel
  })
  const model = { slug: DEFAULT_MODEL_ID, effective: { tool_mode: 'function' } }
  vi.mocked(requestExecutor).mockImplementation(async (_control, method: string) =>
    method.endsWith('.read') ? { models: [model] } : { saved: true }
  )
  let waiting!: () => void
  const enteredWait = new Promise<void>(resolve => {
    waiting = resolve
  })
  let release!: () => void
  const idle = new Promise<void>(resolve => {
    release = resolve
  })
  let restarts = 0
  const command = vi.fn(async (action: string) => {
    expect(action).toBe('restartLocalCodexAppServerIfIdle')
    restarts += 1
    if (restarts === 1)
      return JSON.stringify({
        restarted: false,
        requiresConfirmation: true,
        pendingRequestCount: 1,
      })
    if (restarts === 2) {
      waiting()
      await idle
    }
    return JSON.stringify({ restarted: true, requiresConfirmation: false })
  })
  const verification = verifyConcurrentMcpUserInput({ command, setScenario: vi.fn() }).catch(
    (cause: unknown) => cause
  )
  await Promise.race([enteredWait, verification])
  const prematureModelSelections = vi.mocked(selectE2EModel).mock.calls.length
  release()
  expect(await verification).toBe(reachedModel)
  expect(prematureModelSelections).toBe(0)
  expect(restarts).toBe(3)
  expect(vi.mocked(requestExecutor).mock.calls.at(-1)?.[2]).toMatchObject({
    entry: model.effective,
  })
})
