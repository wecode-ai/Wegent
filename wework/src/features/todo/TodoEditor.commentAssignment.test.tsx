import { act, render, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  SharedIssueDetailEditor,
  type SharedIssueDetailExtensionContext,
  type SharedIssueDetailPort,
  type SharedEditorIssue,
  type SharedEditorProject,
} from '@wegent/collaboration'

function setup(canAssign = true, editable = true) {
  const item = {
    id: 'issue',
    cloud_project_id: 'project',
    title: 'Transfer',
    description: '',
    status: 'inbox',
    priority: 'none',
    tags: [],
    version: 1,
    assignee_user_id: null,
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
  render(
    <SharedIssueDetailEditor
      mode="edit"
      item={item}
      project={project}
      editable={editable}
      canAssign={canAssign}
      allItems={[item]}
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
  return { port, onUpdated, getAssignment: () => context.commentAssignment }
}

describe('Issue comment assignment persistence', () => {
  it.each([
    ['1', { assigneeType: 'user', assigneeId: '1', notifyAssignee: true }],
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
    await waitFor(() => expect(getAssignment()?.options.length).toBe(3))
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
