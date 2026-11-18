import { renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { expect, test, vi } from 'vitest'
import {
  QuestionDiscussionContext,
  useQuestionDiscussionPanels,
  type QuestionDiscussionRequest,
} from './questionDiscussion'

const source = { deviceId: 'device-a', taskId: 'task-a' }

test('routes commands by both device and task, consumes once and waits for the active pane', () => {
  const openTab = vi.fn()
  let request: QuestionDiscussionRequest = { key: 'question', source }
  const { result, rerender: rerenderPanels } = renderHook(useQuestionDiscussionPanels, {
    initialProps: { address: source, active: false },
    wrapper: ({ children }: { children: ReactNode }) => (
      <QuestionDiscussionContext.Provider value={{ request, open: vi.fn() }}>
        {children}
      </QuestionDiscussionContext.Provider>
    ),
  })
  let previous = result.current.snapshot.activation
  const rerender = ({
    address,
    active,
  }: {
    address: typeof source
    active: boolean
    openTab: typeof openTab
  }) => {
    rerenderPanels({ address, active })
    const activation = result.current.snapshot.activation
    if (activation && activation !== previous) openTab(activation.tab)
    previous = activation
  }
  expect(openTab).not.toHaveBeenCalled()
  rerender({ address: { ...source, deviceId: 'device-b' }, active: true, openTab })
  rerender({ address: { ...source, taskId: 'task-b' }, active: true, openTab })
  expect(openTab).not.toHaveBeenCalled()
  rerender({ address: source, active: true, openTab })
  expect(openTab).toHaveBeenCalledExactlyOnceWith('discussion:question')
  rerender({ address: source, active: true, openTab })
  expect(openTab).toHaveBeenCalledTimes(1)
  rerender({ address: { ...source, taskId: 'task-b' }, active: true, openTab })
  rerender({ address: source, active: true, openTab })
  expect(openTab).toHaveBeenCalledTimes(1)
  request = { ...request }
  rerender({ address: source, active: true, openTab })
  expect(openTab).toHaveBeenCalledTimes(2)
})
