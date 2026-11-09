import '@/i18n'

import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CloudProject } from '@/api/deliveries'
import type {
  ModelOptions,
  ModelType,
  ProjectWithTasks,
  RuntimeGoalCreateInput,
  RuntimeSendRequest,
  RuntimeTaskAddress,
  RuntimeWorkListResponse,
} from '@/types/api'
import { AiChatModal } from './AiChatModal'

const mocks = vi.hoisted(() => ({
  chatPanelMounts: 0,
  createProjectRuntimeTask: vi.fn(async () => false),
  lastOnAddressChange: null as null | ((address: RuntimeTaskAddress | null) => void),
  runtimeWork: undefined as RuntimeWorkListResponse | undefined,
  worktreeAvailable: true,
}))

vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbenchPaneContext: () => ({
    createProjectRuntimeTask: mocks.createProjectRuntimeTask,
    state: {
      devices: [
        { device_id: 'cloud-device', name: '云端构建机', device_type: 'cloud', status: 'online' },
      ],
      runtimeWork: mocks.runtimeWork,
    },
  }),
}))

vi.mock('./ConnectedIssueProjectWork', () => ({
  ConnectedIssueProjectWork: ({
    project,
    selectedDeviceWorkspaceId,
    showProjectSelector,
    onSelectProject,
    onSelectProjectWorkspace,
    children,
  }: {
    project: ProjectWithTasks | null
    selectedDeviceWorkspaceId: number | null
    showProjectSelector?: boolean
    onSelectProject: (projectId: number | null) => void
    onSelectProjectWorkspace: (projectId: number, deviceWorkspaceId: number | null) => void
    children: (projectWork: {
      currentProject: ProjectWithTasks | null
      selectedDeviceWorkspaceId: number | null
      executionMode: 'current_workspace'
      executionModeLocked: false
      worktreeBranch: null
      onExecutionModeChange: (mode: 'current_workspace' | 'git_worktree') => void
      onWorktreeBranchChange: (branch: string | null) => void
      worktreeAvailability: { available: boolean }
    }) => React.ReactNode
  }) => (
    <div
      data-testid="mock-connected-project-work"
      data-show-project-selector={showProjectSelector === false ? 'false' : 'true'}
    >
      {showProjectSelector !== false ? (
        <>
          <button
            type="button"
            data-testid="mock-select-project"
            onClick={() => onSelectProject(92)}
          >
            select project
          </button>
          <button
            type="button"
            data-testid="mock-select-project-workspace"
            onClick={() => onSelectProjectWorkspace(92, 202)}
          >
            select workspace
          </button>
        </>
      ) : null}
      {children({
        currentProject: project,
        selectedDeviceWorkspaceId,
        executionMode: 'current_workspace',
        executionModeLocked: false,
        worktreeBranch: null,
        onExecutionModeChange: vi.fn(),
        onWorktreeBranchChange: vi.fn(),
        worktreeAvailability: { available: mocks.worktreeAvailable },
      })}
    </div>
  ),
}))

vi.mock('@/components/layout/workspace-panels/TemporaryChatPanel', () => ({
  TemporaryChatPanel: ({
    currentProject,
    createTask,
    initialInput,
    autoSubmitInitialInput,
    initialAddress,
    onAddressChange,
    runtimeContext,
    allowInitialGoal,
    sendEphemeral,
    projectWork,
    testId,
  }: {
    currentProject: ProjectWithTasks | null
    initialInput?: string
    autoSubmitInitialInput?: boolean
    createTask?: (
      message: string,
      options: {
        attachments: []
        initialGoal?: RuntimeGoalCreateInput
        executionModel: {
          modelId?: string
          modelType?: ModelType | null
          modelOptions?: ModelOptions
        }
        optimisticUserMessage: import('@/types/workbench').WorkbenchMessage & { role: 'user' }
        onError: (message: string) => void
        onRuntimeTaskOptimisticOpen: (address: RuntimeTaskAddress) => void
      }
    ) => Promise<RuntimeTaskAddress | false>
    initialAddress?: RuntimeTaskAddress | null
    onAddressChange?: (address: RuntimeTaskAddress | null) => void
    runtimeContext?: Pick<RuntimeSendRequest, 'cloudProjectId' | 'origin' | 'additionalContext'>
    allowInitialGoal?: boolean
    sendEphemeral?: boolean
    projectWork?: {
      executionMode: 'current_workspace' | 'git_worktree'
      executionModeLocked?: boolean
      worktreeBranch?: string | null
      onExecutionModeChange: (mode: 'current_workspace' | 'git_worktree') => void
      onWorktreeBranchChange?: (branch: string | null) => void
    }
    testId?: string
  }) => {
    const mountId = useRef(++mocks.chatPanelMounts).current
    mocks.lastOnAddressChange = onAddressChange ?? null
    return (
      <>
        <button
          type="button"
          data-testid="mock-chat-send"
          onClick={() =>
            void createTask?.('给出任务列表', {
              attachments: [],
              executionModel: {
                modelId: 'backend-codex',
                modelType: 'user',
                modelOptions: { reasoningEffort: 'high' },
              },
              optimisticUserMessage: {
                id: 'queued-side-chat-1',
                role: 'user',
                content: '给出任务列表',
                status: 'done',
              },
              onError: vi.fn(),
              onRuntimeTaskOptimisticOpen: vi.fn(),
            })
          }
        >
          send
        </button>
        <button
          type="button"
          data-testid="mock-chat-goal-send"
          onClick={() =>
            void createTask?.('持续完成任务', {
              attachments: [],
              initialGoal: {
                objective: '持续完成任务',
                status: 'active',
                tokenBudget: null,
              },
              executionModel: {
                modelId: 'backend-codex',
                modelType: 'user',
                modelOptions: { reasoningEffort: 'high' },
              },
              optimisticUserMessage: {
                id: 'queued-side-chat-goal-1',
                role: 'user',
                content: '持续完成任务',
                status: 'done',
              },
              onError: vi.fn(),
              onRuntimeTaskOptimisticOpen: vi.fn(),
            })
          }
        >
          send goal
        </button>
        <button
          type="button"
          data-testid="mock-select-current-workspace-mode"
          onClick={() => projectWork?.onExecutionModeChange('current_workspace')}
        >
          select current workspace
        </button>
        <button
          type="button"
          data-testid="mock-select-worktree-mode"
          onClick={() => projectWork?.onExecutionModeChange('git_worktree')}
        >
          select worktree
        </button>
        <button
          type="button"
          data-testid="mock-select-worktree-branch"
          onClick={() => projectWork?.onWorktreeBranchChange?.('feature/issue-task')}
        >
          select worktree branch
        </button>
        <div
          data-testid="mock-chat-panel"
          data-project-id={currentProject?.id ?? ''}
          data-initial-input={initialInput ?? ''}
          data-auto-submit={autoSubmitInitialInput ? 'yes' : 'no'}
          data-mount-id={mountId}
          data-has-initial-address={initialAddress ? 'yes' : 'no'}
          data-initial-device-id={initialAddress?.deviceId ?? ''}
          data-initial-task-id={initialAddress?.taskId ?? ''}
          data-send-ephemeral={sendEphemeral === false ? 'no' : 'yes'}
          data-cloud-project-id={runtimeContext?.cloudProjectId ?? ''}
          data-loop-item-id={runtimeContext?.origin?.loopItemId ?? ''}
          data-panel-testid={testId}
          data-allow-initial-goal={allowInitialGoal ? 'yes' : 'no'}
          data-execution-mode={projectWork?.executionMode ?? ''}
          data-execution-mode-locked={projectWork?.executionModeLocked ? 'yes' : 'no'}
          data-worktree-branch={projectWork?.worktreeBranch ?? ''}
        />
      </>
    )
  },
}))

const project = {
  id: 11,
  public_id: 'cloud-public-id',
  project_key: 'WEG',
  name: 'Wegent V4',
  description: 'Shared project',
  project_store: 'backend' as const,
  task_provider: 'local' as const,
  provider_config: {},
  created_by_user_id: 1,
  status: 'active',
  version: 1,
  created_at: '2026-07-22T00:00:00Z',
  updated_at: '2026-07-22T00:00:00Z',
} as CloudProject

const localProjects: ProjectWithTasks[] = [
  { id: 91, name: '运营工作区', tasks: [] },
  { id: 92, name: '研发工作区', tasks: [] },
]

const task = {
  id: 'WEG-1',
  cloud_project_id: 11,
  sequence_number: 1,
  parent_id: null,
  created_by_user_id: 1,
  assignee_user_id: null,
  title: 'Implement cloud MCP',
  description: 'Use the shared workspace',
  status: 'in_progress' as const,
  priority: 'high' as const,
  due_at: null,
  sort_order: 0,
  current_delivery_id: null,
  version: 1,
  created_at: '2026-07-22T00:00:00Z',
  updated_at: '2026-07-22T00:00:00Z',
  completed_at: null,
}

describe('AiChatModal', () => {
  beforeEach(() => {
    mocks.createProjectRuntimeTask.mockReset()
    mocks.createProjectRuntimeTask.mockResolvedValue(false)
    mocks.runtimeWork = undefined
    mocks.worktreeAvailable = true
  })

  it('handles Escape inside an embedded conversation without a global keyboard listener', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(
      <AiChatModal
        project={project}
        localProjects={localProjects}
        task={task}
        initialAddress={{ deviceId: 'device', taskId: 'run-1' }}
        embedded
        open
        onClose={onClose}
      />
    )
    await user.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()
    screen.getByTestId('ai-chat-modal-close').focus()
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('keeps the original title as an unsent draft when a work item moves to pending', () => {
    render(
      <AiChatModal
        project={project}
        localProjects={localProjects}
        task={task}
        initialTaskInput="Implement cloud MCP"
        embedded
        open
        onClose={vi.fn()}
      />
    )

    expect(screen.getByTestId('mock-chat-panel')).toHaveAttribute(
      'data-initial-input',
      'Implement cloud MCP'
    )
    expect(screen.getByTestId('mock-chat-panel')).toHaveAttribute('data-auto-submit', 'no')
  })

  it('preserves assignment identity in both the task request and runtime context', async () => {
    const origin = {
      type: 'issue_dispatch' as const,
      cloudProjectId: String(project.id),
      loopItemId: task.id,
      projectStore: 'backend' as const,
      humanAssignmentId: 'human-work',
      dispatchId: 'dispatch',
      roundId: 'round',
      assignmentId: 'assignment',
    }
    render(
      <AiChatModal
        project={project}
        localProjects={localProjects}
        task={task}
        initialTaskRequest={{
          runtime: 'codex',
          message: 'Assigned work',
          title: 'Assigned title',
          origin,
        }}
        open
        onClose={vi.fn()}
      />
    )

    await userEvent.click(screen.getByTestId('mock-chat-send'))

    expect(mocks.createProjectRuntimeTask).toHaveBeenCalledWith(
      '给出任务列表',
      expect.objectContaining({
        origin,
        taskRequest: expect.objectContaining({ title: 'Assigned title', origin }),
        additionalContext: expect.objectContaining({ issueEnvironment: expect.any(Object) }),
      })
    )
  })

  it('always creates private AI conversations with the Codex runtime', async () => {
    render(
      <AiChatModal
        project={project}
        localProjects={localProjects}
        task={task}
        initialLocalProjectId={91}
        open
        onClose={vi.fn()}
      />
    )

    await userEvent.click(screen.getByTestId('mock-chat-send'))

    expect(mocks.createProjectRuntimeTask).toHaveBeenCalledWith(
      '给出任务列表',
      expect.objectContaining({
        runtime: 'codex',
        optimisticUserMessage: expect.objectContaining({
          id: 'queued-side-chat-1',
          role: 'user',
        }),
        executionModel: {
          modelId: 'backend-codex',
          modelType: 'user',
          modelOptions: { reasoningEffort: 'high' },
        },
        workspaceExecution: null,
        cloudProjectId: '11',
        origin: {
          type: 'board_task',
          cloudProjectId: '11',
          loopItemId: 'WEG-1',
          projectStore: 'backend',
        },
        additionalContext: expect.objectContaining({
          issueEnvironment: expect.objectContaining({
            value: expect.stringContaining('"description":"Use the shared workspace"'),
          }),
        }),
      })
    )
    mocks.createProjectRuntimeTask.mockClear()
  })

  it('forwards Goal mode when creating an Issue task', async () => {
    render(
      <AiChatModal
        project={project}
        localProjects={localProjects}
        task={task}
        embedded
        open
        onClose={vi.fn()}
      />
    )

    await userEvent.click(screen.getByTestId('mock-chat-goal-send'))

    expect(mocks.createProjectRuntimeTask).toHaveBeenCalledWith(
      '持续完成任务',
      expect.objectContaining({
        initialGoal: {
          objective: '持续完成任务',
          status: 'active',
          tokenBudget: null,
        },
      })
    )
    mocks.createProjectRuntimeTask.mockClear()
  })

  it('uses the execution selection captured by the Issue creation page', async () => {
    render(
      <AiChatModal
        project={project}
        localProjects={localProjects}
        task={task}
        initialTaskRequest={{
          schemaVersion: 2,
          runtime: 'codex',
          message: '给出任务列表',
          projectId: 92,
          deviceWorkspaceId: 202,
          execution: {
            workspace: {
              source: 'git_worktree',
              branch: 'feature/issue-selection',
            },
          },
          modelId: 'selected-in-issue-composer',
          modelType: 'runtime',
          modelOptions: { reasoning: 'xhigh', collaborationMode: 'default' },
        }}
        initialLocalProjectId={92}
        open
        onClose={vi.fn()}
      />
    )

    expect(screen.getByTestId('mock-chat-panel')).toHaveAttribute('data-project-id', '92')
    await userEvent.click(screen.getByTestId('mock-chat-send'))

    expect(mocks.createProjectRuntimeTask).toHaveBeenCalledWith(
      '给出任务列表',
      expect.objectContaining({
        project: expect.objectContaining({ id: 92 }),
        deviceWorkspaceId: 202,
        executionModel: {
          modelId: 'backend-codex',
          modelType: 'user',
          modelOptions: { reasoningEffort: 'high' },
        },
        taskRequest: {
          schemaVersion: 2,
          runtime: 'codex',
          message: '给出任务列表',
          execution: {
            workspace: {
              source: 'git_worktree',
              branch: 'feature/issue-selection',
            },
          },
          modelId: 'selected-in-issue-composer',
          modelType: 'runtime',
          modelOptions: { reasoning: 'xhigh', collaborationMode: 'default' },
          cloudProjectId: '11',
          origin: {
            type: 'board_task',
            cloudProjectId: '11',
            loopItemId: 'WEG-1',
            projectStore: 'backend',
          },
          additionalContext: expect.any(Object),
        },
      })
    )
    mocks.createProjectRuntimeTask.mockClear()
  })

  it('keeps a prepared execution environment as the task target', async () => {
    render(
      <AiChatModal
        project={project}
        localProjects={localProjects}
        task={task}
        initialTaskRequest={{
          schemaVersion: 2,
          runtime: 'codex',
          message: '',
          deviceId: 'shared-runtime-device',
          workspacePath: '/srv/collaboration/project',
          execution: {
            workspace: { source: 'git_worktree' },
          },
        }}
        initialLocalProjectId={91}
        open
        onClose={vi.fn()}
      />
    )

    expect(screen.queryByTestId('mock-connected-project-work')).not.toBeInTheDocument()
    expect(screen.queryByTestId('mock-select-project-workspace')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('mock-chat-send'))

    expect(mocks.createProjectRuntimeTask).toHaveBeenCalledWith(
      '给出任务列表',
      expect.objectContaining({
        project: null,
        taskRequest: expect.objectContaining({
          deviceId: 'shared-runtime-device',
          workspacePath: '/srv/collaboration/project',
          execution: {
            workspace: { source: 'git_worktree' },
          },
        }),
      })
    )
    mocks.createProjectRuntimeTask.mockClear()
  })

  it('reuses the predecessor workspace without continuing its conversation', async () => {
    const inheritFromTask: RuntimeTaskAddress = {
      deviceId: 'local-device',
      taskId: 'development-task',
      workspacePath: '/workspace/worktrees/login',
      threadId: 'development-thread',
    }

    render(
      <AiChatModal
        project={project}
        localProjects={localProjects}
        task={task}
        inheritFromTask={inheritFromTask}
        open
        onClose={vi.fn()}
      />
    )

    await userEvent.click(screen.getByTestId('mock-chat-send'))

    expect(mocks.createProjectRuntimeTask).toHaveBeenCalledWith(
      '给出任务列表',
      expect.objectContaining({
        workspaceSource: inheritFromTask,
        taskRequest: null,
      })
    )
    expect(mocks.createProjectRuntimeTask.mock.calls[0]?.[1]).not.toHaveProperty(
      'workspaceExecution'
    )
    mocks.createProjectRuntimeTask.mockClear()
  })

  it('restores a saved workspace and reports it after successful task creation', async () => {
    const address = { deviceId: 'local-device', taskId: 'runtime-created' }
    const onTaskCreated = vi.fn()
    mocks.createProjectRuntimeTask.mockResolvedValue(address)

    render(
      <AiChatModal
        project={project}
        localProjects={localProjects}
        task={task}
        initialLocalProjectId={92}
        initialDeviceWorkspaceId={202}
        onTaskCreated={onTaskCreated}
        embedded
        open
        onClose={vi.fn()}
      />
    )

    await userEvent.click(screen.getByTestId('mock-chat-send'))

    expect(mocks.createProjectRuntimeTask).toHaveBeenCalledWith(
      '给出任务列表',
      expect.objectContaining({
        project: localProjects[1],
        deviceWorkspaceId: 202,
      })
    )
    expect(onTaskCreated).toHaveBeenCalledWith(address, localProjects[1], 202)
  })

  it('starts a new temporary conversation and can switch back', async () => {
    const storageKey = 'wework-ai-chat:11:WEG-1'
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({ deviceId: 'local-device', taskId: 'old-task', workspacePath: '/tmp' })
    )

    render(
      <AiChatModal
        project={project}
        localProjects={localProjects}
        task={task}
        open
        onClose={vi.fn()}
      />
    )

    const panel = () => screen.getByTestId('mock-chat-panel')
    expect(panel()).toHaveAttribute('data-has-initial-address', 'yes')
    const firstMount = Number(panel().getAttribute('data-mount-id'))

    await userEvent.click(screen.getByTestId('ai-chat-new-conversation'))
    expect(panel()).toHaveAttribute('data-has-initial-address', 'no')
    expect(Number(panel().getAttribute('data-mount-id'))).toBeGreaterThan(firstMount)

    await userEvent.click(screen.getByTestId('ai-chat-new-conversation'))
    expect(panel()).toHaveAttribute('data-has-initial-address', 'yes')

    window.localStorage.removeItem(storageKey)
  })

  it('does not jump back to the saved conversation after creating a new one', async () => {
    const storageKey = 'wework-ai-chat:11:WEG-1'
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({ deviceId: 'local-device', taskId: 'old-task', workspacePath: '/tmp' })
    )

    render(
      <AiChatModal
        project={project}
        localProjects={localProjects}
        task={task}
        open
        onClose={vi.fn()}
      />
    )

    const panel = () => screen.getByTestId('mock-chat-panel')
    await userEvent.click(screen.getByTestId('ai-chat-new-conversation'))
    const freshMount = Number(panel().getAttribute('data-mount-id'))

    act(() => {
      mocks.lastOnAddressChange?.({
        deviceId: 'local-device',
        taskId: 'new-task',
        workspacePath: '/tmp',
      })
    })

    // Creating the new runtime task must keep the fresh panel; remounting would
    // jump back to the old conversation.
    expect(Number(panel().getAttribute('data-mount-id'))).toBe(freshMount)
    window.localStorage.removeItem(storageKey)
  })

  it('opens a focused bound task as a split detail and persistent conversation', async () => {
    const onOpenRuntimeTask = vi.fn()
    const onClose = vi.fn()
    const address = { deviceId: 'local-device', taskId: 'runtime-1' }

    render(
      <AiChatModal
        project={project}
        localProjects={localProjects}
        task={task}
        taskTitle="实现云端交付"
        initialAddress={address}
        open
        onClose={onClose}
        onOpenRuntimeTask={onOpenRuntimeTask}
      />
    )

    expect(screen.getByTestId('work-item-task-context')).toHaveTextContent('WEG-1')
    expect(screen.getByTestId('work-item-task-context')).toHaveTextContent('Implement cloud MCP')
    expect(screen.getByTestId('work-item-task-context')).toHaveTextContent('实现云端交付')
    expect(screen.getByTestId('mock-chat-panel')).toHaveAttribute(
      'data-panel-testid',
      'work-item-task-chat-panel'
    )
    expect(screen.getByTestId('mock-chat-panel')).toHaveAttribute('data-send-ephemeral', 'no')
    await userEvent.click(screen.getByTestId('ai-chat-open-runtime-task'))
    expect(onOpenRuntimeTask).toHaveBeenCalledWith({
      ...address,
      issueExecution: { projectId: String(project.id), issueId: task.id },
      projectSession: { projectId: String(project.id), issueId: task.id },
    })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('marks a local bound task as an Issue execution without cloud session routing', async () => {
    const onOpenRuntimeTask = vi.fn()
    const onClose = vi.fn()
    const address = { deviceId: 'local-device', taskId: 'runtime-1' }

    render(
      <AiChatModal
        project={{ ...project, project_store: 'local' }}
        localProjects={localProjects}
        task={task}
        taskTitle="实现本地交付"
        initialAddress={address}
        open
        onClose={onClose}
        onOpenRuntimeTask={onOpenRuntimeTask}
      />
    )

    await userEvent.click(screen.getByTestId('ai-chat-open-runtime-task'))
    expect(onOpenRuntimeTask).toHaveBeenCalledWith({
      ...address,
      issueExecution: { projectId: String(project.id), issueId: task.id },
    })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('uses a bound task address received after the composer was mounted', () => {
    const { rerender } = render(
      <AiChatModal
        project={project}
        localProjects={localProjects}
        task={task}
        embedded
        open
        onClose={vi.fn()}
      />
    )

    expect(screen.getByTestId('mock-chat-panel')).toHaveAttribute('data-has-initial-address', 'no')

    rerender(
      <AiChatModal
        project={project}
        localProjects={localProjects}
        task={task}
        initialAddress={{ deviceId: 'resolved-device', taskId: 'resolved-task' }}
        embedded
        open
        onClose={vi.fn()}
      />
    )

    expect(screen.getByTestId('mock-chat-panel')).toHaveAttribute(
      'data-initial-device-id',
      'resolved-device'
    )
    expect(screen.getByTestId('mock-chat-panel')).toHaveAttribute(
      'data-initial-task-id',
      'resolved-task'
    )
  })

  it('remounts a bound task conversation when its device alias resolves', () => {
    const { rerender } = render(
      <AiChatModal
        project={project}
        localProjects={localProjects}
        task={task}
        initialAddress={{ deviceId: 'app-record-65', taskId: 'resolved-task' }}
        embedded
        open
        onClose={vi.fn()}
      />
    )
    const firstMount = Number(screen.getByTestId('mock-chat-panel').getAttribute('data-mount-id'))

    rerender(
      <AiChatModal
        project={project}
        localProjects={localProjects}
        task={task}
        initialAddress={{ deviceId: 'electron-runtime-device', taskId: 'resolved-task' }}
        embedded
        open
        onClose={vi.fn()}
      />
    )

    expect(screen.getByTestId('mock-chat-panel')).toHaveAttribute(
      'data-initial-device-id',
      'electron-runtime-device'
    )
    expect(
      Number(screen.getByTestId('mock-chat-panel').getAttribute('data-mount-id'))
    ).toBeGreaterThan(firstMount)
  })
})
