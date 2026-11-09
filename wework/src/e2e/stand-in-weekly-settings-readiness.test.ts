// @vitest-environment node

import { Readable } from 'node:stream'
import { expect, test, vi } from 'vitest'
import { createWeeklyUserStory } from '../../e2e/desktop/modules/stand-in-weekly-user-story.mjs'
import { requestExecutor } from '../../e2e/desktop/modules/executor-rpc.mjs'

vi.mock('../../e2e/desktop/modules/executor-rpc.mjs', () => ({
  requestExecutor: vi.fn(),
}))
vi.mock('../../e2e/desktop/modules/stand-in-private-story-evidence.mjs', () => ({
  readStoryTaskEvidence: async () => ({
    receipt: 'receipt',
    lastTurnId: 'turn',
    completion: {
      status: 'done',
      turnId: 'turn',
      generation: { reportTo: { userId: 9001, taskId: 'stand-in-chat-9001-primary' } },
    },
  }),
}))
vi.mock('../../e2e/desktop/modules/response-protocol.mjs', async importOriginal => ({
  ...(await importOriginal<object>()),
  delegatedTaskResultEvents: () => [{ text: 'WEEKLY_MONDAY_REPORT' }],
}))

test.each([false, true])(
  'weekly cancellation waits for primary settings readiness (saving=%s)',
  async saving => {
    const pickerReached = new Error('Reached connection picker after settings became ready')
    const primaryEntry = '[data-testid="stand-in-primary-connections-open"]'
    let releaseSave!: () => void
    let observeEntry!: () => void
    const saved = new Promise<void>(resolve => {
      releaseSave = resolve
    })
    const entryObserved = new Promise<void>(resolve => {
      observeEntry = resolve
    })
    const story = createWeeklyUserStory({
      uiTimeoutMs: 1000,
      modelResponseTimeoutMs: 1000,
      executorHome: 'fixture-home',
      captureScreenshot: vi.fn(),
    })
    const schedule = {
      id: 'schedule',
      prompt: 'WEEKLY_MONDAY_USER_STORY',
      enabled: true,
      schedule: { expression: '0 9 * * 1' },
      timezone: 'Asia/Shanghai',
      taskRequest: { standInOwner: { userId: 9001, roleId: '@primary' } },
      nextRunAt: '2026-11-09T01:00:00Z',
    }
    vi.mocked(requestExecutor).mockImplementation(async (_control, method: string) => {
      switch (method) {
        case 'runtime.automations.list':
          return { items: [schedule] }
        case 'runtime.automation_runs.list':
          return { items: [{ id: 'run', status: 'succeeded', taskId: 'child' }] }
        case 'runtime.tasks.get':
          return { task: { status: 'done', runtimeHandle: { lastTurnId: 'turn' } } }
        case 'runtime.tasks.transcript':
          return { messages: [{ role: 'assistant', content: 'WEEKLY_MONDAY_REPORT' }] }
        case 'runtime.automations.delete':
          return { deleted: true }
        default:
          throw new Error(`Unexpected RPC: ${method}`)
      }
    })
    const command = vi.fn(async (action: string, selector: string) => {
      if (selector === primaryEntry) {
        observeEntry()
        if (action === 'click' && saving) throw new Error('Primary settings are still saving')
        if (action === 'clickWhenEnabled' && saving) await saved
      }
      if (action === 'getElementCount') {
        if (selector === '[data-testid="stand-in-add-connection"]') throw pickerReached
        return '0'
      }
      if (selector === '[data-testid="automation-prompt-input"]' && action === 'getValue')
        return 'Weekly review'
      if (selector === '[data-testid="automation-open-schedule"]') {
        const body = JSON.stringify({
          input: [
            {
              role: 'user',
              content: 'Wework delegated task result: resultId=receipt, taskId=child, status=done,',
            },
          ],
        })
        await story.handleHttp(
          Object.assign(Readable.from([Buffer.from(body)]), { method: 'POST' }),
          { writeHead: vi.fn(), end: vi.fn() },
          new URL('http://model.test/responses')
        )
      }
      return undefined
    })
    const verified = story.verify({ command }, vi.fn()).catch((error: unknown) => error)
    await Promise.race([
      entryObserved,
      verified.then((error: unknown) => {
        throw error
      }),
    ])
    if (saving) {
      expect(command).not.toHaveBeenCalledWith(
        'getElementCount',
        '[data-testid="stand-in-add-connection"]'
      )
      releaseSave()
    }
    expect(await verified).toBe(pickerReached)
    expect(command).toHaveBeenCalledWith('clickWhenEnabled', primaryEntry)
    expect(command).not.toHaveBeenCalledWith('click', primaryEntry)
    expect(requestExecutor).toHaveBeenLastCalledWith(
      { command },
      'runtime.automations.delete',
      { automationId: 'schedule' },
      1000
    )
  }
)
