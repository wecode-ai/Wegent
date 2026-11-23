import { expect, test, vi } from 'vitest'
import type { ProjectChatMessage } from '@wegent/chat-core'
import type { RuntimeConversationClient } from '@wegent/chat-core/runtime-conversation-client'
import { createScope } from './runtimeConversationScopeContext'

const address = { deviceId: 'device', taskId: 'task' }
const message = {
  messageId: 'run',
  sender: { type: 'agent' },
  metadata: {},
  runtimeAddress: address,
  status: 'streaming',
} as ProjectChatMessage
function fixture() {
  const getTranscript = vi.fn().mockResolvedValue({
    runtime: 'codex',
    taskId: 'task',
    running: false,
    rangeStart: 0,
    rangeEnd: 1,
    hasMoreBefore: false,
    messages: [],
    turns: [
      {
        id: 'turn',
        status: 'completed',
        items: [
          {
            id: 'run',
            type: 'user_message',
            message: {
              id: 'run',
              role: 'user',
              content: 'Request',
              createdAt: '',
            },
          },
        ],
      },
    ],
  })
  const runtime: RuntimeConversationClient = {
    getTranscript,
    subscribe: vi.fn().mockResolvedValue(() => {}),
    cancel: vi.fn(),
    dispose: vi.fn(),
  }
  return { runtime, getTranscript, scope: createScope(runtime) }
}

test('observing an unopened activity neither loads history nor connects a stream', () => {
  const f = fixture()
  const observation = f.scope.observeActivity('run', message, true)!
  const stop = observation.subscribe(vi.fn())
  expect(f.getTranscript).not.toHaveBeenCalled()
  expect(f.runtime.subscribe).not.toHaveBeenCalled()
  expect(f.scope.getActivityTurnId('run')).toBeUndefined()
  stop()
})

test('only committed observation pins identity; detached observers cannot identify later data', async () => {
  const f = fixture()
  const observation = f.scope.observeActivity('run', message, true)!
  const stop = observation.subscribe(vi.fn())
  stop()
  const session = f.scope.get(address)
  const stopViewer = f.scope.observeSession(session, vi.fn(), true)
  await session.reload()
  expect(observation.getSnapshot().turns).toHaveLength(1)
  expect(f.scope.getActivityTurnId('run')).toBeUndefined()
  const stopAgain = observation.subscribe(vi.fn())
  expect(f.scope.getActivityTurnId('run')).toBe('turn')
  stopAgain()
  stopViewer()
  await Promise.resolve()
})

test('constructing an observer for already loaded facts does not publish a binding during render', async () => {
  const f = fixture(),
    session = f.scope.get(address)
  const stopViewer = f.scope.observeSession(session, vi.fn(), true)
  await session.reload()
  const observation = f.scope.observeActivity('run', message, true)!
  expect(observation.getSnapshot().turns[0].id).toBe('turn')
  expect(f.scope.getActivityTurnId('run')).toBeUndefined()
  const stop = observation.subscribe(vi.fn())
  expect(f.scope.getActivityTurnId('run')).toBe('turn')
  stop()
  stopViewer()
  await Promise.resolve()
})

test('a commit replacing the last reader retains the visited stream until the scope is unobserved', async () => {
  const f = fixture(),
    session = f.scope.get(address)
  const disconnect = vi.fn()
  vi.mocked(f.runtime.subscribe).mockResolvedValue(disconnect)
  const stopViewer = f.scope.observeSession(session, vi.fn(), true)
  await session.reload()
  const observation = f.scope.observeActivity('run', message, true)!
  const stopActivity = observation.subscribe(vi.fn())
  stopViewer()
  await Promise.resolve()
  expect(disconnect).not.toHaveBeenCalled()
  stopActivity()
  const stopReplacement = observation.subscribe(vi.fn())
  await Promise.resolve()
  expect(disconnect).not.toHaveBeenCalled()
  expect(f.getTranscript).toHaveBeenCalledTimes(1)
  stopReplacement()
  await Promise.resolve()
  expect(disconnect).toHaveBeenCalledTimes(1)
})

test('viewer and activity share a project session regardless of property order', () => {
  const f = fixture()
  const viewer = f.scope.get({
    ...address,
    projectSession: { projectId: 'project', issueId: 'issue' },
  })
  const activity = f.scope.get({
    ...address,
    projectSession: { issueId: 'issue', projectId: 'project' },
  })
  expect(activity).toBe(viewer)
  expect(
    f.scope.get({ ...address, projectSession: { projectId: 'other', issueId: 'issue' } })
  ).not.toBe(viewer)
  expect(f.getTranscript).not.toHaveBeenCalled()
})
