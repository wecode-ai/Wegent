import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import type { ProjectChatClient, ProjectChatMessage } from '@/api/backend/projectChatSocket'
import { WorkbenchProvider, type WorkbenchServices } from '@/features/workbench/WorkbenchProvider'
import {
  CloudConnectionContext,
  DISCONNECTED_STATE,
} from '@/features/cloud-connection/CloudConnectionContext'
import {
  clearRuntimeConversationCacheForTests,
  applyRuntimeConversationAction,
} from '@/features/workbench/runtimeConversationCache'
import { TaskActivityView } from './TaskActivityView'

vi.mock('@/api/plugins', () => ({
  createPluginApi: () => ({ listInstalledPlugins: vi.fn().mockResolvedValue({ items: [] }) }),
}))

const address = { deviceId: 'device-1', taskId: 'runtime-a' }
const createdAt = '2026-08-01T00:00:00.000Z'
function fixture({ identified = false, hasMoreBefore = false } = {}) {
  const original: ProjectChatMessage = {
    messageId: 'activity-run',
    taskId: 'WEG-1',
    projectId: '11',
    sequenceNumber: 1,
    type: 'agent_status',
    sender: { type: 'agent', id: '12', name: 'Codex engineer' },
    content: 'Activity summary',
    status: 'streaming',
    createdAt,
    updatedAt: createdAt,
    metadata: { run_id: 'run-1', run_status: 'running', automation_run_id: 'automation-1' },
    runtimeAddress: address,
  }
  const client = {
    subscribe: vi.fn(async () => ({
      snapshot: { messages: [original], latestSequence: 1, currentUserId: '1' },
      unsubscribe: vi.fn(),
    })),
    send: vi.fn(),
    startAgentResponse: vi.fn(),
    failAgentResponse: vi.fn(),
    dispose: vi.fn(),
  } satisfies ProjectChatClient
  const getRuntimeTranscript = vi.fn(async () => ({
    taskId: address.taskId,
    runtime: 'codex',
    running: false,
    hasMoreBefore,
    rangeStart: hasMoreBefore ? 10 : 0,
    rangeEnd: hasMoreBefore ? 12 : 2,
    messages: [],
    turns: [
      {
        id: 'original-turn',
        status: 'completed',
        completedAt: '2026-08-01T00:01:00.000Z',
        clientUserMessageId: identified ? original.messageId : undefined,
        items: [
          {
            id: identified ? original.messageId : 'original-user',
            type: 'user_message',
            message: {
              id: identified ? original.messageId : 'original-user',
              role: 'user',
              content: 'ORIGINAL_REQUEST',
              status: 'done',
              createdAt,
            },
          },
          { id: 'original-answer', type: 'assistant_text', content: 'ORIGINAL_ANSWER', createdAt },
        ],
      },
    ],
  }))
  const cancelRuntimeTask = vi.fn().mockResolvedValue({ accepted: true })
  const getLoopItem = vi.fn()
  const onTaskUpdated = vi.fn()
  const onWorkflowManagerFinished = vi.fn()
  const services = {
    teamApi: { listTeams: vi.fn().mockResolvedValue([]) },
    modelApi: { listModels: vi.fn().mockResolvedValue({ data: [] }) },
    skillApi: {
      listSkills: vi.fn().mockResolvedValue([]),
      getTeamSkills: vi.fn().mockResolvedValue({ skills: [], preload_skills: [] }),
    },
    projectApi: { listProjects: vi.fn().mockResolvedValue({ items: [] }) },
    taskApi: {},
    deviceApi: {
      listDevices: vi.fn().mockResolvedValue([
        {
          id: 1,
          device_id: address.deviceId,
          name: 'Device',
          status: 'online',
          device_type: 'cloud',
        },
      ]),
    },
    runtimeWorkApi: {
      listRuntimeWork: vi.fn().mockResolvedValue({
        projects: [],
        chats: [
          {
            deviceId: address.deviceId,
            deviceName: 'Device',
            projectId: null,
            workspacePath: '/workspace',
            tasks: [
              {
                taskId: address.taskId,
                workspacePath: '/workspace',
                title: 'Original task',
                runtime: 'codex',
                running: true,
                status: 'running',
                turnStatus: 'inProgress',
              },
            ],
          },
        ],
        totalTasks: 1,
      }),
      getRuntimeTranscript,
      cancelRuntimeTask,
      getRuntimeGoal: vi.fn().mockResolvedValue({ accepted: true, goal: null }),
    },
    deliveryApi: { getLoopItem },
    chatStream: { subscribe: vi.fn(() => vi.fn()) },
  } as unknown as WorkbenchServices
  const view = render(
    <CloudConnectionContext.Provider
      value={{
        ...DISCONNECTED_STATE,
        isConnected: false,
        serviceKey: 'test-disconnected',
        connectWithAuthorization: vi.fn(),
        refreshUser: vi.fn(),
        disconnect: vi.fn(),
      }}
    >
      <WorkbenchProvider user={{ id: 1, user_name: 'alice', email: 'a@b.c' }} services={services}>
        <TaskActivityView
          client={client}
          project={{ id: '11', name: 'P' } as CloudProject}
          task={{ id: 'WEG-1', title: 'Original task', status: 'in_progress' } as CloudLoopItem}
          workflowManagerRunId="automation-1"
          onTaskUpdated={onTaskUpdated}
          onWorkflowManagerFinished={onWorkflowManagerFinished}
          linear
        />
      </WorkbenchProvider>
    </CloudConnectionContext.Provider>
  )
  return {
    ...view,
    original,
    cancelRuntimeTask,
    getRuntimeTranscript,
    getLoopItem,
    onTaskUpdated,
    onWorkflowManagerFinished,
  }
}

async function openExecution() {
  const badge = await screen.findByTestId('cloud-task-activity-execution-badge-activity-run')
  await userEvent.click(badge)
  return badge
}

describe('opening an activity execution with the real pane session', () => {
  beforeEach(async () => {
    localStorage.clear()
    sessionStorage.clear()
    clearRuntimeConversationCacheForTests()
    await i18n.changeLanguage('zh-CN')
  })
  afterEach(() => {
    cleanup()
    clearRuntimeConversationCacheForTests()
  })

  it.each([false, true])(
    'updates both badges without changing comments or firing business callbacks (identified=%s)',
    async identified => {
      const result = fixture({ identified })
      const badge = await openExecution()
      await waitFor(() => expect(badge).toHaveAttribute('data-status', 'succeeded'))
      expect(screen.getByTestId('runtime-execution-detail-status')).toHaveTextContent('执行成功')
      expect(screen.getByTestId('runtime-execution-detail-body')).toHaveTextContent(
        'ORIGINAL_REQUEST'
      )
      expect(screen.getByTestId('runtime-execution-detail-body')).toHaveTextContent(
        'ORIGINAL_ANSWER'
      )
      expect(result.original.status).toBe('streaming')
      expect(result.original.metadata.run_status).toBe('running')
      expect(result.getLoopItem).not.toHaveBeenCalled()
      expect(result.onTaskUpdated).not.toHaveBeenCalled()
      expect(result.onWorkflowManagerFinished).not.toHaveBeenCalled()
      expect(result.getRuntimeTranscript).toHaveBeenCalledTimes(1)
      await userEvent.click(screen.getByTestId('runtime-execution-detail-close'))
      expect(badge).toHaveAttribute('data-status', 'succeeded')
      act(() =>
        applyRuntimeConversationAction(address, {
          type: 'assistant_started',
          subtaskId: 'next-turn',
        })
      )
      expect(badge).toHaveAttribute('data-status', 'succeeded')
    }
  )

  it('preserves confirmed history and status when reopening fails, then recovers on retry', async () => {
    const result = fixture()
    const badge = await openExecution()
    await waitFor(() => expect(badge).toHaveAttribute('data-status', 'succeeded'))
    await userEvent.click(screen.getByTestId('runtime-execution-detail-close'))
    result.getRuntimeTranscript.mockRejectedValueOnce(new Error('device unavailable'))
    await userEvent.click(badge)
    await screen.findByTestId('runtime-execution-detail-history-retry')
    expect(screen.getByTestId('runtime-execution-detail-body')).toHaveTextContent('ORIGINAL_ANSWER')
    expect(badge).toHaveAttribute('data-status', 'succeeded')
    await userEvent.click(screen.getByTestId('runtime-execution-detail-history-retry'))
    await waitFor(() =>
      expect(screen.queryByTestId('runtime-execution-detail-history-retry')).not.toBeInTheDocument()
    )
    expect(result.getRuntimeTranscript).toHaveBeenCalledTimes(3)
  })

  it('treats an existing idle execution with empty history as unavailable, then recovers on retry', async () => {
    const result = fixture()
    result.getRuntimeTranscript.mockResolvedValueOnce({
      taskId: address.taskId,
      runtime: 'claude_code',
      running: false,
      hasMoreBefore: false,
      rangeStart: 0,
      rangeEnd: 0,
      messages: [],
      turns: [],
    })
    const badge = await openExecution()
    await screen.findByTestId('runtime-execution-detail-transcript-error')
    expect(badge).toHaveAttribute('data-status', 'unknown')
    expect(screen.getByTestId('runtime-execution-detail-status')).toHaveTextContent('状态待核实')
    expect(screen.getByTestId('runtime-execution-detail-transcript-error')).toHaveTextContent(
      '执行器确认当前未运行'
    )
    expect(screen.queryByTestId('runtime-execution-detail-stop')).not.toBeInTheDocument()
    expect(screen.queryByText('开始新的对话')).not.toBeInTheDocument()
    expect(result.original.status).toBe('streaming')
    expect(result.getLoopItem).not.toHaveBeenCalled()
    await userEvent.click(screen.getByTestId('runtime-execution-detail-transcript-retry'))
    await waitFor(() => expect(badge).toHaveAttribute('data-status', 'succeeded'))
    expect(screen.getByTestId('runtime-execution-detail-body')).toHaveTextContent('ORIGINAL_ANSWER')
  })

  it('reloads execution facts after an accepted stop instead of leaving the old stop button', async () => {
    const result = fixture()
    const completed = await result.getRuntimeTranscript()
    result.getRuntimeTranscript.mockClear()
    result.getRuntimeTranscript.mockResolvedValueOnce({
      ...completed,
      running: true,
      turns: [{ ...completed.turns[0], status: 'streaming' }],
    })
    const badge = await openExecution()
    const stop = await screen.findByTestId('runtime-execution-detail-stop')
    await userEvent.click(stop)
    await waitFor(() => expect(result.cancelRuntimeTask).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(badge).toHaveAttribute('data-status', 'succeeded'))
    expect(result.getRuntimeTranscript).toHaveBeenCalledTimes(2)
    expect(screen.queryByTestId('runtime-execution-detail-stop')).not.toBeInTheDocument()
  })

  it('keeps an unreadable execution separate from a completed execution', async () => {
    const result = fixture()
    result.getRuntimeTranscript.mockRejectedValueOnce(new Error('device unavailable'))
    const badge = await openExecution()
    await screen.findByTestId('runtime-execution-detail-transcript-error')
    expect(badge).toHaveAttribute('data-status', 'running')
    expect(screen.getByTestId('runtime-execution-detail-status')).toHaveTextContent('执行中')
    expect(result.getLoopItem).not.toHaveBeenCalled()
  })

  it('updates the associated run from live conversation events after the dialog closes', async () => {
    const result = fixture({ identified: true })
    const page = await result.getRuntimeTranscript()
    page.running = true
    page.turns[0].status = 'streaming'
    result.getRuntimeTranscript.mockResolvedValue(page)
    const badge = await openExecution()
    await waitFor(() =>
      expect(screen.getByTestId('runtime-execution-detail-body')).toHaveTextContent(
        'ORIGINAL_ANSWER'
      )
    )
    await userEvent.click(screen.getByTestId('runtime-execution-detail-close'))
    expect(badge).toHaveAttribute('data-status', 'running')
    act(() =>
      applyRuntimeConversationAction(address, {
        type: 'assistant_done',
        subtaskId: 'original-turn',
        itemId: 'original-answer',
        content: 'FINAL_ANSWER',
      })
    )
    await waitFor(() => expect(badge).toHaveAttribute('data-status', 'succeeded'))
    expect(result.original.status).toBe('streaming')
    expect(result.getLoopItem).not.toHaveBeenCalled()
  })

  it('does not infer a legacy execution from a partial history page', async () => {
    fixture({ hasMoreBefore: true })
    const badge = await openExecution()
    await waitFor(() =>
      expect(screen.getByTestId('runtime-execution-detail-body')).toHaveTextContent(
        'ORIGINAL_ANSWER'
      )
    )
    expect(badge).toHaveAttribute('data-status', 'running')
  })
})
