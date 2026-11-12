// @vitest-environment jsdom

import { act, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { ProjectBoardAdapter } from './ProjectBoardAdapter'
import { createCollaborationTranslator } from '../i18n'

describe('board card sub-issue progress', () => {
  it('keeps full child progress across filters, grouping and updates, and opens the child board', () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const container = document.createElement('div')
    const root = createRoot(container)
    const parent = {
      id: 'parent',
      title: 'Parent',
      parent_id: null,
      tags: [],
      status: 'pending',
      priority: 'medium',
      sequence_number: 1,
      created_at: '2026-11-04T00:00:00Z',
      updated_at: '2026-11-04T00:00:00Z',
    }
    const child = {
      ...parent,
      id: 'child',
      title: 'Child',
      parent_id: parent.id,
      status: 'completed',
    }
    const onOpen = vi.fn()
    const props = {
      parentGroupingEnabled: true,
      project: {
        id: 'project',
        project_key: 'TEST',
        name: 'Project',
        project_store: 'local',
        task_provider: 'local',
        tags: [],
      },
      issues: [parent, child, { ...child, id: 'second', status: 'pending' }],
      agents: [],
      members: [],
      taskBindings: [],
      boardError: null,
      statuses: [
        { id: 'pending', name: 'Pending', color: 'gray' },
        { id: 'completed', name: 'Completed', color: 'green' },
      ],
      labels: {
        groupBy: 'Group',
        groupStatus: 'Status',
        groupAssignee: 'Assignee',
        groupPriority: 'Priority',
        groupTag: 'Tag',
        noIssues: 'Empty',
        noPriority: 'None',
        noTag: 'None',
        search: 'Search',
        unassigned: 'None',
      },
      translate: createCollaborationTranslator('zh-CN'),
      onCreateIssue: vi.fn(),
      onMove: vi.fn(),
      onOpen,
    } as unknown as ComponentProps<typeof ProjectBoardAdapter>
    try {
      act(() => root.render(<ProjectBoardAdapter {...props} />))
      const selector = '[data-testid="collaboration-issue-children-parent"]'
      const milestone = { id: 'ms', project_id: 'project', title: 'Release target', description: '', state: 'open' as const, due_on: null, version: 1, open_issues: 2, closed_issues: 1 }
      const linked = props.issues.map(issue => ({ ...issue, milestone_id: milestone.id }))
      act(() => root.render(<ProjectBoardAdapter {...props} issues={linked} milestones={[milestone]} />))
      const milestoneSelector = '[data-testid="cloud-todo-card-milestone-parent"]'
      expect(container.querySelector(milestoneSelector)?.textContent).toContain('Release target')
      act(() => container.querySelector<HTMLButtonElement>('[data-testid="cloud-board-parent-layout"]')!.click())
      expect(container.querySelector('[data-testid="cloud-board-parent-rows"]')).toBeTruthy()
      const parentHeader = container.querySelector('[data-testid="cloud-board-parent-row-parent"] > header')
      expect(parentHeader?.querySelector('[data-testid="cloud-board-parent-open-parent"]')).toBeTruthy()
      expect(parentHeader?.querySelector(milestoneSelector)?.textContent).toContain('Release target')
      act(() => container.querySelector<HTMLButtonElement>('[data-testid="cloud-board-parent-layout"]')!.click())
      act(() => root.render(<ProjectBoardAdapter {...props} issues={linked} milestones={[]} />))
      expect(container.querySelector(milestoneSelector)).toBeNull()
      act(() => root.render(<ProjectBoardAdapter {...props} issues={linked.map(issue => ({ ...issue, can_view_detail: false }))} milestones={[milestone]} />))
      expect(container.querySelector(milestoneSelector)).toBeNull()
      act(() => root.render(<ProjectBoardAdapter {...props} />))
      expect(container.querySelector(selector)?.textContent).toBe('子任务 1/2')
      expect(
        container.querySelector('[data-testid="collaboration-issue-children-child"]')
      ).toBeNull()
      act(() =>
        root.render(
          <ProjectBoardAdapter {...props} allIssues={props.issues} issues={[props.issues[0]]} />
        )
      )
      expect(container.querySelector(selector)?.textContent).toBe('子任务 1/2')
      expect(container.querySelector('[data-testid="cloud-todo-card-child"]')).toBeNull()
      expect(container.querySelector('[data-testid="cloud-todo-card-second"]')).toBeNull()
      act(() =>
        root.render(
          <ProjectBoardAdapter
            {...props}
            issues={props.issues.map(issue => ({ ...issue, can_view_detail: false }))}
          />
        )
      )
      expect(container.querySelector(selector)).toBeNull()
      act(() => root.render(<ProjectBoardAdapter {...props} />))
      const search = container.querySelector<HTMLInputElement>(
        '[data-testid="cloud-board-search"]'
      )!
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          search,
          'Parent'
        )
        search.dispatchEvent(new Event('input', { bubbles: true }))
      })
      expect(search.value).toBe('Parent')
      expect(container.querySelector(selector)?.textContent).toBe('子任务 1/2')
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, '')
        search.dispatchEvent(new Event('input', { bubbles: true }))
      })
      act(() =>
        container.querySelector<HTMLButtonElement>('[data-testid="cloud-board-group-by"]')!.click()
      )
      act(() =>
        document
          .querySelector<HTMLButtonElement>('[data-testid="cloud-board-group-option-priority"]')!
          .click()
      )
      expect(container.querySelector(selector)?.textContent).toBe('子任务 1/2')
      act(() =>
        root.render(
          <ProjectBoardAdapter
            {...props}
            issues={props.issues.map(issue =>
              issue.id === 'second' ? { ...issue, status: 'completed' } : issue
            )}
          />
        )
      )
      expect(container.querySelector(selector)?.textContent).toBe('子任务 2/2')
      const onCurrentParentIdChange = vi.fn()
      const onOpenChildren = vi.fn(() =>
        root.render(<ProjectBoardAdapter {...props} allIssues={props.issues} />)
      )
      act(() =>
        root.render(
          <ProjectBoardAdapter
            {...props}
            allIssues={props.issues}
            issues={[props.issues[0]]}
            onOpenChildren={onOpenChildren}
            onCurrentParentIdChange={onCurrentParentIdChange}
          />
        )
      )
      expect(container.querySelector('[data-testid="cloud-todo-card-child"]')).toBeNull()
      act(() => container.querySelector<HTMLButtonElement>(selector)!.click())
      expect(onOpenChildren).toHaveBeenCalledWith(props.issues[0])
      expect(onCurrentParentIdChange).toHaveBeenCalledWith(props.issues[0].id)
      expect(onOpen).not.toHaveBeenCalled()
      expect(container.querySelector(selector)).toBeNull()
      expect(container.textContent).toContain('Child')
    } finally {
      act(() => root.unmount())
      localStorage.clear()
    }
  })
})

describe('parent board creation context', () => {
  it('keeps the current board parent when creating from an empty status column', () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const container = document.createElement('div')
    const root = createRoot(container)
    const parent = {
      id: 'parent',
      title: 'Parent',
      parent_id: null,
      tags: [],
      status: 'pending',
    }
    const child = {
      ...parent,
      id: 'child',
      title: 'Child',
      parent_id: parent.id,
    }
    const onCreateIssue = vi.fn()
    const onCreateUnmatchedIssue = vi.fn()
    const props = {
      project: {
        id: 'project',
        name: 'Project',
        project_store: 'local',
        task_provider: 'local',
        tags: [],
      },
      issues: [parent, child],
      agents: [],
      members: [],
      taskBindings: [],
      statuses: [
        { id: 'inbox', name: 'Inbox', color: 'gray' },
        { id: 'pending', name: 'Pending', color: 'blue' },
      ],
      labels: {
        groupBy: 'Group',
        groupStatus: 'Status',
        groupAssignee: 'Assignee',
        groupPriority: 'Priority',
        groupTag: 'Tag',
        noIssues: 'Empty',
        noPriority: 'None',
        noTag: 'None',
        search: 'Search',
        unassigned: 'None',
      },
      translate: createCollaborationTranslator('zh-CN'),
      boardError: null,
      parentGroupingEnabled: true,
      renderIssueCard: () => null,
      onCreateIssue,
      onCreateUnmatchedIssue,
      onMove: vi.fn(),
      onOpen: vi.fn(),
    } as unknown as ComponentProps<typeof ProjectBoardAdapter>
    try {
      act(() => root.render(<ProjectBoardAdapter {...props} />))
      act(() =>
        container
          .querySelector<HTMLButtonElement>('[data-testid="cloud-board-parent-layout"]')!
          .click()
      )
      act(() =>
        container
          .querySelector<HTMLButtonElement>('[data-testid="cloud-board-parent-enter-parent"]')!
          .click()
      )
      act(() =>
        container
          .querySelector<HTMLButtonElement>('[data-testid="cloud-todo-column-empty-add-inbox"]')!
          .click()
      )
      expect(onCreateUnmatchedIssue).toHaveBeenCalledWith(
        expect.objectContaining({ parent, status: 'inbox', tags: [] })
      )
      expect(onCreateIssue).not.toHaveBeenCalled()
      act(() =>
        root.render(
          <ProjectBoardAdapter
            {...props}
            issues={props.issues.map(issue =>
              issue.id === parent.id ? { ...issue, can_view_detail: false } : issue
            )}
          />
        )
      )
      expect(
        container.querySelector('[data-testid="cloud-todo-column-empty-add-inbox"]')
      ).toBeNull()
    } finally {
      act(() => root.unmount())
      localStorage.clear()
    }
  })
})
