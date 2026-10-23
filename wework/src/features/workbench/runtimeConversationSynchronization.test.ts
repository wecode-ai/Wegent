import { afterEach, expect, test, vi } from 'vitest'
import type { RuntimeTranscriptResponse } from '@/types/api'
import {
  applyRuntimeConversationAction,
  clearRuntimeConversationCacheForTests,
  evictRuntimeConversation,
  getRuntimeConversationTurns,
  syncRuntimeConversationDeviceAliases,
} from './runtimeConversationCache'
import {
  readRuntimeThreadConversation,
  synchronizeRuntimeConversation,
} from './runtimeConversationSynchronization'

const address = { deviceId: 'device', taskId: 'sync-task' }
const response = (content: string): RuntimeTranscriptResponse => ({
  runtime: 'codex',
  workspacePath: '/workspace',
  messages: [],
  running: true,
  turns: [
    {
      id: 'turn',
      status: 'streaming',
      position: 10,
      items: [
        {
          id: 'text',
          type: 'assistant_text',
          position: 10,
          content,
        },
      ],
    },
  ],
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}
afterEach(clearRuntimeConversationCacheForTests)

test('removes explicit superseded turns and rejects their late live events', async () => {
  await synchronizeRuntimeConversation(
    async () => ({ ...response('Old'), threadId: 'thread' }),
    address
  )
  await synchronizeRuntimeConversation(
    async () => ({
      ...response('Empty'),
      threadId: 'thread',
      turns: [],
      supersededTurnIds: ['turn'],
    }),
    address
  )
  expect(getRuntimeConversationTurns(address)).toEqual([])
  applyRuntimeConversationAction(address, { type: 'assistant_started', subtaskId: 'turn' })
  expect(getRuntimeConversationTurns(address)).toEqual([])
  await synchronizeRuntimeConversation(
    async () => ({ ...response('New branch'), threadId: 'new' }),
    address
  )
  expect(getRuntimeConversationTurns(address)[0].items[0]).toMatchObject({ content: 'New branch' })
})

test('a superseded alias read cannot switch the canonical conversation back to an old thread', async () => {
  const oldResponse = deferred<RuntimeTranscriptResponse>()
  const currentResponse = deferred<RuntimeTranscriptResponse>()
  const oldAddress = { ...address, deviceId: 'device-alias', threadId: 'old' }
  const currentAddress = { ...address, threadId: 'new' }
  const oldRead = vi.fn(() => oldResponse.promise)
  const currentRead = vi.fn(() => currentResponse.promise)
  const old = synchronizeRuntimeConversation(oldRead, oldAddress)
  const current = synchronizeRuntimeConversation(currentRead, currentAddress)
  await vi.waitFor(() => {
    expect(oldRead).toHaveBeenCalledTimes(1)
    expect(currentRead).toHaveBeenCalledTimes(1)
  })
  syncRuntimeConversationDeviceAliases([
    {
      id: 1,
      device_id: address.deviceId,
      socket_device_id: 'device-alias',
      runtime_instance_id: 'runtime',
      name: 'Local Executor',
      status: 'online',
      is_default: true,
      device_type: 'local',
      bind_shell: 'codex',
    },
  ])
  currentResponse.resolve({ ...response('Current branch'), threadId: 'new' })
  await current
  oldResponse.resolve({ ...response('Old branch'), threadId: 'old' })
  await old
  expect(getRuntimeConversationTurns(address)[0]?.items[0]).toMatchObject({
    content: 'Current branch',
  })
})

test('does not merge positions belonging to a replaced native thread', async () => {
  await synchronizeRuntimeConversation(
    async () => ({ ...response('Old branch'), threadId: 'old' }),
    address
  )
  const next = response('New branch')
  next.turns[0].items[0].id = 'new-text'
  await synchronizeRuntimeConversation(async () => ({ ...next, threadId: 'new' }), address)
  expect(getRuntimeConversationTurns(address)[0].items.map(item => item.id)).toEqual(['new-text'])
})

test('rejects an older in-flight read when a new thread identity takes its place', async () => {
  const first = deferred<RuntimeTranscriptResponse>()
  const read = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockResolvedValue({ ...response('New branch'), threadId: 'new' })
  const old = synchronizeRuntimeConversation(read, { ...address, threadId: 'old' })
  const oldResult = expect(old).rejects.toBeInstanceOf(Error)
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
  const current = synchronizeRuntimeConversation(read, { ...address, threadId: 'new' })
  first.resolve({ ...response('Stale branch'), threadId: 'old' })
  await oldResult
  await current
  expect(getRuntimeConversationTurns(address)[0].items[0]).toMatchObject({ content: 'New branch' })
})

test('coalesces equivalent reads and commits live updates after the snapshot', async () => {
  const pending = deferred<RuntimeTranscriptResponse>()
  const read = vi.fn(() => pending.promise)
  const first = synchronizeRuntimeConversation(read, address, { limit: 5 })
  const second = synchronizeRuntimeConversation(read, address, { limit: 5 })
  expect(first).toBe(second)
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
  applyRuntimeConversationAction(address, { type: 'assistant_started', subtaskId: 'turn' })
  applyRuntimeConversationAction(address, {
    type: 'assistant_chunk',
    subtaskId: 'turn',
    itemId: 'text',
    content: 'Newest live output',
    contentMode: 'snapshot',
  })
  pending.resolve(response('Old history'))
  await first
  expect(getRuntimeConversationTurns(address)[0].items[0]).toMatchObject({
    content: 'Newest live output',
    position: 10,
  })
})

test('serializes competing page and recovery reads without blocking another task', async () => {
  const pending = deferred<RuntimeTranscriptResponse>()
  const read = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(response('Recovered'))
  const first = synchronizeRuntimeConversation(read, address, { limit: 5 })
  const second = synchronizeRuntimeConversation(read, address, { refresh: true })
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
  await synchronizeRuntimeConversation(async () => response('Other task'), {
    ...address,
    taskId: 'other-task',
  })
  expect(read).toHaveBeenCalledTimes(1)
  pending.resolve(response('First page'))
  await Promise.all([first, second])
  expect(read).toHaveBeenCalledTimes(2)
  expect(getRuntimeConversationTurns(address)[0].items[0]).toMatchObject({ content: 'Recovered' })
})

test('does not resurrect a task evicted while its history is loading', async () => {
  const pending = deferred<RuntimeTranscriptResponse>()
  const read = vi.fn(() => pending.promise)
  const request = synchronizeRuntimeConversation(read, address)
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
  evictRuntimeConversation(address)
  pending.resolve(response('Archived history'))
  await request
  expect(getRuntimeConversationTurns(address)).toEqual([])
})

test('releases the writer on failure so a later explicit recovery can proceed', async () => {
  await expect(
    synchronizeRuntimeConversation(async () => {
      throw new Error('Disconnected')
    }, address)
  ).rejects.toThrow('Disconnected')
  await synchronizeRuntimeConversation(async () => response('Recovered'), address)
  expect(getRuntimeConversationTurns(address)[0].items[0]).toMatchObject({ content: 'Recovered' })
})

test('restores running runtime commands beside completed native history without cached text', async () => {
  await synchronizeRuntimeConversation(
    async () => ({
      ...response('Native answer'),
      running: false,
      turns: response('Native answer').turns.map(turn => ({ ...turn, status: 'completed' })),
      runtimeTurns: [
        {
          id: 'turn',
          status: 'completed',
          items: [
            {
              id: 'command',
              type: 'block',
              block: {
                id: 'command',
                type: 'tool',
                status: 'pending',
                tool_name: 'bash',
                tool_output: 'ready',
                render_payload: { kind: 'command_execution', status: 'inProgress' },
              },
            },
            response('Native answer').turns[0].items[0],
          ],
        },
      ],
    }),
    address
  )
  const turn = getRuntimeConversationTurns(address)[0]
  expect(turn.status).toBe('done')
  expect(turn.items.map(item => item.id)).toEqual(['command', 'text'])
  expect(turn.items[0]).toMatchObject({ block: { toolOutput: 'ready' } })
})

test('reading a child thread cannot replace or invalidate its parent task conversation', async () => {
  await synchronizeRuntimeConversation(
    async () => ({ ...response('Parent'), threadId: 'parent' }),
    address
  )
  const child = await readRuntimeThreadConversation(
    async () => ({ ...response('Child'), threadId: 'child' }),
    { ...address, threadId: 'child' }
  )
  expect(child.messages).toEqual([])
  expect(child.turns[0].items[0]).toMatchObject({ content: 'Child' })
  expect(getRuntimeConversationTurns(address)[0].items[0]).toMatchObject({ content: 'Parent' })
  applyRuntimeConversationAction(address, {
    type: 'assistant_chunk',
    subtaskId: 'turn',
    itemId: 'text',
    content: ' continues',
  })
  expect(getRuntimeConversationTurns(address)[0].items[0]).toMatchObject({
    content: 'Parent continues',
  })
})
