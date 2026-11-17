import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  SharedIssueDetailEditor,
  type SharedIssueDetailExtensionContext,
  type SharedIssueDetailPort,
  type SharedEditorIssue,
  type SharedEditorProject,
} from '@wegent/collaboration'

function setup(canAssign = true, editable = true, outside = false) {
  const item = {
    id: 'issue',
    cloud_project_id: 'project',
    title: 'Transfer',
    description: '',
    status: 'inbox',
    priority: 'none',
    tags: [],
    version: 1,
    assignee_user_id: outside ? 5 : null,
    assignee_name: outside ? 'Outside person' : null,
    created_at: '2026-11-03T00:00:00Z',
    updated_at: '2026-11-03T00:00:00Z',
  } as SharedEditorIssue
  const project = {
    id: 'project',
    name: 'Project',
    project_store: 'backend',
    access_role: 'Owner',
  } as SharedEditorProject
  const port = {
    issues: {
      get: vi.fn(async () => ({ ...item, version: 7 })),
      assign: vi.fn(async () => ({ ...item, version: 8 })),
      update: vi.fn(async () => ({ ...item, version: 8 })),
    },
    members: {
      list: vi.fn(async () => [
        { user_id: 1, user_name: 'Member', role: 'Developer' },
        { user_id: 2, user_name: 'Viewer', role: 'Viewer' },
        { user_id: 3, user_name: 'Ineligible', role: 'Developer', can_be_assignee: false },
      ]),
    },
    agents: {
      list: vi.fn(async () => [
        { id: 'bot', name: 'Agent', status: 'active' },
        { id: 'inactive', name: 'Inactive', status: 'inactive' },
      ]),
    },
    collaborationGroups: { list: vi.fn(async () => [{ id: 'squad', name: 'Squad' }]) },
    attachments: { list: vi.fn(async () => []) },
    collaborators: { list: vi.fn(async () => []) },
    taskBindings: { list: vi.fn(async () => []) },
    deliveries: { list: vi.fn(async () => []) },
  }
  let context: SharedIssueDetailExtensionContext
  const onUpdated = vi.fn()
  const editor = (
    currentItem: SharedEditorIssue,
    currentProject: SharedEditorProject | undefined
  ) => (
    <SharedIssueDetailEditor
      mode="edit"
      item={currentItem}
      project={currentProject}
      editable={editable}
      canAssign={canAssign}
      allItems={[currentItem]}
      port={port as unknown as SharedIssueDetailPort}
      onUpdated={onUpdated}
      onClose={vi.fn()}
      extensions={{
        renderActivity: value => {
          context = value
          return null
        },
      }}
    />
  )
  const view = render(editor(item, project))
  return {
    port,
    item,
    onUpdated,
    getAssignment: () => context.commentAssignment,
    switchToInvited: () =>
      view.rerender(
        editor(
          {
            ...item,
            id: 'invited',
            cloud_project_id: 'another-project',
            invited_only: true,
            assignee_user_id: 1,
            assignee_name: 'Member',
          },
          undefined
        )
      ),
  }
}

describe('Issue comment assignment persistence', () => {
  it('does not reuse another project roster to bypass a new Issue invitation confirmation', async () => {
    const { port, getAssignment, switchToInvited } = setup()
    await waitFor(() =>
      expect(getAssignment()?.options.some(option => option.value === 'group:squad')).toBe(true)
    )
    switchToInvited()
    await waitFor(() => expect(getAssignment()?.options.map(option => option.value)).toEqual(['1']))
    let operation!: Promise<void | boolean>
    act(() => {
      operation = getAssignment()!.assign('1')
    })
    fireEvent.click(await screen.findByTestId('issue-outside-assignee-cancel'))
    expect(await operation).toBe(false)
    expect(port.issues.assign).not.toHaveBeenCalled()
    expect(port.members.list).toHaveBeenCalledOnce()
  })

  it('requires confirmation when comment assignment selects a non-project person', async () => {
    const { port, item, getAssignment } = setup(true, true, true)
    port.issues.get.mockResolvedValue({ ...item, assignee_user_id: null, version: 7 })
    await waitFor(() =>
      expect(getAssignment()?.options.some(option => option.value === '5')).toBe(true)
    )
    let operation!: Promise<void | boolean>
    act(() => {
      operation = getAssignment()!.assign('5')
    })
    expect(await screen.findByTestId('issue-outside-assignee-cancel')).toBeVisible()
    expect(port.issues.assign).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('issue-outside-assignee-cancel'))
    expect(await operation).toBe(false)
    expect(port.issues.assign).not.toHaveBeenCalled()
    act(() => {
      operation = getAssignment()!.assign('5')
    })
    fireEvent.click(await screen.findByTestId('issue-outside-assignee-confirm'))
    await act(async () => {
      await operation
    })
    expect(port.issues.assign).toHaveBeenCalledExactlyOnceWith('project', 'issue', {
      version: 7,
      assigneeType: 'user',
      assigneeId: '5',
      notifyAssignee: true,
    })
  })

  it.each([
    ['1', { assigneeType: 'user', assigneeId: '1', notifyAssignee: true }],
    ['2', { assigneeType: 'user', assigneeId: '2', notifyAssignee: true }],
    ['agent:bot', { assigneeType: 'agent', assigneeId: 'bot' }],
    ['group:squad', null],
  ])(
    'persists %s through the Issue assignment flow using its latest version',
    async (target, input) => {
      const { port, onUpdated, getAssignment } = setup()
      await waitFor(() =>
        expect(getAssignment()?.options.map(option => option.value)).toEqual([
          'group:squad',
          '1',
          '2',
          'agent:bot',
        ])
      )
      await act(async () => getAssignment()!.assign(target))
      expect(port.issues.get).toHaveBeenCalledWith('issue')
      if (input) {
        expect(port.issues.assign).toHaveBeenCalledWith('project', 'issue', {
          version: 7,
          ...input,
        })
        expect(port.issues.update).not.toHaveBeenCalled()
      } else {
        expect(port.issues.update).toHaveBeenCalledWith('issue', {
          version: 7,
          assignee_group_id: 'squad',
        })
        expect(port.issues.assign).not.toHaveBeenCalled()
      }
      expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ version: 8 }))
    }
  )

  it('keeps parent assignment forbidden while allowing editable Issues to create children', async () => {
    const { port, getAssignment } = setup(false)
    await waitFor(() => expect(getAssignment()?.options.length).toBe(4))
    expect(getAssignment()?.canAssignCurrent).toBe(false)
    expect(getAssignment()?.createChild).toBeTypeOf('function')
    await expect(getAssignment()!.assign('1')).rejects.toThrow()
    expect(port.issues.assign).not.toHaveBeenCalled()
    expect(port.issues.update).not.toHaveBeenCalled()
  })

  it('omits both assignment actions on read-only Issues', async () => {
    const { port, getAssignment } = setup(false, false)
    await waitFor(() => expect(port.members.list).toHaveBeenCalled())
    expect(getAssignment()).toBeUndefined()
  })
})
