import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { CloudProject } from '@/api/deliveries'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { ProjectQueueView } from './ProjectQueueView'

const project = {
  id: '11',
  name: 'Wework',
  current_user_id: 1,
} as unknown as CloudProject

function services(): WorkbenchServices {
  return {
    deliveryApi: {
      listLoopItems: vi.fn(async () => ({
        items: [
          {
            id: 'T-1',
            cloud_project_id: '11',
            title: 'Queue me',
            status: 'in_progress',
            execution_state: 'assigned',
            assignment_history: [
              {
                by_user_id: 2,
                to_type: 'user',
                to_id: '1',
                to_name: 'local',
                action: 'assign',
                at: '2026-08-05T00:00:00Z',
              },
            ],
          },
          {
            id: 'T-2',
            cloud_project_id: '11',
            title: 'Done',
            status: 'completed',
            execution_state: 'completed',
          },
        ],
      })),
    },
    projectChatAgentApi: {
      list: vi.fn(async () => [
        {
          id: 'bot-1',
          projectId: '11',
          name: 'Local Bot',
          runtime: 'codex',
          model: null,
          systemPrompt: '',
          status: 'active',
          visibility: 'public',
          executionEnvironment: 'local',
          executionMode: 'auto',
          createdByUserId: 1,
          createdByUserName: 'local',
          version: 1,
          createdAt: '',
          updatedAt: '',
        },
      ]),
    },
  } as unknown as WorkbenchServices
}

describe('ProjectQueueView', () => {
  it('keeps a generic AI execution and Runtime selection in one queue card', async () => {
    const mock = services()
    const list = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: 303,
          loop_item_id: 'T-runtime',
          cloud_project_id: '11',
          task_title: 'Choose my Runtime',
          task_status: 'inbox',
          task_priority: 'high',
          executor_type: 'generic_robot',
          agent_id: null,
          executor_owner_user_id: 1,
          assigner_user_id: 1,
          status: 'waiting_runtime',
          display_state: 'waiting_runtime',
          runtime_profile_id: null,
          runtime_source: 'issue_creator',
          can_select_runtime: true,
          waiting_runtime_reason: 'Runtime is required',
          execution_note: 'Runtime is required',
          queued_at: null,
          started_at: null,
          completed_at: null,
          version: 2,
          created_at: '2026-08-20T00:00:00Z',
          updated_at: '2026-08-20T00:00:00Z',
        },
      ])
      .mockResolvedValue([])
    const selectExecution = vi.fn(async () => ({}))
    render(
      <ProjectQueueView
        api={mock.deliveryApi!}
        project={project}
        projectChatAgentApi={mock.projectChatAgentApi}
        executionApi={{ list }}
        runtimeProfileApi={{ selectExecution } as never}
        runtimeProfiles={[
          {
            id: 'runtime-incomplete',
            name: 'Incomplete Runtime',
            executionEnvironment: 'local',
            executionDeviceId: 'device-1',
            model: '',
            modelType: null,
            modelOptions: {},
            workspacePolicy: 'project',
            status: 'active',
            version: 1,
            createdAt: '',
            updatedAt: '',
          },
          {
            id: 'runtime-1',
            name: 'My Runtime',
            executionEnvironment: 'local',
            executionDeviceId: 'device-1',
            model: 'model-1',
            modelType: 'runtime',
            modelOptions: {},
            workspacePolicy: 'project',
            status: 'active',
            version: 1,
            createdAt: '',
            updatedAt: '',
          },
        ]}
        currentUserId={1}
      />
    )

    expect(await screen.findByTestId('project-queue-column-generic-runtime')).toHaveTextContent(
      'Choose my Runtime'
    )
    await userEvent.click(screen.getByTestId('project-queue-runtime-303'))
    expect(
      screen.queryByTestId('project-queue-runtime-303-option-runtime-incomplete')
    ).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('project-queue-runtime-303-option-runtime-1'))
    await waitFor(() => expect(selectExecution).toHaveBeenCalledWith('11', 303, 'runtime-1', 2))
  })

  it('loads all robot executions in one batch and groups them by robot', async () => {
    const mock = services()
    const list = vi.fn(async () => [
      {
        id: 101,
        loop_item_id: 'T-3',
        cloud_project_id: '11',
        task_title: 'Bot queued task',
        task_status: 'pending',
        task_priority: 'medium',
        agent_id: 'bot-1',
        assigner_user_id: 1,
        status: 'queued',
        display_state: 'queued',
        queued_at: null,
        started_at: null,
        completed_at: null,
        execution_note: null,
        version: 1,
        created_at: '2026-08-07T00:00:00Z',
        updated_at: '2026-08-07T00:00:00Z',
      },
    ])
    render(
      <ProjectQueueView
        api={mock.deliveryApi!}
        project={{ id: '11', task_provider: 'gitlab', name: 'GitLab' } as never}
        projectChatAgentApi={mock.projectChatAgentApi}
        executionApi={{ list }}
        currentUserId={1}
        onOpenTask={vi.fn()}
      />
    )

    expect(await screen.findByText('Bot queued task')).toBeInTheDocument()
    expect(list).toHaveBeenCalledWith('11', {})
  })

  it('stops a running execution from the automation queue', async () => {
    const mock = services()
    const list = vi.fn(async () => [
      {
        id: 202,
        loop_item_id: 'T-9',
        cloud_project_id: '11',
        task_title: 'Running bot task',
        task_status: 'in_progress',
        task_priority: 'medium',
        agent_id: 'bot-1',
        assigner_user_id: 1,
        status: 'running',
        display_state: 'running',
        queued_at: null,
        started_at: null,
        completed_at: null,
        execution_note: null,
        version: 1,
        created_at: '2026-08-07T00:00:00Z',
        updated_at: '2026-08-07T00:00:00Z',
      },
    ])
    const stop = vi.fn(async () => ({ id: 202, status: 'cancelled' }))
    render(
      <ProjectQueueView
        api={mock.deliveryApi!}
        project={{ id: '11', task_provider: 'gitlab', name: 'GitLab' } as never}
        projectChatAgentApi={mock.projectChatAgentApi}
        executionApi={{ list, stop }}
        currentUserId={1}
        onOpenTask={vi.fn()}
      />
    )

    const stopButton = await screen.findByTestId('project-queue-stop-T-9')
    await userEvent.click(stopButton)
    await waitFor(() => expect(stop).toHaveBeenCalledWith('11', 202))
  })

  it('renders derived queues for the current user and visible robots', async () => {
    const mock = services()
    const listLoopItems = mock.deliveryApi!.listLoopItems as ReturnType<typeof vi.fn>
    listLoopItems.mockImplementation(async (projectId: string | number, filters?: object) => {
      const assigneeId = (filters as { assigneeId?: string | number } | undefined)?.assigneeId
      if (assigneeId === 'bot-1') {
        return {
          items: [
            {
              id: 'T-3',
              cloud_project_id: '11',
              title: 'Bot queued task',
              status: 'pending',
              execution_state: 'queued',
              assignment_history: [
                {
                  by_user_id: 2,
                  to_type: 'agent',
                  to_id: 'bot-1',
                  to_name: 'Local Bot',
                  action: 'assign',
                  at: '2026-08-05T00:00:00Z',
                },
              ],
            },
          ],
        }
      }
      return {
        items: [
          {
            id: 'T-1',
            cloud_project_id: '11',
            title: 'Queue me',
            status: 'in_progress',
            execution_state: 'assigned',
            assignment_history: [
              {
                by_user_id: 2,
                to_type: 'user',
                to_id: '1',
                to_name: 'local',
                action: 'assign',
                at: '2026-08-05T00:00:00Z',
              },
            ],
          },
          {
            id: 'T-2',
            cloud_project_id: '11',
            title: 'Done',
            status: 'completed',
            execution_state: 'completed',
          },
        ],
      }
    })

    render(
      <ProjectQueueView
        api={mock.deliveryApi!}
        project={project}
        projectChatAgentApi={mock.projectChatAgentApi}
        currentUserId={1}
      />
    )

    expect(await screen.findByTestId('project-queue-view')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('project-queue-column-me')).toBeInTheDocument())
    expect(screen.getByTestId('project-queue-column-bot-1')).toBeInTheDocument()
    expect(screen.getByText('Queue me')).toBeInTheDocument()
    expect(screen.getByText('Bot queued task')).toBeInTheDocument()
    expect(screen.queryByText('Done')).not.toBeInTheDocument()
  })

  it('filters by execution state and searches task titles', async () => {
    const mock = services()
    const listLoopItems = mock.deliveryApi!.listLoopItems as ReturnType<typeof vi.fn>
    listLoopItems.mockImplementation(async (projectId: string | number, filters?: object) => {
      const assigneeId = (filters as { assigneeId?: string | number } | undefined)?.assigneeId
      if (assigneeId === 'bot-1') {
        return {
          items: [
            {
              id: 'T-3',
              cloud_project_id: '11',
              title: 'Bot queued task',
              status: 'pending',
              execution_state: 'queued',
              assignment_history: [
                {
                  by_user_id: 2,
                  to_type: 'agent',
                  to_id: 'bot-1',
                  to_name: 'Local Bot',
                  action: 'assign',
                  at: '2026-08-05T00:00:00Z',
                },
              ],
            },
          ],
        }
      }
      return {
        items: [
          {
            id: 'T-1',
            cloud_project_id: '11',
            title: 'Zap the runner',
            status: 'in_progress',
            execution_state: 'running',
            assignment_history: [
              {
                by_user_id: 2,
                to_type: 'user',
                to_id: '1',
                to_name: 'local',
                action: 'assign',
                at: '2026-08-05T00:00:00Z',
              },
            ],
          },
          {
            id: 'T-2',
            cloud_project_id: '11',
            title: 'Paperwork review',
            status: 'pending',
            execution_state: 'waiting_approval',
            can_approve: true,
            assignment_history: [
              {
                by_user_id: 2,
                to_type: 'user',
                to_id: '1',
                to_name: 'local',
                action: 'assign',
                at: '2026-08-05T00:00:00Z',
              },
            ],
          },
        ],
      }
    })

    render(
      <ProjectQueueView
        api={mock.deliveryApi!}
        project={project}
        projectChatAgentApi={mock.projectChatAgentApi}
        currentUserId={1}
      />
    )

    await waitFor(() => expect(screen.getByTestId('project-queue-column-me')).toBeInTheDocument())
    expect(screen.getByText('Zap the runner')).toBeInTheDocument()
    expect(screen.getByText('Paperwork review')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('project-queue-filter-running'))
    expect(screen.getByText('Zap the runner')).toBeInTheDocument()
    expect(screen.queryByText('Paperwork review')).not.toBeInTheDocument()
    expect(screen.queryByText('Bot queued task')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('project-queue-filter-all'))
    await userEvent.click(screen.getByTestId('project-queue-filter-my-approval'))
    expect(screen.getByText('Paperwork review')).toBeInTheDocument()
    expect(screen.queryByText('Zap the runner')).not.toBeInTheDocument()
    expect(screen.queryByText('Bot queued task')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('project-queue-filter-all'))
    await userEvent.type(screen.getByTestId('project-queue-search'), 'queued')
    expect(screen.getByText('Bot queued task')).toBeInTheDocument()
    expect(screen.queryByText('Zap the runner')).not.toBeInTheDocument()
  })

  it('refreshes executions in the background without flashing the loading state', async () => {
    vi.useFakeTimers()
    try {
      const mock = services()
      const list = vi.fn(async () => [])
      render(
        <ProjectQueueView
          api={mock.deliveryApi!}
          project={{ id: '11', task_provider: 'gitlab', name: 'GitLab' } as never}
          projectChatAgentApi={mock.projectChatAgentApi}
          executionApi={{ list }}
          currentUserId={1}
          onOpenTask={vi.fn()}
        />
      )

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(list).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId('project-queue-column-me')).toBeInTheDocument()

      // The interval refresh replaces data in place: the content stays mounted
      // and the loading spinner is never shown again.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000)
      })
      expect(list).toHaveBeenCalledTimes(2)
      expect(screen.getByTestId('project-queue-column-me')).toBeInTheDocument()
      expect(screen.queryByText('正在加载动态…')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('renders a spinning icon for running executions', async () => {
    const mock = services()
    const listLoopItems = mock.deliveryApi!.listLoopItems as ReturnType<typeof vi.fn>
    listLoopItems.mockImplementation(async (_projectId: string | number, filters?: object) => ({
      items:
        (filters as { assigneeId?: string | number } | undefined)?.assigneeId === 'bot-1'
          ? []
          : [
              {
                id: 'T-1',
                cloud_project_id: '11',
                title: 'Running task',
                status: 'in_progress',
                execution_state: 'running',
                assignment_history: [],
              },
            ],
    }))

    const { container } = render(
      <ProjectQueueView
        api={mock.deliveryApi!}
        project={project}
        projectChatAgentApi={mock.projectChatAgentApi}
        currentUserId={1}
      />
    )

    await waitFor(() => expect(screen.getByText('Running task')).toBeInTheDocument())
    const spinner = container.querySelector('.animate-spin')
    expect(spinner).toBeInstanceOf(HTMLSpanElement)
    expect(spinner).toHaveClass('will-change-transform')
    expect(spinner?.querySelector('svg')).not.toHaveClass('animate-spin')
  })
})
