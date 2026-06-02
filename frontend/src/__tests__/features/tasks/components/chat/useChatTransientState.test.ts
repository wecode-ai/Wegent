import { act, renderHook } from '@testing-library/react'
import { useChatTransientState } from '@/features/tasks/components/chat/useChatTransientState'

type UseChatTransientStateTestProps = {
  selectedTaskId?: number | null
}

describe('useChatTransientState', () => {
  it('clears a resolved pending task id when no task is selected', () => {
    const initialProps: UseChatTransientStateTestProps = { selectedTaskId: 42 }

    const { result, rerender } = renderHook(
      ({ selectedTaskId }: UseChatTransientStateTestProps) =>
        useChatTransientState({ selectedTaskId }),
      {
        initialProps,
      }
    )

    act(() => {
      result.current.setPendingTaskId(42)
    })

    rerender({ selectedTaskId: null })

    expect(result.current.pendingTaskId).toBeNull()
  })

  it('keeps a temporary pending task id while a new task is being created', () => {
    const { result } = renderHook(() => useChatTransientState({ selectedTaskId: null }))

    act(() => {
      result.current.setPendingTaskId(-123)
    })

    expect(result.current.pendingTaskId).toBe(-123)
  })
})
