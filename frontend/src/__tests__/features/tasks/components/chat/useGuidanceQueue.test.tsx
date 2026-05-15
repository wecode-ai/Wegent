import { act, renderHook } from '@testing-library/react'
import { useGuidanceQueue } from '@/features/tasks/components/chat/useGuidanceQueue'

function guidance(content: string, taskId = 42) {
  return {
    taskId,
    guidanceId: `guidance-${content}`,
    content,
  }
}

describe('useGuidanceQueue', () => {
  it('removes pending guidance when it is applied', () => {
    const { result } = renderHook(() => useGuidanceQueue({ taskId: 42 }))

    act(() => {
      result.current.enqueue(guidance('first'))
    })

    expect(result.current.activeGuidanceQueue).toHaveLength(1)

    act(() => {
      result.current.markApplied('guidance-first')
    })

    expect(result.current.activeGuidanceQueue).toEqual([])
    expect(result.current.guidanceQueue).toEqual([])
  })

  it('removes expired guidance only after cleanup', () => {
    const { result } = renderHook(() => useGuidanceQueue({ taskId: 42 }))

    act(() => {
      result.current.enqueue(guidance('first'))
      result.current.markExpired('guidance-first', 'timed out')
    })

    expect(result.current.activeGuidanceQueue).toHaveLength(1)
    expect(result.current.activeGuidanceQueue[0]).toMatchObject({
      guidanceId: 'guidance-first',
      status: 'expired',
      error: 'timed out',
    })

    act(() => {
      result.current.removeExpiredGuidance()
    })

    expect(result.current.activeGuidanceQueue).toEqual([])
    expect(result.current.guidanceQueue).toEqual([])
  })
})
