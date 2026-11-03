import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCollaborationTranslator } from '@wegent/collaboration'
import type { ProjectBoardStatePort } from '@wegent/collaboration/project-board'
import { useParentIssueBoard } from '@wegent/collaboration/project-board'

describe('parent board personal layout', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  it('keeps layout toggles usable when host storage reads and writes fail', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Blocked', 'SecurityError')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Full', 'QuotaExceededError')
    })
    const { result, rerender } = renderHook(
      ({ scope }) =>
        useParentIssueBoard({
          scope,
          enabled: true,
          items: [],
          columns: [],
          currentParentId: null,
          state: {} as ProjectBoardStatePort,
          getColumnItems: () => [],
          translate: createCollaborationTranslator('zh-CN'),
        }),
      { initialProps: { scope: 'user:a' } }
    )
    expect(result.current.active).toBe(false)
    act(() => result.current.toggle!.props.onClick())
    expect(result.current.active).toBe(true)
    act(() => result.current.toggle!.props.onClick())
    expect(result.current.active).toBe(false)
    rerender({ scope: 'user:b' })
    expect(result.current.active).toBe(false)
  })

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
