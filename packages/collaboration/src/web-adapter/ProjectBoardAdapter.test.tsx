// @vitest-environment jsdom

import { act, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { ProjectBoardAdapter } from './ProjectBoardAdapter'
import { createCollaborationTranslator } from '../i18n'

describe('parent board creation context', () => {
  it('keeps the current board parent when creating from an empty status column', () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const container = document.createElement('div')
    const root = createRoot(container)
    const parent = { id: 'parent', title: 'Parent', parent_id: null, tags: [], status: 'pending' }
    const child = { ...parent, id: 'child', title: 'Child', parent_id: parent.id }
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
