import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { TaskExecutionBinding, WorkflowRun, WorkflowRunDetail } from '@/api/projectWorkflows'
import { TaskWorkflowPanel } from './TaskWorkflowPanel'

const binding: TaskExecutionBinding = {
  id: 1,
  itemId: 'item-1',
  targetType: 'project_agent',
  targetId: 'agent-1',
  targetSnapshot: { name: '开发机器人' },
  repositoryBindingId: 'repository-1',
  executionTarget: { type: 'registered_device', id: 'device-1' },
  workspaceMode: 'git_worktree',
  createdByUserId: 7,
  version: 1,
  createdAt: '2026-08-12T00:00:00Z',
  updatedAt: '2026-08-12T00:00:00Z',
}

const run: WorkflowRun = {
  id: 'run-1',
  itemId: 'item-1',
  workflowDefinitionId: 'workflow-1',
  status: 'waiting_approval',
  currentGroupKey: 'approval',
  repositoryBindingId: 'repository-1',
  executionTarget: { type: 'registered_device', id: 'device-1' },
  executionTargetSnapshot: {},
  failureCode: null,
  failureMessage: null,
  version: 1,
  createdAt: '2026-08-12T00:00:00Z',
  updatedAt: '2026-08-12T00:00:00Z',
}

const detail: WorkflowRunDetail = {
  ...run,
  stages: [
    {
      id: 'stage-1',
      workflowRunId: 'run-1',
      groupKey: 'approval',
      nodeKey: 'human-approval',
      nodeType: 'human_gate',
      targetType: null,
      targetId: null,
      targetSnapshot: {},
      executionTarget: { type: 'registered_device', id: 'device-1' },
      status: 'waiting_approval',
      attempt: 1,
      loopItemExecutionId: null,
      runtimeInstanceId: null,
      runtimeTaskId: null,
      workspaceId: null,
      inputSnapshot: {},
      output: {},
      failureCode: null,
      failureMessage: null,
      version: 2,
      createdAt: '2026-08-12T00:00:00Z',
      updatedAt: '2026-08-12T00:00:00Z',
    },
  ],
  artifacts: [],
}

function renderPanel(overrides: Record<string, unknown> = {}) {
  const api = {
    listSquads: vi.fn(async () => []),
    listRepositories: vi.fn(async () => [
      {
        id: 'repository-1',
        projectId: '12',
        provider: 'github',
        repositoryIdentity: 'wegent/wegent',
        repositoryUrl: 'https://github.com/wegent/wegent.git',
        defaultBranch: 'main',
        localProjectId: null,
        defaultExecutionTarget: null,
        hasCredential: true,
        workspacePolicy: {},
        gitPolicy: {},
        providerSettings: {},
        status: 'active',
        createdByUserId: 7,
        version: 1,
        createdAt: '2026-08-12T00:00:00Z',
        updatedAt: '2026-08-12T00:00:00Z',
      },
    ]),
    listWorkflows: vi.fn(async () => []),
    getTaskBinding: vi.fn(async () => null),
    listRuns: vi.fn(async () => []),
    getRun: vi.fn(async () => detail),
    upsertTaskBinding: vi.fn(async () => binding),
    startRun: vi.fn(async () => run),
    approveStage: vi.fn(async () => ({
      ...detail,
      status: 'completed',
      stages: [{ ...detail.stages[0], status: 'passed', version: 3 }],
    })),
    rejectStage: vi.fn(),
    retryStage: vi.fn(),
    cancelRun: vi.fn(),
    ...overrides,
  }
  render(
    <TaskWorkflowPanel
      projectId="12"
      itemId="item-1"
      currentUserId={7}
      api={api as never}
      projectChatAgentApi={
        {
          list: vi.fn(async () => [
            {
              id: 'agent-1',
              projectId: '12',
              name: '开发机器人',
              status: 'active',
            },
          ]),
        } as never
      }
      teamApi={{ listTeams: vi.fn(async () => []) } as never}
      deviceApi={
        {
          listDevices: vi.fn(async () => [
            {
              id: 1,
              device_id: 'device-1',
              name: '开发机',
              status: 'online',
              is_default: true,
            },
          ]),
        } as never
      }
    />
  )
  return api
}

describe('TaskWorkflowPanel', () => {
  it('saves actor, device, repository, and isolated worktree before starting', async () => {
    const user = userEvent.setup()
    const api = renderPanel()

    await screen.findByTestId('task-workflow-configuration')
    await user.selectOptions(screen.getByTestId('task-workflow-actor'), 'project_agent:agent-1')
    await user.selectOptions(
      screen.getByTestId('task-workflow-execution-target'),
      'registered_device:device-1'
    )
    await user.selectOptions(screen.getByTestId('task-workflow-repository'), 'repository-1')
    await user.click(screen.getByTestId('task-workflow-save-start'))

    await waitFor(() =>
      expect(api.upsertTaskBinding).toHaveBeenCalledWith('12', 'item-1', {
        actor: { type: 'project_agent', id: 'agent-1' },
        repositoryBindingId: 'repository-1',
        executionTarget: { type: 'registered_device', id: 'device-1' },
        workspaceMode: 'git_worktree',
      })
    )
    expect(api.startRun).toHaveBeenCalledWith('12', 'item-1', expect.any(String))
    expect(await screen.findByTestId('task-workflow-status')).toHaveTextContent('等待批准')
  })

  it('approves a human gate using the current stage version', async () => {
    const user = userEvent.setup()
    const api = renderPanel({
      getTaskBinding: vi.fn(async () => binding),
      listRuns: vi.fn(async () => [run]),
    })

    await user.click(await screen.findByTestId('task-workflow-stage-approve-stage-1'))

    await waitFor(() =>
      expect(api.approveStage).toHaveBeenCalledWith('12', 'item-1', 'run-1', 'stage-1', 2)
    )
    expect(screen.getByTestId('task-workflow-status')).toHaveTextContent('已完成')
  })
})
