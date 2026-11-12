// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { createCollaborationTranslator } from '../i18n'
import { collectIssueChildrenProgress, IssueChildrenProgress } from './IssueChildrenProgress'

describe('collectIssueChildrenProgress', () => {
  it('counts unique visible, unarchived direct children separately at each level', () => {
    const child = { id: 'child', parent_id: 'parent', status: 'completed' }
    const result = collectIssueChildrenProgress([
      { id: 'parent', parent_id: null, status: 'pending' },
      child,
      child,
      { id: 'pending', parent_id: 'parent', status: 'pending' },
      { id: 'running', parent_id: 'parent', status: 'in_progress' },
      { id: 'review', parent_id: 'parent', status: 'in_review' },
      { id: 'cancelled', parent_id: 'parent', status: 'cancelled' },
      { ...child, id: 'hidden', can_view_detail: false },
      { ...child, id: 'archived', archived_at: '2026-11-04' },
      { ...child, id: 'grandchild', parent_id: child.id },
    ])
    expect(result.get('parent')).toEqual({ completed: 1, total: 5 })
    expect(result.get('child')).toEqual({ completed: 1, total: 1 })
    expect(result.has('pending')).toBe(false)
    expect(collectIssueChildrenProgress([]).size).toBe(0)
  })
})

describe('IssueChildrenProgress', () => {
  it.each([0, 2, 5])('renders %i/5 with the matching ring and updates with new data', completed => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const container = document.createElement('div')
    const root = createRoot(container)
    const onOpen = vi.fn()
    const onCardOpen = vi.fn()
    const render = (locale: 'zh-CN' | 'en', value: number) => (
      <div onClick={onCardOpen}>
        <IssueChildrenProgress
          itemId="parent"
          progress={{ completed: value, total: 5 }}
          translate={createCollaborationTranslator(locale)}
          onOpen={onOpen}
        />
      </div>
    )
    try {
      act(() => root.render(render('zh-CN', completed)))
      const button = container.querySelector('button')!
      expect(button.type).toBe('button')
      expect(button.textContent).toBe(`子任务 ${completed}/5`)
      expect(button.getAttribute('aria-label')).toBe(
        `已完成 ${completed}/5 个子任务，点击进入子任务看板`
      )
      expect(container.querySelector('circle[pathLength]')?.getAttribute('stroke-dasharray')).toBe(
        `${completed / 5} 1`
      )
      expect(container.querySelector('svg')?.classList.contains('text-emerald-600')).toBe(
        completed === 5
      )
      act(() => button.click())
      expect(onOpen).toHaveBeenCalledOnce()
      expect(onCardOpen).not.toHaveBeenCalled()
      act(() => root.render(render('en', 3)))
      expect(button.textContent).toBe('Sub-Threads 3/5')
      expect(button.getAttribute('aria-label')).toBe(
        '3 of 5 sub-Threads completed. Open the sub-Thread board'
      )
      expect(container.querySelector('circle[pathLength]')?.getAttribute('stroke-dasharray')).toBe(
        '0.6 1'
      )
    } finally {
      act(() => root.unmount())
    }
  })
})
