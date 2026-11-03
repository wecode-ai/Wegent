import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { WorkbenchContext } from '@/features/workbench/workbenchContexts'
import type { WorkbenchContextValue } from '@/features/workbench/workbenchContextTypes'
import {
  RuntimeTaskLifecycleProvider,
  RuntimeTaskLifecycleStore,
} from '@/features/workbench/runtimeTaskLifecycle'
import {
  applyRuntimeConversationAction,
  clearRuntimeConversationCacheForTests,
  getRuntimeConversationMessages,
} from '@/features/workbench/runtimeConversationCache'
import type { RuntimeTaskSummary } from '@/types/api'
import type { RuntimeGuidanceRequest } from '@/types/api'
import type { RuntimePaneGuidanceResult } from '@/features/workbench/workbenchContextTypes'
import GitTaskStatus from './task-status'

vi.mock('@/features/app-preferences/useAppPreferencesState', () => ({
  useAppPreferencesState: () => null,
}))
vi.mock('@/features/workbench/changeRequestMonitor', () => ({
  runtimeTaskChangeRequestTarget: () => null,
  useTaskChangeRequest: () => ({
    changeRequest: {
      provider: 'github',
      number: 48,
      url: 'https://github.com/wecode-ai/Wegent/pull/48',
      title: 'Fix CI',
      state: 'open',
      checks: 'failure',
    },
  }),
}))

const address = { deviceId: 'device', taskId: 'task' }
const repairButton = 'runtime-local-task-change-request-task-repair'

function fixture(running: boolean) {
  const task: RuntimeTaskSummary = {
    taskId: address.taskId,
    title: 'Fix CI',
    runtime: 'codex',
    running,
    continuable: true,
  }
  const store = new RuntimeTaskLifecycleStore('pr-repair-test')
  const workbench = {
    sendRuntimePaneMessage: vi.fn().mockResolvedValue(true),
    sendRuntimePaneGuidance: vi
      .fn<(request: RuntimeGuidanceRequest) => Promise<RuntimePaneGuidanceResult>>()
      .mockResolvedValue({ sent: true, turnId: 'active-turn' }),
    setWorkbenchError: vi.fn(),
  }
  render(
    <RuntimeTaskLifecycleProvider store={store}>
      <WorkbenchContext.Provider value={workbench as unknown as WorkbenchContextValue}>
        <GitTaskStatus
          task={task}
          workspace={{ ...address, workspacePath: '/repo', available: true, tasks: [task] }}
        />
      </WorkbenchContext.Provider>
    </RuntimeTaskLifecycleProvider>
  )
  return { store, task, ...workbench }
}

async function repair() {
  await userEvent.click(screen.getByTestId('runtime-local-task-change-request-task'))
  await userEvent.click(screen.getByTestId(repairButton))
}

describe('sidebar PR repair', () => {
  afterEach(clearRuntimeConversationCacheForTests)

  test('guides the running turn and displays the repair inside that turn', async () => {
    const { sendRuntimePaneMessage, sendRuntimePaneGuidance } = fixture(true)
    applyRuntimeConversationAction(address, {
      type: 'assistant_started',
      taskId: address.taskId,
      subtaskId: 'active-turn',
    })
    await repair()

    expect(sendRuntimePaneMessage).not.toHaveBeenCalled()
    const request = sendRuntimePaneGuidance.mock.calls[0][0]
    expect(request).toMatchObject({ address, message: expect.stringContaining('修复 PR/MR #48') })
    expect(getRuntimeConversationMessages(address)).toContainEqual(
      expect.objectContaining({
        id: request.clientGuidanceId,
        content: request.message,
        role: 'user',
        runtimeGuidance: true,
      })
    )
  })

  test('continues an idle task with an optimistic user message', async () => {
    const { sendRuntimePaneMessage, sendRuntimePaneGuidance } = fixture(false)
    await repair()

    expect(sendRuntimePaneGuidance).not.toHaveBeenCalled()
    expect(sendRuntimePaneMessage).toHaveBeenCalledWith(
      expect.objectContaining({ address, source: { source: 'manual' } }),
      { optimisticUserMessage: expect.objectContaining({ role: 'user' }) }
    )
  })

  test('reads live lifecycle state when the sidebar task projection is stale', async () => {
    const { store, task, sendRuntimePaneMessage, sendRuntimePaneGuidance } = fixture(false)
    store.syncRuntimeTask(address, { ...task, running: true })
    await repair()

    expect(sendRuntimePaneGuidance).toHaveBeenCalledOnce()
    expect(sendRuntimePaneMessage).not.toHaveBeenCalled()
  })

  test('continues normally if the running turn finishes before guidance arrives', async () => {
    const { sendRuntimePaneMessage, sendRuntimePaneGuidance } = fixture(true)
    sendRuntimePaneGuidance.mockResolvedValue({ sent: false, code: 'no_active_turn' })
    await repair()

    expect(sendRuntimePaneGuidance).toHaveBeenCalledOnce()
    expect(sendRuntimePaneMessage).toHaveBeenCalledOnce()
  })

  test('reports guidance rejection without submitting a duplicate turn', async () => {
    const { sendRuntimePaneMessage, sendRuntimePaneGuidance, setWorkbenchError } = fixture(true)
    sendRuntimePaneGuidance.mockResolvedValue({ sent: false, error: 'Executor unavailable' })
    await repair()

    expect(setWorkbenchError).toHaveBeenLastCalledWith('Executor unavailable')
    expect(sendRuntimePaneMessage).not.toHaveBeenCalled()
    expect(getRuntimeConversationMessages(address)).toEqual([])
  })

  test('reports transport errors and allows another repair attempt', async () => {
    const { sendRuntimePaneGuidance, setWorkbenchError } = fixture(true)
    sendRuntimePaneGuidance.mockRejectedValueOnce(new Error('Connection lost'))
    await repair()
    expect(setWorkbenchError).toHaveBeenLastCalledWith('Connection lost')

    await userEvent.click(screen.getByTestId('runtime-local-task-change-request-task'))
    await waitFor(() => expect(screen.getByTestId(repairButton)).toBeEnabled())
    await userEvent.click(screen.getByTestId(repairButton))
    expect(sendRuntimePaneGuidance).toHaveBeenCalledTimes(2)
  })
})
