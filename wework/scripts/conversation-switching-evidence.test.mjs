import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { requestExecutor } from '../e2e/desktop/modules/executor-rpc.mjs'
import {
  createConversationSwitchingChecks,
  summarizeSwitchingTranscript,
} from '../e2e/desktop/modules/streaming-conversation-switching.mjs'

const devtools = vi.hoisted(() => ({ client: vi.fn(), create: vi.fn(), write: vi.fn() }))
vi.mock('./ai-verify-devtools.mjs', () => ({
  createDevtoolsClient: devtools.create,
  writeDiagnosticFile: devtools.write,
}))
vi.mock('../e2e/desktop/modules/executor-rpc.mjs', () => ({ requestExecutor: vi.fn() }))
vi.mock('../e2e/desktop/modules/streaming-text-fixture.mjs', async importOriginal => ({
  ...(await importOriginal()),
  openNewChatWithE2EModel: vi.fn(),
}))

afterEach(() => vi.restoreAllMocks())
beforeEach(() => {
  devtools.client.mockReset()
  devtools.create.mockReset().mockResolvedValue(devtools.client)
  devtools.write.mockReset().mockResolvedValue(undefined)
})

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

test.each([
  [false, null],
  [true, null],
  [false, 'start'],
  [false, 'stop'],
  [false, 'write'],
])(
  'preserves the UI failure and complete 520-item stream (RPC fails=%s, CPU failure=%s)',
  async (rpcFails, cpuFailure) => {
    const logs = vi.spyOn(console, 'info').mockImplementation(() => {})
    const resultDir = join(tmpdir(), 'mocked-switching-evidence')
    const checks = createConversationSwitchingChecks({ uiTimeoutMs: 10000, resultDir })
    const profile = { nodes: [], samples: [1], timeDeltas: [100] }
    const phases = []
    devtools.client.mockImplementation(async ({ action, method }) => {
      phases.push(method ?? action)
      if (action === 'targets') {
        return [
          { id: 1, type: 'window', url: 'file:///startup-splash.html' },
          { id: 2, type: 'window', url: 'file:///app/index.html' },
        ]
      }
      if (method === `Profiler.${cpuFailure}`) throw new Error(privateText)
      if (method === 'Profiler.stop') return { profile }
    })
    if (cpuFailure === 'write') devtools.write.mockRejectedValueOnce(new Error(privateText))
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
        phases.push(action)
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
      timeoutMs: 30000,
    })
    expect(requestExecutor).toHaveBeenCalledWith(
      control,
      'runtime.tasks.transcript',
      { address: { taskId: 'task' }, limit: 5, refresh: true },
      10000
    )
    expect(writes.at(-1)).toContain('event: response.completed')
    expect(writes[1]).toContain('TASK_SWITCH_BACKGROUND_UPDATE')
    expect(phases.indexOf('Profiler.start')).toBeLessThan(phases.indexOf('press'))
    const stopCalls = devtools.client.mock.calls.filter(
      ([input]) => input.method === 'Profiler.stop'
    )
    expect(stopCalls).toHaveLength(cpuFailure === 'start' ? 0 : 1)
    if (cpuFailure !== 'start') {
      expect(phases.indexOf('Profiler.stop')).toBeGreaterThan(phases.indexOf('waitFor'))
    }
    expect(devtools.client.mock.calls.filter(([input]) => input.action === 'detach')).toEqual([
      [{ action: 'detach', target: 2 }],
    ])
    if (cpuFailure !== 'start' && cpuFailure !== 'stop') {
      expect(devtools.write).toHaveBeenCalledExactlyOnceWith(
        join(resultDir, 'conversation-switching-initial.cpuprofile'),
        expect.objectContaining({
          ...profile,
          startedAtUnixMs: expect.any(Number),
          finishedAtUnixMs: expect.any(Number),
        })
      )
    } else expect(devtools.write).not.toHaveBeenCalled()
    expect(JSON.stringify(logs.mock.calls)).not.toContain(privateText)
  }
)
