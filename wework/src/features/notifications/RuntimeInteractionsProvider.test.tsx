import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { NotificationTaskContext, type TaskSource } from './NotificationTaskSourceContext'
import { RuntimeInteractionsProvider } from './RuntimeInteractionsProvider'
import { RuntimeInteractionNotice } from './RuntimeInteractionNotice'
import { RuntimeInteractionsPage } from './RuntimeInteractionsPage'
import { useRuntimeInteractions } from './RuntimeInteractionsContext'
import {
  interactionQuestion,
  interactionTask,
  interactionTranscript,
} from './runtimeInteractions.fixtures'

const harness = vi.hoisted(() => ({
  t: (key: string) => key,
  tabs: {
    tabs: [],
    activeTab: { kind: 'board', contentRoute: '/todo' },
    openTab: vi.fn(),
    selectTab: vi.fn(),
  },
  transcript: vi.fn(),
  send: vi.fn(),
  guide: vi.fn(),
  read: vi.fn(),
  refresh: vi.fn(),
  list: vi.fn(),
}))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: harness.t }) }))
vi.mock('@/features/workspace-tabs/workspaceTabsContextValue', () => ({
  useWorkspaceTabs: () => harness.tabs,
}))
vi.mock('@/desktop/windowFocus', () => ({
  isMainWindowFocused: () => true,
  subscribeMainWindowFocus: () => () => {},
}))
vi.mock('@/lib/runtime-environment', () => ({
  isElectronRuntime: () => false,
  getDesktopWindowLabel: () => 'main',
}))

let context: ReturnType<typeof useRuntimeInteractions>
function Probe() {
  const value = useRuntimeInteractions()
  useEffect(() => {
    context = value
  }, [value])
  return null
}
function view(
  payload = interactionQuestion,
  task = interactionTask,
  active = false,
  initialError?: Error,
  listed = true,
  running = false
) {
  if (initialError) harness.transcript.mockRejectedValue(initialError)
  else harness.transcript.mockResolvedValue({ ...interactionTranscript(payload), running })
  const services = {
    runtimeWorkApi: {
      getRuntimeTranscript: harness.transcript,
      sendRuntimeMessage: harness.send,
      guideRuntimeTask: harness.guide,
      listRuntimeWork: harness.list,
    },
  } as unknown as WorkbenchServices
  const taskSource: TaskSource = {
    items: listed ? [task] : [],
    services,
    unreadTaskKeys: new Set(),
    markRuntimeTaskRead: harness.read,
    refresh: harness.refresh,
  }
  const tree = (taskSource: TaskSource) => (
    <NotificationTaskContext.Provider value={{ taskSource, registerTaskSource: () => {} }}>
      <RuntimeInteractionsProvider accountKey="test:1">
        <Probe />
        <RuntimeInteractionNotice />
        <RuntimeInteractionsPage active={active} />
      </RuntimeInteractionsProvider>
    </NotificationTaskContext.Provider>
  )
  const rendered = render(tree(taskSource))
  return {
    ...rendered,
    taskSource,
    rerenderSource: (source: TaskSource) => rendered.rerender(tree(source)),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  harness.send.mockResolvedValue({ accepted: true })
  harness.guide.mockResolvedValue({ accepted: true })
  harness.refresh.mockResolvedValue(undefined)
  harness.list.mockResolvedValue({ projects: [], chats: [], totalTasks: 0 })
})

describe('unified human response', () => {
  it('retains a remote cache until that exact device has been queried, including startup enumeration', async () => {
    const first = view()
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    const id = context!.pending[0].id
    first.unmount()
    harness.list.mockResolvedValue({ projects: [], chats: [], totalTasks: 0 })
    const restarted = view(interactionQuestion, interactionTask, false, undefined, false)
    await act(async () => {
      await context!.refresh()
    })
    await waitFor(() => expect(context!.loading).toBe(false))
    expect(context!.pending[0]?.id).toBe(id)
    expect(context!.pending[0]?.cached).toBe(true)
    expect(JSON.parse(localStorage.getItem('wework.interactions:test:1:pending')!)).toHaveLength(1)
    const offline = {
      ...restarted.taskSource,
      devices: [
        { device_id: 'device', status: 'offline' } as NonNullable<TaskSource['devices']>[number],
      ],
    }
    restarted.rerenderSource(offline)
    await act(async () => {
      await context!.refresh()
    })
    expect(context!.pending[0]?.id).toBe(id)
    expect(screen.queryByTestId('interaction-reply')).not.toBeInTheDocument()
    harness.list.mockResolvedValue({
      projects: [],
      chats: [{ ...interactionTask.workspace, tasks: [interactionTask.task] }],
      totalTasks: 1,
    })
    restarted.rerenderSource({ ...offline, devices: [{ ...offline.devices[0], status: 'online' }] })
    await act(async () => {
      await context!.refresh()
    })
    expect(context!.pending[0]?.id).toBe(id)
    expect(context!.pending[0]?.cached).not.toBe(true)
    expect(screen.getByTestId('interaction-reply')).toBeInTheDocument()
  })
  it('restores last-known pending work and its draft offline without granting cached response authority', async () => {
    const first = view()
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    const id = context!.pending[0].id
    act(() => context!.setDraft(id, 'Keep existing behavior'))
    first.unmount()
    harness.list.mockRejectedValue(new Error('Device offline'))
    view(interactionQuestion, interactionTask, false, new Error('Device offline'), false)
    await waitFor(() => expect(context!.pending[0]?.cached).toBe(true))
    expect(context!.drafts[id]).toBe('Keep existing behavior')
    await act(async () => {
      expect(await context!.respond(context!.pending[0], 'Keep existing behavior')).toBe(false)
    })
    expect(harness.send).not.toHaveBeenCalled()
    harness.list.mockResolvedValue({
      projects: [],
      chats: [{ ...interactionTask.workspace, tasks: [interactionTask.task] }],
      totalTasks: 1,
    })
    harness.transcript.mockResolvedValue(interactionTranscript())
    await act(async () => {
      await context!.refresh()
    })
    expect(context!.pending[0].cached).not.toBe(true)
    expect(context!.drafts[id]).toBe('Keep existing behavior')
  })
  it('retains a hidden request while its device is offline and restores answering after recovery', async () => {
    const work = {
      projects: [],
      chats: [{ ...interactionTask.workspace, tasks: [interactionTask.task] }],
      totalTasks: 1,
    }
    harness.list.mockResolvedValue(work)
    const rendered = view(interactionQuestion, interactionTask, false, undefined, false)
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    const offline = {
      ...rendered.taskSource,
      devices: [
        { device_id: 'device', status: 'offline' } as NonNullable<TaskSource['devices']>[number],
      ],
    }
    harness.list.mockResolvedValue({ projects: [], chats: [], totalTasks: 0 })
    rendered.rerenderSource(offline)
    await act(async () => {
      await context!.refresh()
    })
    expect(context!.pending).toHaveLength(1)
    expect(context!.pending[0].task.workspace.available).toBe(false)
    expect(screen.getByTestId('interaction-open-original-action')).toBeInTheDocument()
    harness.list.mockResolvedValue(work)
    rendered.rerenderSource({ ...offline, devices: [{ ...offline.devices[0], status: 'online' }] })
    await act(async () => {
      await context!.refresh()
    })
    expect(context!.pending).toHaveLength(1)
    expect(screen.queryByTestId('interaction-open-original-action')).not.toBeInTheDocument()
    expect(harness.send).not.toHaveBeenCalled()
  })
  it('discovers pending work even when no corresponding task is listed in the sidebar', async () => {
    harness.list.mockResolvedValue({
      projects: [],
      chats: [{ ...interactionTask.workspace, tasks: [interactionTask.task] }],
      totalTasks: 1,
    })
    view(interactionQuestion, interactionTask, false, undefined, false)
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    expect(harness.list).toHaveBeenCalledWith({ pendingOnly: true, deviceId: undefined })
    expect(context!.pending[0].task.address).toMatchObject({
      deviceId: interactionTask.address.deviceId,
      taskId: interactionTask.address.taskId,
    })
    expect(harness.read).not.toHaveBeenCalled()
  })
  it('suppresses a reminder only when its exact question is already visible', async () => {
    view(interactionQuestion, interactionTask, true)
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    expect(screen.queryByTestId('runtime-interaction-notice')).not.toBeInTheDocument()
    act(() => context!.registerView('other-pane', 'another-question'))
    expect(context!.pending).toHaveLength(1)
  })

  it('guides a running async task and accepts the guidance API success response', async () => {
    harness.guide.mockResolvedValue({ success: true })
    const task = {
      ...interactionTask,
      lifecycle: { turn: { active: true } },
    } as typeof interactionTask
    view(interactionQuestion, task, false, undefined, true, true)
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    await act(async () => {
      expect(await context!.respond(context!.pending[0], 'keep')).toBe(true)
    })
    expect(harness.guide).toHaveBeenCalledWith(
      expect.objectContaining({ address: interactionTask.address, message: 'keep' })
    )
    expect(harness.send).not.toHaveBeenCalled()
    expect(context!.pending).toHaveLength(0)
  })

  it.each([false, true])(
    'preserves the owning remote model configuration (handle only: %s)',
    async handleOnly => {
      const modelSelection = {
        modelName: 'team-review-model',
        modelType: 'user' as const,
        options: { reasoning: 'high', weworkCloudModelNamespace: 'team' },
      }
      const task = {
        ...interactionTask,
        task: {
          ...interactionTask.task,
          ...(handleOnly ? { runtimeHandle: { modelSelection } } : { modelSelection }),
        },
      }
      view(interactionQuestion, task)
      await waitFor(() => expect(context!.pending).toHaveLength(1))
      await act(async () => {
        expect(await context!.respond(context!.pending[0], 'keep')).toBe(true)
      })
      expect(harness.send).toHaveBeenCalledWith(
        expect.objectContaining({
          modelSelection,
          modelId: modelSelection.modelName,
          modelOptions: modelSelection.options,
        })
      )
    }
  )

  it('keeps an actionable pending entry when the first transcript read fails, then recovers', async () => {
    const viewResult = view(
      interactionQuestion,
      interactionTask,
      false,
      new Error('Device offline')
    )
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    await act(async () => {
      await context!.refresh()
    })
    expect(context!.pending).toHaveLength(1)
    expect(screen.getByTestId('interaction-open-original-action')).toBeInTheDocument()
    expect(harness.send).not.toHaveBeenCalled()
    harness.transcript.mockResolvedValue(interactionTranscript())
    await act(async () => {
      await context!.refresh()
    })
    expect(context!.pending[0].question).toBe('Keep existing customer behavior?')
    viewResult.unmount()
  })
  it('keeps pending work when a reminder is dismissed or opened, independently of unread', async () => {
    view()
    await screen.findByTestId('runtime-interaction-notice')
    fireEvent.click(screen.getByTestId('interaction-notice-dismiss'))
    expect(screen.queryByTestId('runtime-interaction-notice')).not.toBeInTheDocument()
    expect(context!.pending).toHaveLength(1)
    expect(screen.getByTestId('interactions-pending-count')).toHaveTextContent('1')
    expect(harness.read).not.toHaveBeenCalled()
    act(() => context!.open(context!.pending[0].id))
    expect(harness.tabs.openTab).toHaveBeenCalledWith(
      'auxiliary',
      expect.objectContaining({ id: 'pending-interactions' })
    )
    expect(context!.pending).toHaveLength(1)
  })

  it('sends an async answer as a user message and removes it only after acceptance', async () => {
    view()
    await screen.findByTestId('runtime-interaction-notice')
    await act(async () => {
      expect(await context!.respond(context!.pending[0], 'keep')).toBe(true)
    })
    expect(harness.send).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'keep', queueIfBusy: true })
    )
    expect(harness.send.mock.calls[0][0]).not.toHaveProperty('requestUserInputResponse')
    expect(context!.pending).toHaveLength(0)
    expect(context!.history).toHaveLength(1)
  })

  it('preserves a rejected response and its draft, then permits a real retry', async () => {
    harness.send.mockResolvedValueOnce({ accepted: false, error: 'Rejected' })
    view()
    await screen.findByTestId('runtime-interaction-notice')
    const item = context!.pending[0]
    act(() => context!.setDraft(item.id, 'Keep existing configuration'))
    await act(async () => {
      expect(await context!.respond(item, 'Keep existing configuration')).toBe(false)
    })
    expect(context!.pending).toHaveLength(1)
    expect(context!.history).toHaveLength(0)
    expect(context!.drafts[item.id]).toBe('Keep existing configuration')
    expect(context!.errors[item.id]).toBe('interactions.failed')
    await act(async () => {
      expect(await context!.respond(item, 'Keep existing configuration')).toBe(true)
    })
    expect(harness.send.mock.calls[1][0].clientUserMessageId).toBe(
      harness.send.mock.calls[0][0].clientUserMessageId
    )
    expect(context!.pending).toHaveLength(0)
  })

  it('answers a synchronous request with its identity instead of creating a user turn', async () => {
    view({ ...interactionQuestion, delivery: undefined, requestId: 22, interactionScope: 'turn-1' })
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    await act(async () => {
      await context!.respond(context!.pending[0], 'keep')
    })
    expect(harness.send).toHaveBeenCalledWith(
      expect.objectContaining({
        requestUserInputResponse: expect.objectContaining({
          requestId: 22,
          interactionScope: 'turn-1',
          answers: { compatibility: { answers: ['keep'] } },
        }),
      })
    )
  })

  it('never turns an execution approval into an ordinary reply', async () => {
    view({ ...interactionQuestion, approvalKind: 'command' })
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    await act(async () => {
      expect(await context!.respond(context!.pending[0], 'Allow')).toBe(false)
    })
    expect(harness.send).not.toHaveBeenCalled()
    expect(screen.getByTestId('interaction-open-original-action')).toBeInTheDocument()
  })

  it('revalidates a request already answered in its original conversation', async () => {
    view()
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    harness.transcript.mockResolvedValue(
      interactionTranscript({ ...interactionQuestion, interactionStatus: 'answered' })
    )
    await act(async () => {
      expect(await context!.respond(context!.pending[0], 'keep')).toBe(false)
    })
    expect(harness.send).not.toHaveBeenCalled()
  })
})
