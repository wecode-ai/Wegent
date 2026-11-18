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
    discardDraft: vi.fn().mockResolvedValue(true),
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
it.each([{ answers: [] }, { answers: ['file-only'] }])(
  'preserves empty answers and attachments through coordination: %j',
  async ({ answers }) => {
    const { value, result } = host()
    const response = interactionResponse(interactionQuestion, {
      compatibility: {
        answers,
        attachments: [{ id: -1, filename: 'brief.txt' } as import('@/types/api').Attachment],
      },
    })
    expect(await result.current!.submit(response, interactionQuestion)).toBe(true)
    expect(value.respond).toHaveBeenCalledExactlyOnceWith(item, answers[0] ?? '继续', { response })
  }
)
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
