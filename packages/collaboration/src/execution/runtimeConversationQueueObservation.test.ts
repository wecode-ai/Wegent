import { afterEach, expect, test, vi } from 'vitest'
import type { RuntimePaneQueuedMessage } from '@wegent/chat-core/conversation-queue'
import type {
  RuntimeConversationClient,
  RuntimeConversationHandlers,
} from '@wegent/chat-core/runtime-conversation-client'
import { createRuntimeConversationSession } from '@wegent/chat-core/runtime-conversation-session'
import {
  RuntimeConversationQueue,
  type RuntimeConversationQueuePort,
} from './runtimeConversationQueue'
import { createRuntimeConversationQueueObservation } from './runtimeConversationQueueObservation'

const message = (id: string): RuntimePaneQueuedMessage => ({
  id,
  content: id,
  status: 'queued',
  createdAt: '',
})
const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).forEach(stop => stop())
})
function fixture() {
  let handlers!: RuntimeConversationHandlers
  const client: RuntimeConversationClient = {
    getTranscript: vi.fn().mockResolvedValue({
      runtime: 'codex',
      running: false,
      turns: [],
      messages: [],
      rangeStart: 0,
      rangeEnd: 0,
    }),
    subscribe: vi.fn(async (_address, incoming) => {
      handlers = incoming
      return () => {}
    }),
    cancel: vi.fn(),
    dispose: vi.fn(),
  }
  const session = createRuntimeConversationSession(client, { deviceId: 'device', taskId: 'task' })
  cleanups.push(() => session.stop())
  const queue = new RuntimeConversationQueue<number>()
  const port: RuntimeConversationQueuePort<number> = {
    send: vi.fn().mockResolvedValue({ sent: true }),
    guide: vi.fn().mockResolvedValue({ sent: true }),
    lifecycle: () => session.getSnapshot().lifecycleRevision,
    lifecycleChanged: previous => previous !== session.getSnapshot().lifecycleRevision,
    isBusyError: error => error === 'busy',
    sendFailedText: 'Send failed',
    guidanceFailedText: 'Guidance failed',
  }
  return {
    client,
    session,
    queue,
    port,
    handlers: () => handlers,
    async ready() {
      session.start()
      await session.reload()
    },
    observe(available = true, busy = false) {
      return createRuntimeConversationQueueObservation(queue, session, port, { available, busy })
    },
  }
}
async function settle() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

test('constructing the observation does not dispatch, and its snapshot is the real queue', async () => {
  const f = fixture()
  await f.ready()
  f.queue.enqueue(message('first'))
  const observation = f.observe()
  expect(observation.getSnapshot()).toBe(f.queue.getSnapshot())
  expect(f.port.send).not.toHaveBeenCalled()
  const changed = vi.fn()
  const stop = observation.subscribe(changed)
  await settle()
  expect(f.port.send).toHaveBeenCalledTimes(1)
  expect(observation.getSnapshot()).toEqual([])
  expect(changed).toHaveBeenCalled()
  stop()
})

test('detachment invalidates scheduled dispatch and subscription replay does not duplicate a send', async () => {
  const f = fixture()
  await f.ready()
  f.queue.enqueue(message('first'))
  const observation = f.observe()
  observation.subscribe(vi.fn())()
  await settle()
  expect(f.port.send).not.toHaveBeenCalled()
  const stop = observation.subscribe(vi.fn())
  const stopOther = observation.subscribe(vi.fn())
  await settle()
  expect(f.port.send).toHaveBeenCalledTimes(1)
  stopOther()
  stop()
})

test('runtime running facts block a stale idle prop and native settlement resumes the queue', async () => {
  const f = fixture()
  await f.ready()
  f.handlers().onAssistantStart?.('active')
  f.queue.enqueue(message('first'))
  const stop = f.observe().subscribe(vi.fn())
  await settle()
  expect(f.port.send).not.toHaveBeenCalled()
  f.handlers().onAssistantSettled?.('active', 'succeeded')
  await settle()
  expect(f.port.send).toHaveBeenCalledTimes(1)
  stop()
})

test('a missing task or an explicit sending operation holds queued work until a ready binding commits', async () => {
  const f = fixture()
  await f.ready()
  f.queue.enqueue(message('first'))
  const stopUnavailable = f.observe(false).subscribe(vi.fn())
  await settle()
  stopUnavailable()
  const stopBusy = f.observe(true, true).subscribe(vi.fn())
  await settle()
  expect(f.port.send).not.toHaveBeenCalled()
  stopBusy()
  const stopReady = f.observe().subscribe(vi.fn())
  await settle()
  expect(f.port.send).toHaveBeenCalledTimes(1)
  stopReady()
})

test('failed history holds delivery without retrying the read; explicit refresh can recover', async () => {
  const f = fixture()
  vi.mocked(f.client.getTranscript).mockRejectedValueOnce(new Error('Offline'))
  await f.ready()
  f.queue.enqueue(message('first'))
  const stop = f.observe().subscribe(vi.fn())
  await settle()
  expect(f.port.send).not.toHaveBeenCalled()
  expect(f.client.getTranscript).toHaveBeenCalledTimes(1)
  await f.session.reload()
  await settle()
  expect(f.port.send).toHaveBeenCalledTimes(1)
  stop()
})

test('busy rejection waits for a real lifecycle transition and ordinary failure remains editable', async () => {
  const f = fixture()
  await f.ready()
  vi.mocked(f.port.send)
    .mockResolvedValueOnce({ sent: false, error: 'busy' })
    .mockResolvedValueOnce({ sent: false, error: 'Rejected' })
  f.queue.enqueue(message('first'))
  const stop = f.observe().subscribe(vi.fn())
  await settle()
  expect(f.queue.getSnapshot()[0].status).toBe('queued')
  expect(f.port.send).toHaveBeenCalledTimes(1)
  f.handlers().onAssistantStart?.('next')
  await settle()
  expect(f.port.send).toHaveBeenCalledTimes(1)
  f.handlers().onAssistantSettled?.('next', 'succeeded')
  await settle()
  expect(f.port.send).toHaveBeenCalledTimes(2)
  expect(f.queue.getSnapshot()[0]).toMatchObject({ status: 'failed', error: 'Rejected' })
  stop()
})

test('reconciles applied guidance from canonical conversation messages', async () => {
  const f = fixture()
  await f.ready()
  f.queue.enqueue(message('guidance'))
  await f.queue.guide('guidance', f.port, true)
  expect(f.queue.getSnapshot()[0].status).toBe('sending')
  f.session.applyGuidance({
    id: 'guidance',
    role: 'user',
    content: 'guidance',
    status: 'done',
    runtimeGuidance: true,
    createdAt: '',
  })
  const stop = f.observe().subscribe(vi.fn())
  await settle()
  expect(f.queue.getSnapshot()).toEqual([])
  expect(f.port.send).not.toHaveBeenCalled()
  stop()
})

test('a detached pending request settles its own queue without sending another task or the next item', async () => {
  const old = fixture(),
    current = fixture()
  await old.ready()
  await current.ready()
  let accept!: (value: { sent: boolean }) => void
  vi.mocked(old.port.send).mockReturnValueOnce(
    new Promise(resolve => {
      accept = resolve
    })
  )
  old.queue.enqueue(message('old'))
  old.queue.enqueue(message('next-old'))
  const stopOld = old.observe().subscribe(vi.fn())
  await settle()
  stopOld()
  current.queue.enqueue(message('current'))
  const stopCurrent = current.observe().subscribe(vi.fn())
  accept({ sent: true })
  await settle()
  expect(old.port.send).toHaveBeenCalledTimes(1)
  expect(old.queue.getSnapshot()).toEqual([message('next-old')])
  expect(current.port.send).toHaveBeenCalledExactlyOnceWith(message('current'))
  expect(current.queue.getSnapshot()).toEqual([])
  stopCurrent()
})
