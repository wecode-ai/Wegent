import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import '@/i18n'
import type { ProjectChatClient } from '@/api/backend/projectChatSocket'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import type { ProjectSpaceDetailServices } from '@/features/workbench/workbenchServices'
import type { ProjectSpaceApi } from './projectSpaceSelection'
import { WorkItemContextPanel } from './WorkItemContextPanel'

const renderActivity = vi.hoisted(() => vi.fn())

vi.mock('./TaskActivityView', () => ({
  TaskActivityView: (props: unknown) => {
    renderActivity(props)
    return <div data-testid="issue-activity" />
  },
}))

const project = {
  id: '11',
  name: 'Project',
  project_store: 'local',
  current_user_id: 'project-user',
} as CloudProject
const item = {
  id: 'ISSUE-1',
  cloud_project_id: project.id,
  title: 'Issue',
  description: '',
  status: 'pending',
  version: 1,
  assignee_user_id: null,
  tags: [],
  can_edit: true,
  created_at: '2026-10-27T00:00:00Z',
  updated_at: '2026-10-27T00:00:00Z',
} as CloudLoopItem

function createServices() {
  const api = {
    listLoopItems: vi.fn(async () => ({ items: [item] })),
    listDeliveries: vi.fn(async () => ({ items: [] })),
    listTaskBindings: vi.fn(async () => []),
    listLoopItemAttachments: vi.fn(async () => []),
    listLoopItemCollaborators: vi.fn(async () => []),
    listCloudProjectMembers: vi.fn(async () => []),
  } as unknown as ProjectSpaceApi
  return {
    deliveryApi: api,
    projectChatClient: {} as ProjectChatClient,
    projectChatAgentApi: { list: vi.fn(async () => []) },
  } as unknown as ProjectSpaceDetailServices
}

describe('task-page Issue activity', () => {
  beforeEach(() => renderActivity.mockClear())

  it.each(['local', 'backend'] as const)(
    'uses the %s project services for a task on the local executor',
    async projectStore => {
      const local = createServices()
      const cloud = createServices()
      const expected = projectStore === 'local' ? local : cloud
      const other = projectStore === 'local' ? cloud : local
      const localProjects = [{ id: 91, name: 'Code workspace', tasks: [] }]
      render(
        <WorkItemContextPanel
          api={expected.deliveryApi}
          services={{ projectSpaceDetailServices: { local, cloud } }}
          project={{ ...project, project_store: projectStore }}
          item={item}
          currentTask={{ deviceId: 'local-device', taskId: 'runtime-1' }}
          currentUserId="account-user"
          localProjects={localProjects}
          onOpenBoard={vi.fn()}
          onOpenTask={vi.fn()}
        />
      )

      expect(await screen.findByTestId('issue-activity')).toBeInTheDocument()
      expect(screen.queryByTestId('cloud-todo-detail-activity-rail-empty')).not.toBeInTheDocument()
      await waitFor(() => expect(expected.projectChatAgentApi?.list).toHaveBeenCalledWith('11'))
      expect(other.projectChatAgentApi?.list).not.toHaveBeenCalled()
      expect(renderActivity.mock.calls.at(-1)?.[0].client).toBe(expected.projectChatClient)
      expect(renderActivity.mock.calls.at(-1)?.[0]).toMatchObject({
        client: expected.projectChatClient,
        project: { id: project.id, project_store: projectStore },
        task: { id: item.id },
        projectChatAgentApi: expected.projectChatAgentApi,
        currentUserId: 'project-user',
        localProjects,
        selfManagedExecution: projectStore === 'local',
        issueTimeline: true,
      })
    }
  )

  it('connects when the matching project service becomes available', async () => {
    const local = createServices()
    const cloud = createServices()
    const props = {
      api: local.deliveryApi,
      project: { ...project, current_user_id: undefined },
      item,
      currentTask: { deviceId: 'local-device', taskId: 'runtime-1' },
      currentUserId: 'account-user',
      onOpenBoard: vi.fn(),
      onOpenTask: vi.fn(),
    }
    const view = render(
      <WorkItemContextPanel {...props} services={{ projectSpaceDetailServices: { cloud } }} />
    )
    expect(screen.getByTestId('cloud-todo-detail-activity-rail-empty')).toBeInTheDocument()
    expect(renderActivity).not.toHaveBeenCalled()

    view.rerender(
      <WorkItemContextPanel
        {...props}
        services={{ projectSpaceDetailServices: { local, cloud } }}
      />
    )

    expect(await screen.findByTestId('issue-activity')).toBeInTheDocument()
    expect(renderActivity.mock.calls.at(-1)?.[0].client).toBe(local.projectChatClient)
    expect(renderActivity.mock.calls.at(-1)?.[0]).toMatchObject({
      client: local.projectChatClient,
      currentUserId: 'account-user',
    })
    expect(cloud.projectChatAgentApi?.list).not.toHaveBeenCalled()
  })
})
