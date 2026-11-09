import { renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { expect, test, vi } from 'vitest'
import {
  QuestionDiscussionContext,
  useQuestionDiscussionWorkspacePanel,
  type QuestionDiscussionRequest,
} from './questionDiscussion'

const source = { deviceId: 'device-a', taskId: 'task-a' }

test('routes commands by both device and task, consumes once and waits for the active pane', () => {
  const openTab = vi.fn()
  let request: QuestionDiscussionRequest = { key: 'question', source }
  const { rerender } = renderHook(useQuestionDiscussionWorkspacePanel, {
    initialProps: { address: source, active: false, openTab },
    wrapper: ({ children }: { children: ReactNode }) => (
      <QuestionDiscussionContext.Provider value={{ request, open: vi.fn() }}>
        {children}
      </QuestionDiscussionContext.Provider>
    ),
  })
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
