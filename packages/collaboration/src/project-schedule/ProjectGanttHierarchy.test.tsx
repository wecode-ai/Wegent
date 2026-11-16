// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CollaborationIssue } from '../types'
import { defaultScheduleViewOptions } from './model'
import { ProjectGanttView } from './ProjectGanttView'

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 10, 4, 12))
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
it('toggles nested tasks without opening the parent or changing dates, including in a collapsed task column', () => {
  const onOpen = vi.fn()
  const onSchedule = vi.fn()
  const issues = [
    ['parent', null],
    ['child', 'parent'],
    ['grandchild', 'child'],
  ].map(
    ([id, parent_id]) =>
      ({
        id,
        parent_id,
        title: id,
        start_at: '2026-11-04',
        due_at: '2026-11-06',
        status: 'inbox',
        tags: [],
        priority: 'none',
        can_edit: true,
      }) as CollaborationIssue,
  )
  act(() =>
    root.render(
      <ProjectGanttView
        issues={issues}
        statuses={[]}
        locale="en"
        viewOptions={defaultScheduleViewOptions}
        onOpen={onOpen}
        onSchedule={onSchedule}
      />,
    ),
  )
  const find = (id: string) =>
    container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  const click = (id: string) => act(() => find(id)!.click())
  expect(find('collaboration-gantt-row-grandchild')).not.toBeNull()
  click('collaboration-gantt-toggle-child')
  expect(find('collaboration-gantt-row-grandchild')).toBeNull()
  expect(
    find('collaboration-gantt-toggle-child')?.getAttribute('aria-expanded'),
  ).toBe('false')
  click('collaboration-gantt-toggle-parent')
  expect(find('collaboration-gantt-row-child')).toBeNull()
  click('collaboration-gantt-toggle-parent')
  expect(find('collaboration-gantt-row-child')).not.toBeNull()
  expect(find('collaboration-gantt-row-grandchild')).toBeNull()
  click('collaboration-gantt-toggle-task-column')
  click('collaboration-gantt-toggle-child')
  expect(find('collaboration-gantt-row-grandchild')).not.toBeNull()
  expect(find('collaboration-gantt-issue-grandchild')).not.toBeNull()
  expect(onOpen).not.toHaveBeenCalled()
  expect(onSchedule).not.toHaveBeenCalled()
})
