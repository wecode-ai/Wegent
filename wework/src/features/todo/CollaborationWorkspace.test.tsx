// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type {
  CollaborationIssue,
  CollaborationPlatformLocation,
  CollaborationProject,
} from '@wegent/collaboration'
import type { CloudProject } from '@/api/deliveries'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { CollaborationWorkspace } from './CollaborationWorkspace'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
    i18n: { language: 'zh-CN' },
  }),
}))

vi.mock('./AiChatModal', () => ({
  AiChatModal: ({
    project,
    task,
  }: {
    project: { id: string; project_store: string; location?: string }
    task?: { id: string }
  }) => (
    <div
      data-testid="wework-issue-task-launcher"
      data-project-id={project.id}
      data-project-store={project.project_store}
      data-project-location={project.location ?? ''}
      data-issue-id={task?.id ?? ''}
    />
  ),
}))

vi.mock('@wegent/collaboration', async importOriginal => {
  const actual = await importOriginal<typeof import('@wegent/collaboration')>()
  return {
    ...actual,
    CollaborationPlatformApp: ({
      host,
      onCreateTask: startIssueTask,
    }: {
      host: {
        location: CollaborationPlatformLocation
        navigate(location: CollaborationPlatformLocation): void
      }
      onCreateTask?(
        project: CollaborationProject,
        issue: CollaborationIssue,
        workflowStep?: string
      ): void
    }) => (
      <div
        data-testid="shared-collaboration-platform"
        data-workspace-id={host.location.workspaceId ?? ''}
        data-project-id={host.location.projectId ?? ''}
        data-issue-id={host.location.issueId ?? ''}
      >
        <button
          type="button"
          data-testid="shared-open-project"
          onClick={() =>
            host.navigate({
              platformView: 'spaces',
              workspaceId: 'workspace-1',
              workspaceView: 'projects',
              projectId: 'project-1',
              projectView: 'board',
              issueId: null,
            })
          }
        >
          Open project
        </button>
        <button
          type="button"
          data-testid="shared-open-second-project"
          onClick={() =>
            host.navigate({
              platformView: 'spaces',
              workspaceId: 'workspace-1',
              workspaceView: 'projects',
              projectId: 'project-2',
              projectView: 'board',
              issueId: null,
            })
          }
        >
          Open second project
        </button>
        <button
          type="button"
          data-testid="shared-open-issue"
          onClick={() =>
            host.navigate({
              ...host.location,
              workspaceId: 'workspace-1',
              projectId: 'project-1',
              issueId: 'issue-1',
            })
          }
        >
          Open issue
        </button>
        <button
          type="button"
          data-testid="shared-start-issue-work"
          onClick={() =>
            startIssueTask?.(
              cloudProject,
              {
                id: 'issue-1',
                cloud_project_id: 'project-1',
                sequence_number: 1,
                parent_id: null,
                created_by_user_id: 1,
                assignee_user_id: null,
                title: 'Issue',
                description: '',
                status: 'inbox',
                priority: 'medium',
                tags: [],
                due_at: null,
                sort_order: 0,
                current_delivery_id: null,
                version: 1,
                created_at: '2026-09-12T00:00:00Z',
                updated_at: '2026-09-12T00:00:00Z',
                completed_at: null,
                workflow: {
                  advancement_policy: 'manual',
                  stage_mode: 'dag',
                  nodes: [
                    {
                      id: 'implementation',
                      name: 'Implementation',
                      status: 'active',
                      depends_on: [],
                      required: true,
                      workspace_policy: 'composer',
                    },
                  ],
                },
              } as CollaborationIssue,
              'implementation'
            )
          }
        >
          Start work
        </button>
      </div>
    ),
  }
})

vi.mock('./CloudTodoWorkspace', () => ({
  CloudTodoWorkspace: ({
    activeProjectRef,
    focusedItemId,
    embedded,
  }: {
    activeProjectRef?: { projectStore: string; projectId: string } | null
    focusedItemId?: string | null
    embedded?: boolean
  }) => (
    <div
      data-testid="legacy-collaboration-project"
      data-project-store={activeProjectRef?.projectStore ?? ''}
      data-project-id={activeProjectRef?.projectId ?? ''}
      data-focused-item-id={focusedItemId ?? ''}
      data-embedded={String(Boolean(embedded))}
    />
  ),
}))

const cloudProject = {
  id: 'project-1',
  workspace_id: 'workspace-1',
  public_id: 'public-project-1',
  project_key: 'PROJ',
  name: 'Cloud project',
  description: '',
  project_store: 'backend',
  task_provider: 'local',
  provider_config: {},
  created_by_user_id: 1,
  status: 'active',
  tags: [],
  version: 1,
  created_at: '2026-09-11T00:00:00Z',
  updated_at: '2026-09-11T00:00:00Z',
} as CloudProject & CollaborationProject & { workspace_id: string }

const localProject = {
  ...cloudProject,
  id: 'local-project-1',
  name: 'Local project',
  project_store: 'local',
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function createProps(options?: {
  localProjects?: CloudProject[]
  activeProjectRef?: { projectStore: 'local' | 'backend'; projectId: string } | null
  focusedItemId?: string | null
  projectLoadError?: Error
  runtimeUnavailable?: boolean
  workflowContextError?: Error
}) {
  const getProject = options?.projectLoadError
    ? vi.fn().mockRejectedValue(options.projectLoadError)
    : vi.fn().mockResolvedValue(cloudProject)
  const services = {
    sharedWorkspaceApi: {
      projects: {
        get: getProject,
      },
      workflowPlans: {
        getStageContext: options?.workflowContextError
          ? vi.fn().mockRejectedValue(options.workflowContextError)
          : vi.fn().mockResolvedValue({
              compiledTaskInstruction: 'Implement the Issue',
              source: 'workflow',
            }),
      },
      taskBindings: {
        list: vi.fn(),
      },
      issues: {
        get: vi.fn(),
        update: vi.fn(),
      },
    },
    workspaceRuntimePort: options?.runtimeUnavailable
      ? undefined
      : {
          bindTask: vi.fn(),
          unbindTask: vi.fn(),
        },
    projectSpaceApis: options?.localProjects
      ? {
          defaultLocation: 'cloud',
          local: {
            listCloudProjects: vi.fn().mockResolvedValue({ items: options.localProjects }),
          },
        }
      : undefined,
  } as unknown as WorkbenchServices

  return {
    props: {
      user: { id: 1 },
      localProjects: [],
      services,
      activeProjectRef: options?.activeProjectRef,
      focusedItemId: options?.focusedItemId,
      onActiveProjectChange: vi.fn(),
    } as unknown as React.ComponentProps<typeof CollaborationWorkspace>,
    getProject,
  }
}

describe('CollaborationWorkspace', () => {
  it('keeps cloud Issue navigation in the shared platform and wires local Task creation to the host', async () => {
    const user = userEvent.setup()
    const { props, getProject } = createProps()
    render(<CollaborationWorkspace {...props} />)

    expect(screen.getByTestId('shared-collaboration-platform')).toHaveAttribute(
      'data-workspace-id',
      ''
    )

    await user.click(screen.getByTestId('shared-open-project'))
    await waitFor(() => expect(getProject).toHaveBeenCalledWith('project-1'))
    expect(screen.getByTestId('shared-collaboration-platform')).toHaveAttribute(
      'data-project-id',
      'project-1'
    )

    await user.click(screen.getByTestId('shared-open-issue'))
    expect(screen.getByTestId('shared-collaboration-platform')).toHaveAttribute(
      'data-issue-id',
      'issue-1'
    )
    expect(screen.queryByTestId('legacy-collaboration-project')).not.toBeInTheDocument()
    expect(screen.queryByTestId('wework-issue-task-launcher')).not.toBeInTheDocument()

    await user.click(screen.getByTestId('shared-start-issue-work'))
    expect(await screen.findByTestId('wework-issue-task-launcher')).toHaveAttribute(
      'data-issue-id',
      'issue-1'
    )
    expect(screen.getByTestId('wework-issue-task-launcher')).toHaveAttribute(
      'data-project-store',
      'backend'
    )
    expect(screen.getByTestId('wework-issue-task-launcher')).toHaveAttribute(
      'data-project-location',
      'cloud'
    )
    expect(screen.getByTestId('shared-collaboration-platform')).toHaveAttribute(
      'data-issue-id',
      'issue-1'
    )
    expect(screen.queryByTestId('legacy-collaboration-project')).not.toBeInTheDocument()
  })

  it('applies only the latest cloud project navigation response', async () => {
    const user = userEvent.setup()
    const firstRequest = deferred<typeof cloudProject>()
    const secondProject = { ...cloudProject, id: 'project-2', name: 'Second project' }
    const secondRequest = deferred<typeof secondProject>()
    const { props, getProject } = createProps()
    getProject.mockImplementation((projectId: string) =>
      projectId === cloudProject.id ? firstRequest.promise : secondRequest.promise
    )
    render(<CollaborationWorkspace {...props} />)

    await user.click(screen.getByTestId('shared-open-project'))
    await user.click(screen.getByTestId('shared-open-second-project'))
    secondRequest.resolve(secondProject)
    await waitFor(() =>
      expect(props.onActiveProjectChange).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'project-2' })
      )
    )
    firstRequest.resolve(cloudProject)
    await firstRequest.promise

    expect(props.onActiveProjectChange).toHaveBeenCalledTimes(1)
  })

  it('handles a rejected cloud project navigation without changing the active project', async () => {
    const user = userEvent.setup()
    const error = new Error('Project unavailable')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { props, getProject } = createProps({ projectLoadError: error })
    render(<CollaborationWorkspace {...props} />)

    await user.click(screen.getByTestId('shared-open-project'))
    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(
        '[Wework] Failed to open the collaboration project',
        error
      )
    )

    expect(getProject).toHaveBeenCalledWith('project-1')
    expect(props.onActiveProjectChange).not.toHaveBeenCalled()
  })

  it('shows a visible Wework error when the local Task runtime is unavailable', async () => {
    const user = userEvent.setup()
    const { props } = createProps({ runtimeUnavailable: true })
    render(<CollaborationWorkspace {...props} />)

    await user.click(screen.getByTestId('shared-start-issue-work'))

    expect(screen.getByTestId('wework-collaboration-issue-task-error')).toHaveTextContent(
      '运行服务当前不可用'
    )
    expect(screen.queryByTestId('wework-issue-task-launcher')).not.toBeInTheDocument()

    await user.click(screen.getByTestId('wework-collaboration-issue-task-error-dismiss'))
    expect(screen.queryByTestId('wework-collaboration-issue-task-error')).not.toBeInTheDocument()
  })

  it('shows a visible Wework error when the workflow context cannot be loaded', async () => {
    const user = userEvent.setup()
    const { props } = createProps({
      workflowContextError: new Error('Workflow context unavailable'),
    })
    render(<CollaborationWorkspace {...props} />)

    await user.click(screen.getByTestId('shared-start-issue-work'))

    expect(await screen.findByTestId('wework-collaboration-issue-task-error')).toHaveTextContent(
      'Workflow context unavailable'
    )
    expect(screen.queryByTestId('wework-issue-task-launcher')).not.toBeInTheDocument()
  })

  it('opens a cloud project deep link in the existing project workbench', () => {
    const { props, getProject } = createProps({
      activeProjectRef: { projectStore: 'backend', projectId: 'project-1' },
    })
    render(<CollaborationWorkspace {...props} />)

    expect(screen.getByTestId('legacy-collaboration-project')).toHaveAttribute(
      'data-project-store',
      'backend'
    )
    expect(screen.getByTestId('legacy-collaboration-project')).toHaveAttribute(
      'data-project-id',
      'project-1'
    )
    expect(screen.getByTestId('legacy-collaboration-project')).toHaveAttribute(
      'data-embedded',
      'false'
    )
    expect(getProject).not.toHaveBeenCalled()
  })

  it('delegates unresolved cloud project routes to the existing project workbench', () => {
    const { props } = createProps({
      activeProjectRef: { projectStore: 'backend', projectId: 'missing-project' },
      projectLoadError: new Error('Not found'),
    })
    render(<CollaborationWorkspace {...props} />)

    expect(screen.getByTestId('legacy-collaboration-project')).toHaveAttribute(
      'data-project-id',
      'missing-project'
    )
  })

  it('keeps local personal project spaces behind a Wework-only host entry', async () => {
    const user = userEvent.setup()
    const { props } = createProps({ localProjects: [localProject] })
    render(<CollaborationWorkspace {...props} />)

    const select = await screen.findByTestId('wework-local-project-space-select')
    await user.selectOptions(select, 'local-project-1')

    expect(screen.getByTestId('legacy-collaboration-project')).toHaveAttribute(
      'data-project-store',
      'local'
    )
    expect(screen.getByTestId('legacy-collaboration-project')).toHaveAttribute(
      'data-project-id',
      'local-project-1'
    )
  })
})
