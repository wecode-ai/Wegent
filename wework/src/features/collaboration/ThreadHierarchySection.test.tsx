import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { CollaborationIssue, CollaborationProject } from '@wegent/collaboration'
import type { ChatGroup } from '@/api/chatGroups'
import { ThreadHierarchySection } from './ThreadHierarchySection'

const group = { id: 'group', role: 'Developer', status: 'active' } as ChatGroup
const issue = (id: string, parent_id: string | null = null, status = 'pending') =>
  ({
    id,
    title: id,
    parent_id,
    status,
    cloud_project_id: group.id,
    group_id: group.id,
  }) as CollaborationIssue

describe('Thread hierarchy in metadata', () => {
  it('shows direct progress and both navigation directions without exposing foreign or unreadable children', () => {
    const parent = issue('parent')
    const current = issue('current', parent.id)
    const completed = issue('completed-child', current.id, 'completed')
    const pending = issue('pending-child', current.id)
    const grandchild = issue('grandchild', pending.id, 'completed')
    const restricted = { ...issue('restricted-child', current.id), can_view_detail: false }
    const foreign = { ...issue('project-only-child', current.id), cloud_project_id: 'project' }
    const onOpenThread = vi.fn()
    render(
      <ThreadHierarchySection
        context={{ item: current, requestLeave: action => action() }}
        group={group}
        items={[parent, current, completed, pending, grandchild, restricted, foreign]}
        locale="zh-CN"
        onOpenThread={onOpenThread}
        onCreateChild={vi.fn()}
      />
    )
    expect(screen.getByTestId('issue-children-progress')).toHaveTextContent('1/2')
    expect(screen.queryByText('restricted-child')).not.toBeInTheDocument()
    expect(screen.queryByText('project-only-child')).not.toBeInTheDocument()
    expect(screen.queryByText('grandchild')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('issue-parent-link'))
    fireEvent.click(screen.getByText('pending-child'))
    expect(onOpenThread.mock.calls).toEqual([[parent.id], [pending.id]])
  })

  it('waits for the existing description leave guard before creating a child with its authorized classification', () => {
    const current = issue('current')
    const project = {
      id: 'classification',
      access_role: 'Owner',
      status: 'active',
    } as CollaborationProject
    let proceed: (() => void) | undefined
    const onCreateChild = vi.fn()
    render(
      <ThreadHierarchySection
        context={{
          item: current,
          classificationProject: project,
          requestLeave: action => {
            proceed = action
          },
        }}
        group={group}
        items={[current]}
        locale="zh-CN"
        onOpenThread={vi.fn()}
        onCreateChild={onCreateChild}
      />
    )
    fireEvent.click(screen.getByTestId('issue-hierarchy-add-child'))
    expect(onCreateChild).not.toHaveBeenCalled()
    proceed?.()
    expect(onCreateChild).toHaveBeenCalledExactlyOnceWith(current, project)
  })

  it.each([
    { ...group, role: 'Viewer' as const },
    { ...group, status: 'archived' as const },
  ])('keeps readable progress while withholding child creation for $role / $status', readOnly => {
    const current = issue('current')
    render(
      <ThreadHierarchySection
        context={{ item: current, requestLeave: action => action() }}
        group={readOnly}
        items={[current, issue('child', current.id, 'completed')]}
        locale="zh-CN"
        onOpenThread={vi.fn()}
        onCreateChild={vi.fn()}
      />
    )
    expect(screen.getByTestId('issue-children-progress')).toHaveTextContent('1/1')
    expect(screen.queryByTestId('issue-hierarchy-add-child')).not.toBeInTheDocument()
  })

  it('does not render a stale Thread from a different owning group', () => {
    const current = { ...issue('foreign'), cloud_project_id: 'other', group_id: 'other' }
    render(
      <ThreadHierarchySection
        context={{ item: current, requestLeave: action => action() }}
        group={group}
        items={[current, { ...issue('foreign-child', current.id), cloud_project_id: 'other' }]}
        locale="zh-CN"
        onOpenThread={vi.fn()}
        onCreateChild={vi.fn()}
      />
    )
    expect(screen.queryByTestId('issue-hierarchy-summary')).not.toBeInTheDocument()
  })
})
