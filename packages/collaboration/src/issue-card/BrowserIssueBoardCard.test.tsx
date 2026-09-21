import { IssueExecutionDetails } from '../issue-detail/IssueExecutionDetails'
// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import type { RuntimeConversationHandlers } from '@wegent/chat-core'
import { BrowserIssueBoardCard } from './BrowserIssueBoardCard'
import { createIssueBoardCardLabels } from './messages'
import { createCollaborationTranslator } from '../i18n'
import type { CollaborationIssue } from '../types'
import type { SharedWorkspaceRuntimeApi } from '../ports/SharedWorkspaceApi'
import { BrowserTaskDrafts } from '../issue-detail/BrowserTaskDrafts'
import { useBrowserTaskDraft } from '../issue-detail/browserTaskDraftContext'
import { IssueTaskConversation } from '../issue-detail/IssueTaskConversation'

const translate = createCollaborationTranslator('zh-CN')
const item = {
  id: 'issue-1',
  title: '检查 pwd',
  cloud_project_id: 'project-1',
  status: 'in_progress',
  priority: 'none',
  tags: [],
  description: '',
  execution_state: 'running',
} as CollaborationIssue
const binding = {
  id: 'binding-1',
  projectId: 'project-1',
  issueId: 'issue-1',
  taskUserId: 1,
  deviceId: 'device-1',
  taskId: 'task-1',
  taskTitle: 'pwd',
  backendTaskId: null,
  linkedAt: '',
}
const work = {
  projects: [],
  totalTasks: 1,
  chats: [
    {
      deviceId: 'device-1',
      deviceName: 'PC',
      workspacePath: '/repo',
      available: true,
      tasks: [
        {
          taskId: 'task-1',
          title: 'pwd',
          workspacePath: '/repo',
          runtime: 'codex',
          running: true,
        },
      ],
    },
  ],
}

function DraftSeed() {
  const draft = useBrowserTaskDraft('device-1:task-1')
  return (
    <button data-testid="seed-task-draft" onClick={() => draft.setDraft('继续检查目录')}>
      Seed draft
    </button>
  )
}

describe('Web board with the native runtime progress presentation', () => {
  let root: Root
  let container: HTMLDivElement
  let runtime: SharedWorkspaceRuntimeApi
  let handlers: RuntimeConversationHandlers
  let unsubscribe: ReturnType<typeof vi.fn>
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    )
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }))
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    unsubscribe = vi.fn()
    runtime = {
      executeCommand: vi.fn(),
      fileChangesFromError: () => undefined,
      listDevices: vi.fn().mockResolvedValue([]),
      subscribeChatStream: vi.fn().mockResolvedValue(() => {}),
      work: {
        createRuntimeTask: vi.fn(),
        listRuntimeWork: vi.fn().mockResolvedValue(work),
        sendRuntimeMessage: vi.fn(),
        guideRuntimeTask: vi.fn(),
        interruptAndSendRuntimeMessage: vi.fn(),
        cancelRuntimeTask: vi.fn(),
        revertRuntimeFileChanges: vi.fn(),
        getRuntimeGoal: vi.fn().mockResolvedValue({ accepted: true, taskId: 'task-1', goal: null }),
      },
      getTranscript: vi.fn().mockResolvedValue({
        runtime: 'codex',
        workspacePath: '/repo',
        running: true,
        messages: [],
        turns: [
          {
            id: 'turn-1',
            status: 'streaming',
            items: [
              {
                id: 'text-1',
                type: 'assistant_text',
                content: 'Working on pwd',
                createdAt: '2026-09-17T00:00:00Z',
              },
            ],
          },
        ],
      }),
      subscribe: vi.fn(async (_address, next) => {
        handlers = next
        return unsubscribe
      }),
      cancel: vi.fn(),
      dispose: vi.fn(),
      listModels: vi.fn().mockResolvedValue([]),
      uploadAttachment: vi.fn(),
      deleteAttachment: vi.fn(),
      readAttachment: vi.fn(),
      readWorkspaceFile: vi.fn(),
      openModelSettings: vi.fn(),
    }
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })
  async function render(disabled = false, sidebar = false) {
    await act(async () =>
      root.render(
        <BrowserTaskDrafts runtime={runtime}>
          <DraftSeed />
          <BrowserIssueBoardCard
            runtime={runtime}
            work={work}
            taskBindings={[binding]}
            item={item}
            focused={false}
            translate={translate}
            reference="COL-1"
            labels={createIssueBoardCardLabels(translate)}
            display={{
              showAssignee: false,
              showDate: false,
              showPriority: false,
              showTags: false,
            }}
            previewDisabled={disabled}
          />
          {sidebar && (
            <BrowserTaskDrafts runtime={runtime}>
              <IssueTaskConversation
                runtime={runtime}
                issueId={item.id}
                translate={translate}
                onClose={() => {}}
                binding={{
                  id: binding.id,
                  cloud_project_id: binding.projectId,
                  loop_item_id: item.id,
                  device_id: binding.deviceId,
                  task_id: binding.taskId,
                  task_title: binding.taskTitle,
                  task_user_id: binding.taskUserId,
                  backend_task_id: binding.backendTaskId,
                  linked_at: binding.linkedAt,
                }}
              />
            </BrowserTaskDrafts>
          )}
        </BrowserTaskDrafts>
      )
    )
  }
  it('shows APP access guidance in the card, popup and drawer without starting runtime readers', async () => {
    runtime.checkDeviceAccess = vi.fn().mockResolvedValue({ 'device-1': 'app-local-only' })
    await render()
    expect(container.textContent).toContain('请在 PC App 查看进展')
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="cloud-todo-card-progress-trigger-issue-1"]'
        )!
        .click()
    )
    expect(document.body.textContent).toContain('请在 PC App 查看进展')
    expect(
      document.querySelector('[data-testid="cloud-todo-card-progress-retry-issue-1"]')
    ).toBeNull()
    expect(document.querySelector('[data-testid="runtime-device-access-retry"]')).toBeNull()
    await render(true, true)
    expect(document.body.textContent).toContain('请在 PC App 查看进展')
    expect(runtime.getTranscript).not.toHaveBeenCalled()
    expect(runtime.subscribe).not.toHaveBeenCalled()
    expect(runtime.work.getRuntimeGoal).not.toHaveBeenCalled()
    expect(runtime.listModels).not.toHaveBeenCalled()
  })

  it('keeps the execution dialog closable for an APP task without requesting a transcript', async () => {
    runtime.checkDeviceAccess = vi.fn().mockResolvedValue({ 'device-1': 'app-local-only' })
    const close = vi.fn()
    await act(async () =>
      root.render(
        <IssueExecutionDetails
          runtime={runtime}
          translate={translate}
          onClose={close}
          target={{
            address: { deviceId: binding.deviceId, taskId: binding.taskId },
            senderName: 'Codex',
            taskTitle: 'pwd',
          }}
        />
      )
    )
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('请在 PC App 查看进展')
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(close).toHaveBeenCalledOnce()
    expect(runtime.getTranscript).not.toHaveBeenCalled()
    expect(runtime.subscribe).not.toHaveBeenCalled()
  })

  it('reads project execution history without requiring ownership of the agent device', async () => {
    runtime.checkDeviceAccess = vi.fn().mockResolvedValue({ 'device-1': 'unavailable' })
    const address = {
      deviceId: binding.deviceId,
      taskId: binding.taskId,
      projectSession: { projectId: binding.projectId, issueId: item.id },
    }
    await act(async () =>
      root.render(
        <IssueExecutionDetails
          runtime={runtime}
          translate={translate}
          onClose={vi.fn()}
          target={{ address, senderName: 'Codex' }}
        />
      )
    )
    expect(runtime.checkDeviceAccess).not.toHaveBeenCalled()
    expect(runtime.getTranscript).toHaveBeenCalledWith(expect.objectContaining(address))
  })

  it('retries an access lookup failure and resumes the normal conversation for an allowed device', async () => {
    runtime.checkDeviceAccess = vi
      .fn()
      .mockRejectedValueOnce(new Error('Device catalog offline'))
      .mockResolvedValue({ 'device-1': 'allowed' })
    await render()
    expect(container.textContent).toContain('Device catalog offline')
    expect(runtime.getTranscript).not.toHaveBeenCalled()
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="runtime-device-access-retry"]')!
        .click()
    )
    expect(runtime.getTranscript).toHaveBeenCalled()
    expect(runtime.subscribe).toHaveBeenCalled()
    expect(container.textContent).not.toContain('Device catalog offline')
  })

  it('uses the same goal summary in the card and popup without refetching on open', async () => {
    const goal = {
      threadId: 'task-1',
      objective: '验证 pwd 的工作目录',
      status: 'active' as const,
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 1,
    }
    vi.mocked(runtime.work.getRuntimeGoal).mockResolvedValue({
      accepted: true,
      taskId: 'task-1',
      goal,
    })
    await render()
    expect(runtime.work.getRuntimeGoal).toHaveBeenCalledWith({
      address: { deviceId: binding.deviceId, taskId: binding.taskId },
    })
    expect(
      container
        .querySelector('[data-testid="cloud-todo-card-goal-issue-1-binding-1"]')
        ?.getAttribute('aria-label')
    ).toContain(goal.objective)
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="cloud-todo-card-progress-trigger-issue-1"]'
        )!
        .click()
    )
    expect(
      document.querySelector('[data-testid="cloud-todo-card-popup-goal-issue-1-binding-1"]')
        ?.textContent
    ).toContain(goal.objective)
    expect(runtime.work.getRuntimeGoal).toHaveBeenCalledOnce()
  })
  it('keeps a rejected goal load visible and retries without duplicating the conversation session', async () => {
    vi.mocked(runtime.work.getRuntimeGoal).mockResolvedValueOnce({
      accepted: false,
      taskId: 'task-1',
      goal: null,
      error: 'Goal is temporarily unavailable',
    })
    await render()
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="cloud-todo-card-progress-trigger-issue-1"]'
        )!
        .click()
    )
    expect(document.body.textContent).toContain('Goal is temporarily unavailable')
    const subscriptions = vi.mocked(runtime.subscribe).mock.calls.length
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[data-testid="cloud-todo-card-goal-retry-issue-1"]')!
        .click()
    )
    expect(document.body.textContent).not.toContain('Goal is temporarily unavailable')
    expect(runtime.work.getRuntimeGoal).toHaveBeenCalledTimes(2)
    expect(runtime.subscribe).toHaveBeenCalledTimes(subscriptions)
  })
  it('loads the actual task and updates its final answer from live events', async () => {
    await render()
    expect(runtime.getTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 'device-1', taskId: 'task-1' })
    )
    expect(container.textContent).toContain('Working on pwd')
    await act(async () => {
      handlers.onMessageAction({
        type: 'assistant_chunk',
        subtaskId: 'turn-1',
        itemId: 'final-1',
        content: '/repo',
        offset: 0,
      })
      handlers.onMessageAction({
        type: 'assistant_done',
        subtaskId: 'turn-1',
        itemId: 'final-1',
        content: '/repo',
      })
      handlers.onAssistantSettled?.('turn-1', 'succeeded')
    })
    expect(
      container.querySelector('[data-testid="cloud-todo-card-final-response-issue-1"]')?.textContent
    ).toBe('/repo')
  })
  it('disables the progress popup while the Issue drawer is present', async () => {
    await render()
    expect(
      container.querySelector('[data-testid="cloud-todo-card-progress-trigger-issue-1"]')
    ).not.toBeNull()
    await render(true)
    expect(
      container.querySelector('[data-testid="cloud-todo-card-progress-trigger-issue-1"]')
    ).toBeNull()
  })
  it('surfaces transcript failure and recovers through the same subscription', async () => {
    vi.mocked(runtime.getTranscript).mockRejectedValueOnce(new Error('Device disconnected'))
    await render()
    expect(container.textContent).toContain('Device disconnected')
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="cloud-todo-card-progress-retry-issue-1"]')!
        .click()
    )
    expect(container.textContent).not.toContain('Device disconnected')
    expect(container.textContent).toContain('Working on pwd')
    expect(runtime.subscribe).toHaveBeenCalledTimes(1)
  })
  it('uses the native conversation and preserves its draft from the progress popup to the sidebar', async () => {
    await render()
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="seed-task-draft"]')!.click()
    )
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="cloud-todo-card-progress-trigger-issue-1"]'
        )!
        .click()
    )
    const popup = document.querySelector(
      '[data-testid="cloud-todo-card-popup-conversation-issue-1"]'
    )
    expect(popup).not.toBeNull()
    expect(popup?.querySelector('[data-testid="chat-input"]')?.textContent).toContain(
      '继续检查目录'
    )
    expect(popup?.querySelector('[data-testid="right-workspace-chat-scroll-area"]')).not.toBeNull()
    await render(true, true)
    expect(
      document.querySelector('[data-testid="cloud-todo-card-popup-conversation-issue-1"]')
    ).toBeNull()
    expect(container.querySelector('[data-testid="chat-input"]')?.textContent).toContain(
      '继续检查目录'
    )
  })
})
