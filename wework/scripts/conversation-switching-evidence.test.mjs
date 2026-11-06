import { afterEach, expect, test, vi } from 'vitest'
import { requestExecutor } from '../e2e/desktop/modules/executor-rpc.mjs'
import {
  createConversationSwitchingChecks,
  summarizeSwitchingTranscript,
} from '../e2e/desktop/modules/streaming-conversation-switching.mjs'

vi.mock('../e2e/desktop/modules/executor-rpc.mjs', () => ({ requestExecutor: vi.fn() }))
vi.mock('../e2e/desktop/modules/streaming-text-fixture.mjs', async importOriginal => ({
  ...(await importOriginal()),
  openNewChatWithE2EModel: vi.fn(),
}))

afterEach(() => vi.restoreAllMocks())

const privateText = 'private-model-or-owner-content'
const transcript = {
  running: true,
  beforeCursor: 'private-cursor',
  hasMoreBefore: true,
  turns: [
    {
      id: 'private-turn',
      status: 'streaming',
      items: [
        { type: 'user_message', message: { content: privateText }, position: 0 },
        { type: 'block', block: { content: 'TASK_SWITCH_PROGRESS_000' }, position: 1 },
        { type: 'block', block: { content: 'TASK_SWITCH_PROGRESS_519' }, position: 520 },
        { type: 'assistant_text', content: 'TASK_SWITCH_RUNNING' },
      ],
    },
  ],
}

test('reports native ingestion progress without retaining transcript text or identities', () => {
  const summary = summarizeSwitchingTranscript(transcript)
  expect(summary).toEqual({
    running: true,
    turnCount: 1,
    turnStatuses: ['streaming'],
    itemCount: 4,
    positionedItemCount: 3,
    hasMoreBefore: true,
    hasBeforeCursor: true,
    progressCount: 2,
    firstProgress: 0,
    lastProgress: 519,
    hasPrefix: true,
    hasSuffix: false,
  })
  expect(JSON.stringify(summary)).not.toMatch(/private|TASK_SWITCH/)
})

test.each([false, true])(
  'preserves the failed UI assertion and releases the complete 520-item model stream (RPC fails=%s)',
  async rpcFails => {
    const logs = vi.spyOn(console, 'info').mockImplementation(() => {})
    const checks = createConversationSwitchingChecks({ uiTimeoutMs: 10000 })
    const writes = []
    const response = {
      writeHead: vi.fn(),
      flushHeaders: vi.fn(),
      write: value => {
        writes.push(value)
        return true
      },
      end: value => writes.push(value),
    }
    const stream = checks.handleModelRequest(
      { input: 'WEWORK_NATIVE_ORDER_TASK_SWITCH' },
      response,
      'fixture'
    )
    expect(writes).toHaveLength(1)
    const initial = writes[0]
      .split('\n')
      .filter(line => line.startsWith('data: '))
      .map(line => JSON.parse(line.slice(6)))
    const completed = initial.filter(event => event.type === 'response.output_item.done')
    expect(completed).toHaveLength(520)
    expect(completed.map(event => event.item.content[0].text)).toEqual(
      Array.from(
        { length: 520 },
        (_, index) => `TASK_SWITCH_PROGRESS_${String(index).padStart(3, '0')}`
      )
    )
    expect(initial.at(-1).delta).toBe('TASK_SWITCH_RUNNING')
    expect(initial.some(event => event.type === 'response.completed')).toBe(false)

    const failure = new Error('UI prefix was absent')
    vi.mocked(requestExecutor).mockReset()
    if (rpcFails) vi.mocked(requestExecutor).mockRejectedValue(new Error(privateText))
    else vi.mocked(requestExecutor).mockResolvedValue(transcript)
    const control = {
      command: vi.fn(async action => {
        if (action === 'waitFor') throw failure
        if (action === 'getWorkbenchDebugSnapshot') {
          return JSON.stringify({ workbench: { currentRuntimeTask: { taskId: 'task' } } })
        }
      }),
    }
    await expect(checks.verify(control)).rejects.toBe(failure)
    await expect(stream).resolves.toBe(true)
    expect(control.command.mock.calls.find(([action]) => action === 'waitFor')[2]).toEqual({
      text: 'TASK_SWITCH_RUNNING',
    })
    expect(requestExecutor).toHaveBeenCalledWith(
      control,
      'runtime.tasks.transcript',
      { address: { taskId: 'task' }, limit: 5, refresh: true },
      10000
    )
    expect(writes.at(-1)).toContain('event: response.completed')
    expect(writes[1]).toContain('TASK_SWITCH_BACKGROUND_UPDATE')
    expect(JSON.stringify(logs.mock.calls)).not.toContain(privateText)
  }
)
