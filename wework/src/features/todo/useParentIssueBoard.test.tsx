import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createCollaborationTranslator } from '@wegent/collaboration'
import type { ProjectBoardStatePort } from '@wegent/collaboration/project-board'
import { useParentIssueBoard } from '@wegent/collaboration/project-board'

describe('parent board personal layout', () => {
  beforeEach(() => localStorage.clear())

  it('isolates personal layout between project and account scopes and preserves it on return', () => {
    const { result, rerender } = renderHook(
      ({ scope, enabled }) =>
        useParentIssueBoard({
          scope,
          enabled,
          items: [],
          columns: [],
          currentParentId: null,
          state: {} as ProjectBoardStatePort,
          getColumnItems: vi.fn(() => []),
          translate: createCollaborationTranslator('zh-CN'),
        }),
      { initialProps: { scope: 'user:project-a', enabled: true } }
    )
    expect(result.current.active).toBe(false)
    act(() => result.current.toggle!.props.onClick())
    expect(result.current.active).toBe(true)
    rerender({ scope: 'user:project-b', enabled: true })
    expect(result.current.active).toBe(false)
    rerender({ scope: 'other-user:project-a', enabled: true })
    expect(result.current.active).toBe(false)
    rerender({ scope: 'user:project-a', enabled: true })
    expect(result.current.active).toBe(true)
    rerender({ scope: 'user:project-a', enabled: false })
    expect(result.current.active).toBe(false)
    expect(result.current.toggle).toBeNull()
  })
})
