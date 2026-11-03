import { act, renderHook, waitFor } from '@testing-library/react'
import { TaskReplyQueueStore } from '@wegent/collaboration/execution/taskReplyQueue'
import { useTaskReplyQueue } from '@wegent/collaboration/execution/useTaskReplyQueue'
import type {
  TaskCardDispatchResult,
  TaskReplyCard,
} from '@wegent/collaboration/execution/taskCardReply'
import { expect, it, vi } from 'vitest'
import { NotificationEntityContext } from './NotificationEntityContext'
import {
  RuntimeInteractionsContext,
  type RuntimeInteractionsValue,
} from './RuntimeInteractionsContext'
import { readRuntimeInteractions } from './runtimeInteractions'
import {
  interactionQuestion,
  interactionTask,
  interactionTranscript,
} from './runtimeInteractions.fixtures'
import {
  useNotificationCommentReply,
  useNotificationCommentDispatch,
} from './useNotificationCommentReply'

it('coordinates the original Issue reply without replacing its native send callback', async () => {
  const [item] = await readRuntimeInteractions(interactionTask, {
    getRuntimeTranscript: vi.fn(async () => interactionTranscript(interactionQuestion)),
  } as never)
  item.project = { projectId: 'project', issueId: 'issue', store: 'backend', rootCommentId: 'root' }
  const respond = vi.fn(async (_item, _text, options) => options.send())
  const setDraft = vi.fn()
  const value = {
    pending: [item],
    drafts: { [item.id]: 'Saved reply' },
    busy: new Set(),
    errors: {},
    respond,
    setDraft,
  } as unknown as RuntimeInteractionsValue
  const card = { root: { messageId: 'root' } }
  const selectTarget = vi.fn()
  const props = {
    projectId: 'project',
    issueId: 'issue',
    store: 'backend' as 'local' | 'backend',
    cards: [card],
    target: card,
    selectTarget,
  }
  const { result, rerender } = renderHook(props => useNotificationCommentReply(props), {
    initialProps: props,
    wrapper: ({ children }) => (
      <RuntimeInteractionsContext.Provider value={value}>
        <NotificationEntityContext.Provider
          value={{
            id: item.id,
            projectId: 'project',
            issueId: 'issue',
            store: 'backend',
            rootCommentId: 'root',
          }}
        >
          {children}
        </NotificationEntityContext.Provider>
      </RuntimeInteractionsContext.Provider>
    ),
  })
  expect(selectTarget).toHaveBeenCalledExactlyOnceWith(card)
  expect(result.current?.draft).toBe('Saved reply')
  expect(result.current?.disabled).toBe(false)
  result.current?.setDraft('Updated')
  expect(setDraft).toHaveBeenCalledExactlyOnceWith(item.id, 'Updated')
  rerender({ ...props, issueId: 'other-issue' })
  expect(result.current).toBeNull()
  rerender({ ...props, store: 'local' })
  expect(result.current).toBeNull()
  value.pending = [
    {
      ...item,
      cached: true,
      project: undefined,
      task: { ...item.task, workspace: { ...item.task.workspace, available: false } },
    },
  ]
  rerender(props)
  expect(result.current?.draft).toBe('Saved reply')
  expect(result.current?.disabled).toBe(true)
  rerender({ ...props, target: { root: { messageId: 'other-root' } } })
  expect(result.current?.composing).toBe(false)
})
it('binds queued answers to their exact request instead of the visible request on the same root', async () => {
  const [a] = await readRuntimeInteractions(interactionTask, {
    getRuntimeTranscript: vi.fn(async () => interactionTranscript(interactionQuestion)),
  } as never)
  a.project = { projectId: 'project', issueId: 'issue', store: 'backend', rootCommentId: 'root' }
  const b = { ...a, id: 'request-B', requestKey: 'B' }
  const respond = vi.fn(async (_item, _text, options) => options.send())
  const value = { pending: [a, b], history: [], respond } as unknown as RuntimeInteractionsValue
  const { result, rerender } = renderHook(
    () =>
      useNotificationCommentDispatch({ projectId: 'project', issueId: 'issue', store: 'backend' }),
    {
      wrapper: ({ children }) => (
        <RuntimeInteractionsContext.Provider value={value}>
          {children}
        </RuntimeInteractionsContext.Provider>
      ),
    }
  )
  const reply = {
    id: 'queued-A',
    content: 'Answer A',
    interactionId: a.id,
    status: 'queued' as const,
    createdAt: '2026-11-02',
  }
  const send = vi.fn(async () => ({ ok: true, persisted: true }))
  expect(await result.current('root', reply, send)).toEqual({ ok: true, persisted: true })
  expect(respond).toHaveBeenCalledWith(a, 'Answer A', expect.anything())
  expect(respond).not.toHaveBeenCalledWith(b, expect.anything(), expect.anything())
  expect(send).toHaveBeenCalledOnce()
  respond.mockClear()
  await result.current('root', { ...reply, interactionId: undefined }, send)
  expect(respond).not.toHaveBeenCalled()
  value.pending = [b]
  rerender()
  send.mockClear()
  expect(await result.current('root', reply, send)).toEqual({ ok: false, persisted: false })
  expect(send).not.toHaveBeenCalled()
  value.history = [{ id: a.id } as never]
  rerender()
  expect(await result.current('root', reply, send)).toEqual({ ok: false, persisted: false })
  expect(send).not.toHaveBeenCalled()
})

it.each(['absent', 'handled'])(
  'leaves the native Issue composer unbound when its request is %s',
  state => {
    const entity = {
      id: 'old-request',
      projectId: 'project',
      issueId: 'issue',
      store: 'backend' as const,
      rootCommentId: 'root',
    }
    const value = {
      pending: [],
      history: state === 'handled' ? [{ id: entity.id }] : [],
      drafts: { [entity.id]: 'Unsent draft' },
      errors: {},
      busy: new Set(),
    } as unknown as RuntimeInteractionsValue
    const card = { root: { messageId: 'root' } }
    const selectTarget = vi.fn()
    const { result } = renderHook(
      () =>
        useNotificationCommentReply({
          projectId: entity.projectId,
          issueId: entity.issueId,
          store: entity.store,
          cards: [card],
          target: null,
          selectTarget,
        }),
      {
        wrapper: ({ children }) => (
          <RuntimeInteractionsContext.Provider value={value}>
            <NotificationEntityContext.Provider value={entity}>
              {children}
            </NotificationEntityContext.Provider>
          </RuntimeInteractionsContext.Provider>
        ),
      }
    )
    expect(result.current).toBeNull()
    expect(selectTarget).not.toHaveBeenCalled()
    expect(value.drafts[entity.id]).toBe('Unsent draft')
  }
)

it('retains a second unsent queued answer when the first answer handles the request', async () => {
  const [item] = await readRuntimeInteractions(interactionTask, {
    getRuntimeTranscript: vi.fn(async () => interactionTranscript(interactionQuestion)),
  } as never)
  item.project = { projectId: 'project', issueId: 'issue', store: 'backend', rootCommentId: 'root' }
  const send = vi.fn<(content: string) => Promise<TaskCardDispatchResult>>(async () => ({
    ok: true,
    persisted: true,
  }))
  const value = {
    pending: [item],
    history: [],
    respond: vi.fn(async (_item, _text, options) => {
      await options.send()
      value.pending = []
      value.history = [{ id: item.id } as never]
      return true
    }),
  } as unknown as RuntimeInteractionsValue
  const store = new TaskReplyQueueStore()
  const cards = [{ root: { messageId: 'root' }, replies: [] }] as TaskReplyCard[]
  const { result } = renderHook(
    () => {
      const dispatch = useNotificationCommentDispatch({
        projectId: 'project',
        issueId: 'issue',
        store: 'backend',
      })
      return useTaskReplyQueue({
        store,
        scope: 'issue',
        cards,
        enabled: true,
        busy: () => false,
        dispatch: (card, reply) => dispatch(card.root.messageId, reply, () => send(reply.content)),
        sendFailedText: 'The request is no longer pending',
      })
    },
    {
      wrapper: ({ children }) => (
        <RuntimeInteractionsContext.Provider value={value}>
          {children}
        </RuntimeInteractionsContext.Provider>
      ),
    }
  )
  act(() => {
    result.current.enqueue('root', 'First answer', [], [], item.id)
    result.current.enqueue('root', 'Second unsent answer', [], [], item.id)
  })
  await waitFor(() => {
    expect(result.current.messages('root')).toHaveLength(1)
    expect(result.current.messages('root')[0]).toMatchObject({
      content: 'Second unsent answer',
      interactionId: item.id,
      status: 'failed',
      error: 'The request is no longer pending',
    })
  })
  expect(send).toHaveBeenCalledExactlyOnceWith('First answer')
  expect(value.respond).toHaveBeenCalledOnce()
  expect(value.pending).toEqual([])
  expect(value.history).toEqual([{ id: item.id }])
})
