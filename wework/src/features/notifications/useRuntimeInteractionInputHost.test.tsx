import { renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import {
  RuntimeInteractionsContext,
  type RuntimeInteractionsValue,
} from './RuntimeInteractionsContext'
import { useRuntimeInteractionInputHost } from './useRuntimeInteractionInputHost'
import { interactionQuestion, interactionTask } from './runtimeInteractions.fixtures'
import { interactionId, interactionResponse, type RuntimeInteraction } from './runtimeInteractions'

const item: RuntimeInteraction = {
  id: interactionId(interactionTask, 'item:compatibility-choice'),
  requestKey: 'item:compatibility-choice',
  task: interactionTask,
  payload: interactionQuestion,
  question: 'Question',
  createdAt: 0,
  answered: false,
}
function host(overrides: Partial<RuntimeInteractionsValue> = {}, taskId = 'review') {
  const value: RuntimeInteractionsValue = {
    pending: [item],
    history: [],
    errors: {},
    drafts: { [item.id]: 'Saved reply' },
    replyDrafts: [],
    busy: new Set(),
    loading: false,
    setDraft: vi.fn(),
    respond: vi.fn().mockResolvedValue(true),
    refresh: vi.fn(),
    open: vi.fn(),
    notice: null,
    dismissNotice: vi.fn(),
    dismiss: vi.fn(),
    registerView: vi.fn(),
    ...overrides,
  }
  const { result } = renderHook(
    () => useRuntimeInteractionInputHost({ ...interactionTask.address, taskId }, true),
    {
      wrapper: ({ children }) => (
        <RuntimeInteractionsContext.Provider value={value}>
          {children}
        </RuntimeInteractionsContext.Provider>
      ),
    }
  )
  return { value, result }
}
const response = interactionResponse(interactionQuestion, { compatibility: { answers: ['keep'] } })

it('shares the existing draft and submission coordinator with the original controls', async () => {
  const { value, result } = host()
  expect(result.current!.getDraft(interactionQuestion)).toEqual({ compatibility: 'Saved reply' })
  result.current!.setDraft(interactionQuestion, { compatibility: 'Updated' })
  expect(value.setDraft).toHaveBeenCalledExactlyOnceWith(item.id, 'Updated')
  expect(await result.current!.submit(response, interactionQuestion)).toBe(true)
  expect(value.respond).toHaveBeenCalledExactlyOnceWith(item, 'keep')
})
it('does not fall through to an uncoordinated send for an unregistered ordinary request', async () => {
  const { value, result } = host({ pending: [] })
  expect(await result.current!.submit(response, interactionQuestion)).toBe(false)
  expect(value.respond).not.toHaveBeenCalled()
})
it('does not share drafts or submission authority across tasks with matching request keys', async () => {
  const { value, result } = host({}, 'another-task')
  expect(result.current!.getDraft(interactionQuestion)).toBeUndefined()
  expect(await result.current!.submit(response, interactionQuestion)).toBe(false)
  expect(value.respond).not.toHaveBeenCalled()
})
it('leaves native approval and complex forms on the original handlers', async () => {
  const payload = { ...interactionQuestion, approvalKind: 'command' }
  const { value, result } = host({ pending: [{ ...item, payload }] })
  expect(await result.current!.submit(response, payload)).toBeUndefined()
  expect(value.respond).not.toHaveBeenCalled()
})
it('blocks a stale native form after the request moves into history', async () => {
  const { result } = host({
    pending: [],
    history: [
      {
        id: item.id,
        title: 'Task',
        question: 'Question',
        address: item.task.address,
        answeredAt: 1,
      },
    ],
  })
  expect(await result.current!.submit(response, interactionQuestion)).toBe(false)
})

it('restores an offline draft without enabling submission before the live request is revalidated', async () => {
  const cached = {
    ...item,
    cached: true,
    payload: { kind: 'request_user_input' },
    task: { ...item.task, workspace: { ...item.task.workspace, available: false } },
  }
  const { result, value } = host({ pending: [cached] })
  expect(result.current!.getDraft(interactionQuestion)).toEqual({ compatibility: 'Saved reply' })
  expect(result.current!.isDisabled(interactionQuestion)).toBe(true)
  expect(result.current!.isSubmitting(interactionQuestion)).toBe(false)
  expect(await result.current!.submit(response, interactionQuestion)).toBe(false)
  expect(value.respond).not.toHaveBeenCalled()
})

it('distinguishes an active submission from disabled cached or unregistered input', () => {
  const { result } = host({ busy: new Set([item.id]) })
  expect(result.current!.isSubmitting(interactionQuestion)).toBe(true)
  expect(result.current!.isDisabled(interactionQuestion)).toBe(true)
})
