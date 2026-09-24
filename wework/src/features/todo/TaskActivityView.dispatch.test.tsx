import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { ProjectChatClient } from '@/api/backend/projectChatSocket'
import type { IssueDispatchDto } from '@/api/deliveries'
import { TaskActivityView } from './TaskActivityView'

const dispatchApi = vi.hoisted(() => ({
  list: vi.fn(),
  cancelTask: vi.fn(),
  decide: vi.fn(),
}))

vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbenchPaneContext: () => ({
    state: { runtimeWork: null, devices: [] },
    services: {
      deliveryApi: {
        listIssueDispatches: dispatchApi.list,
        cancelIssueDispatchTask: dispatchApi.cancelTask,
        decideIssueDispatch: dispatchApi.decide,
        getLoopItem: vi.fn(async () => ({
          id: 'issue-1',
          title: 'Issue 总标题',
          status: 'in_progress',
          version: 1,
          status_history: [],
        })),
      },
      projectChatAgentApi: { list: vi.fn(async () => []) },
      chatStream: { subscribe: vi.fn(() => vi.fn()) },
    },
    createProjectRuntimeTask: vi.fn(),
    cancelRuntimeTask: vi.fn(),
    sendRuntimePaneMessage: vi.fn(),
  }),
}))

vi.mock('@/features/workbench/useWorkbenchModels', () => ({
  useWorkbenchModels: () => ({
    models: [],
    selectedModel: null,
    selectedModelOptions: {},
    setSelectedModel: vi.fn(),
    setSelectedModelOption: vi.fn(),
  }),
}))

vi.mock('@/features/workbench/useWorkbenchAttachments', () => ({
  useWorkbenchAttachments: () => ({
    attachments: [],
    uploadingFiles: new Map(),
    errors: new Map(),
    isAttachmentReadyToSend: true,
    handleFileSelect: vi.fn(),
    addExistingAttachment: vi.fn(),
    removeAttachment: vi.fn(),
    resetAttachments: vi.fn(),
  }),
}))

vi.mock('@/features/workbench/runtimeTaskLifecycle', () => ({
  getRuntimeTaskLifecycleKey: vi.fn(),
  useRuntimeTaskLifecycleStoreSnapshot: () => ({ tasks: new Map() }),
}))

const timestamp = '2026-09-24T12:00:00Z'

function groupDispatch(
  taskStatus: IssueDispatchDto['rounds'][number]['tasks'][number]['status'],
  roundStatus: IssueDispatchDto['rounds'][number]['status']
): IssueDispatchDto {
  return {
    id: 'dispatch-1',
    project_id: 'project-1',
    issue_id: 'issue-1',
    target_type: 'group',
    target_id: 'group-1',
    target_name: '性能协作小组',
    status: 'active',
    leader_type: 'human',
    leader_id: 'leader-1',
    leader_name: 'Ada',
    manager_turn_count: 2,
    active_round_id: 'round-1',
    rounds: [
      {
        id: 'round-1',
        sequence: 1,
        status: roundStatus,
        created_at: timestamp,
        updated_at: timestamp,
        tasks: [
          {
            id: 'dispatch-task-1',
            task_title: '采集两轮 CPU 快照',
            instructions: '只读采集，并提交可复核的原始输出。',
            assignee_type: 'agent',
            assignee_id: 'agent-1',
            assignee_name: 'CPU 诊断智能体',
            workflow_stage_id: 'stage-diagnose',
            execution_location: 'local',
            status: taskStatus,
            linked_item_id: null,
            execution_id: null,
            delivery_id: null,
            summary: taskStatus === 'submitted' ? '已提交两轮快照。' : '',
            created_at: timestamp,
            updated_at: timestamp,
          },
        ],
      },
    ],
    created_at: timestamp,
    updated_at: timestamp,
  }
}

const client = {
  subscribe: vi.fn(async () => ({
    snapshot: { messages: [], latestSequence: 0, currentUserId: 'leader-1' },
    unsubscribe: vi.fn(),
  })),
  send: vi.fn(),
  startAgentResponse: vi.fn(),
  failAgentResponse: vi.fn(),
  dispose: vi.fn(),
} satisfies ProjectChatClient

function renderActivity() {
  return render(
    <TaskActivityView
      client={client}
      project={{ id: 'project-1', name: '性能项目', location: 'cloud' } as never}
      task={
        {
          id: 'issue-1',
          title: 'Issue 总标题',
          status: 'in_progress',
          version: 1,
        } as never
      }
      linear
      issueTimeline
    />
  )
}

describe('TaskActivityView Issue Dispatch integration', () => {
  beforeEach(() => {
    dispatchApi.list.mockReset()
    dispatchApi.cancelTask.mockReset()
    dispatchApi.decide.mockReset()
  })

  afterEach(() => cleanup())

  it('renders the shared assignment timeline and cancels a running delegated task', async () => {
    const user = userEvent.setup()
    const running = groupDispatch('running', 'executing')
    const cancelled = groupDispatch('cancelled', 'cancelled')
    dispatchApi.list.mockResolvedValue([running])
    dispatchApi.cancelTask.mockResolvedValue(cancelled)

    renderActivity()

    expect(await screen.findByTestId('issue-dispatch-open')).toBeInTheDocument()
    expect(screen.getByTestId('issue-dispatch-assignment-event-dispatch-task-1')).toHaveTextContent(
      'Ada（负责人）将「采集两轮 CPU 快照」分配给 CPU 诊断智能体'
    )
    expect(screen.getByTestId('issue-dispatch-task-dispatch-task-1')).toHaveTextContent(
      '采集两轮 CPU 快照'
    )
    expect(screen.getByTestId('issue-dispatch-task-dispatch-task-1')).not.toHaveTextContent(
      'Issue 总标题'
    )
    expect(screen.getByTestId('issue-dispatch-assignee-avatar')).toHaveAttribute(
      'title',
      'CPU 诊断智能体'
    )

    await user.click(screen.getByTestId('issue-dispatch-task-cancel'))
    expect(screen.getByTestId('issue-dispatch-cancel-dialog')).toBeInTheDocument()
    await user.click(screen.getByTestId('issue-dispatch-cancel-confirm'))

    await waitFor(() => expect(dispatchApi.cancelTask).toHaveBeenCalledWith('dispatch-task-1'))
    expect(screen.getByTestId('issue-dispatch-task-dispatch-task-1')).toHaveAttribute(
      'data-state',
      'cancelled'
    )
  })

  it('shows the next-round and Issue-decision actions when the leader must evaluate', async () => {
    const user = userEvent.setup()
    const evaluating = groupDispatch('submitted', 'evaluating')
    const completed = { ...evaluating, status: 'completed' as const }
    dispatchApi.list.mockResolvedValue([evaluating])
    dispatchApi.decide.mockResolvedValue(completed)

    renderActivity()

    expect(await screen.findByTestId('issue-dispatch-leader-action-required')).toHaveTextContent(
      '本轮已结束，等待负责人评估'
    )
    expect(screen.getByTestId('issue-dispatch-round-open')).toBeInTheDocument()
    await user.click(screen.getByTestId('issue-dispatch-leader-decide'))
    await user.selectOptions(screen.getByTestId('issue-dispatch-decision-status'), 'completed')
    await user.type(screen.getByTestId('issue-dispatch-decision-reason'), '证据完整，验收通过')
    await user.click(screen.getByTestId('issue-dispatch-decision-submit'))

    await waitFor(() =>
      expect(dispatchApi.decide).toHaveBeenCalledWith('dispatch-1', {
        idempotency_key: expect.any(String),
        target_status: 'completed',
        reason: '证据完整，验收通过',
      })
    )
  })
})
