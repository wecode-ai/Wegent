import { BrowserIssueExecution } from './BrowserIssueExecution'
// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectChatClient, ProjectChatMessage } from '@wegent/chat-core'
import type { RuntimeConversationHandlers } from '@wegent/chat-core/runtime-conversation-client'
import type { SharedWorkspaceApi, SharedWorkspaceRuntimeApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationIssue, CollaborationProject } from '../types'
import { createCollaborationTranslator } from '../i18n'
import { BrowserTaskDrafts } from './BrowserTaskDrafts'
import { BrowserIssueReplies } from './BrowserIssueReplies'
import { BrowserIssueReplyComposer } from './BrowserIssueReplyComposer'
const project = {
  id: 'project-1',
  name: 'Project',
  project_key: 'P',
  project_store: 'backend',
  task_provider: 'local',
  provider_config: {},
} as CollaborationProject
const issue = {
  id: 'issue-1',
  title: 'Issue',
  status: 'in_progress',
  assignee_agent_id: 'agent-1',
} as CollaborationIssue
const user = {
  messageId: 'root',
  projectId: project.id,
  taskId: issue.id,
  sequenceNumber: 1,
  content: 'Start',
  sender: { type: 'user', id: '1', name: 'Me' },
  metadata: {},
  status: 'completed',
  createdAt: '',
  updatedAt: '',
} as ProjectChatMessage
const run = {
  ...user,
  messageId: 'run',
  rootMessageId: 'root',
  runtimeAddress: { deviceId: 'device-1', taskId: 'original-task' },
  sender: { type: 'agent', id: 'agent-1', name: 'AI' },
  status: 'streaming',
  sequenceNumber: 2,
} as ProjectChatMessage
const translate = createCollaborationTranslator('en')

describe('browser card replies through the actual shared queue and HTTP bridge', () => {
  let root: Root
  let container: HTMLDivElement
  let runtime: SharedWorkspaceRuntimeApi
  let client: ProjectChatClient
  let handlers: RuntimeConversationHandlers
  let api: Pick<SharedWorkspaceApi, 'attachments' | 'taskBindings' | 'issues'>
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    runtime = {
      executeCommand: vi.fn(),
      fileChangesFromError: () => undefined,
      listDevices: vi.fn().mockResolvedValue([]),
      listModels: vi.fn(),
      work: {
        listRuntimeWork: vi.fn().mockResolvedValue({
          projects: [],
          totalTasks: 1,
          chats: [
            {
              deviceId: 'device-1',
              workspacePath: '/work',
              available: true,
              tasks: [
                {
                  taskId: 'original-task',
                  runtime: 'codex',
                  title: 'Work',
                  workspacePath: '/work',
                  running: true,
                },
              ],
            },
          ],
        }),
        createRuntimeTask: vi.fn(),
        sendRuntimeMessage: vi.fn().mockResolvedValue({ accepted: true }),
        guideRuntimeTask: vi.fn(),
        interruptAndSendRuntimeMessage: vi.fn(),
        cancelRuntimeTask: vi.fn(),
        revertRuntimeFileChanges: vi.fn(),
        getRuntimeGoal: vi.fn().mockResolvedValue({ accepted: true, taskId: 'task-1', goal: null }),
      },
      subscribe: vi.fn(async (_address, callbacks) => {
        handlers = callbacks
        return () => {}
      }),
      subscribeChatStream: vi.fn().mockResolvedValue(() => {}),
      getTranscript: vi.fn(),
      cancel: vi.fn(),
      dispose: vi.fn(),
      uploadAttachment: vi.fn().mockResolvedValue({
        id: 21,
        filename: 'notes.txt',
        file_size: 1,
        mime_type: 'text/plain',
        file_extension: 'txt',
        status: 'ready',
        created_at: '',
      }),
      deleteAttachment: vi.fn(),
      readAttachment: vi.fn(),
      readWorkspaceFile: vi.fn(),
      openModelSettings: vi.fn(),
    }
    client = {
      send: vi.fn().mockResolvedValue({ ...user, messageId: 'reply' }),
      startAgentResponse: vi.fn().mockResolvedValue({ ...run, messageId: 'continued-run' }),
      failAgentResponse: vi.fn(),
    } as unknown as ProjectChatClient
    api = {
      issues: { get: vi.fn().mockResolvedValue(issue) } as unknown as SharedWorkspaceApi['issues'],
      attachments: {
        importContexts: vi.fn().mockResolvedValue([
          {
            id: 'issue-attachment',
            display_name: 'notes.txt',
            markdown_url: 'wegent://attachments/issue-attachment',
          },
        ]),
      } as unknown as SharedWorkspaceApi['attachments'],
      taskBindings: { list: vi.fn(), bindTask: vi.fn(), unbindTask: vi.fn() },
    }
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })
  async function mount(show = true) {
    await act(async () =>
      root.render(
        <BrowserTaskDrafts runtime={runtime}>
          <BrowserIssueExecution runtime={runtime}>
            {show && (
              <BrowserIssueReplies
                api={api}
                runtime={runtime}
                client={client}
                project={project}
                issue={issue}
                agents={[{ id: 'agent-1', name: 'AI', runtime: 'codex', status: 'active' }]}
                messages={[user, run]}
                onMessages={() => {}}
                canComment
                translate={translate}
              >
                <BrowserIssueReplyComposer
                  rootId="root"
                  disabled={false}
                  canAttach
                  translate={translate}
                />
              </BrowserIssueReplies>
            )}
          </BrowserIssueExecution>
        </BrowserTaskDrafts>
      )
    )
  }
  async function send(text: string) {
    await act(async () => {
      const input = container.querySelector('textarea')!
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        input,
        text
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () =>
      (
        container.querySelector('[data-testid="collaboration-chat-reply-send-root"]') as HTMLElement
      ).click()
    )
  }
  it('keeps the PC queue while busy and continues exactly its original session when live runtime settles', async () => {
    await mount()
    await send('Continue this card')
    expect(client.send).not.toHaveBeenCalled()
    expect(
      container.querySelector('[data-testid="conversation-queue-panel"]')?.textContent
    ).toContain('Continue this card')
    await act(async () => handlers.onAssistantSettled?.('turn-1', 'succeeded'))
    expect(client.send).toHaveBeenCalledOnce()
    expect(client.send).toHaveBeenCalledWith(
      expect.objectContaining({ replyToMessageId: 'root', text: 'Continue this card' })
    )
    expect(runtime.work.sendRuntimeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        address: { deviceId: 'device-1', taskId: 'original-task' },
        message: 'Continue this card',
      })
    )
    expect(runtime.work.createRuntimeTask).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="conversation-queue-panel"]')).toBeNull()
  })
  it('continues a bound card when the main composer model catalog fails', async () => {
    vi.mocked(runtime.listDevices).mockResolvedValue([
      {
        id: 1,
        device_id: 'device-1',
        name: 'Device',
        status: 'online',
        device_type: 'local',
        executor_version: '1.9.0',
        is_default: true,
      },
    ])
    vi.mocked(runtime.listModels).mockRejectedValue(new Error('model catalog unavailable'))
    await mount()
    await send('Use the bound session')
    await act(async () => handlers.onAssistantSettled?.('turn-1', 'succeeded'))
    expect(runtime.listModels).toHaveBeenCalledWith('device-1')
    expect(runtime.work.sendRuntimeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        address: { deviceId: 'device-1', taskId: 'original-task' },
        message: 'Use the bound session',
      })
    )
    expect(runtime.work.createRuntimeTask).not.toHaveBeenCalled()
  })

  it('refreshes stale live running state after history invalidation before releasing a reply', async () => {
    await mount()
    await act(async () => handlers.onAssistantStart?.('turn-1'))
    await send('After reconnect')
    const work = await runtime.work.listRuntimeWork()
    work.chats[0].tasks[0].running = false
    let resolveRefresh!: (value: typeof work) => void
    vi.mocked(runtime.work.listRuntimeWork).mockImplementation(
      () =>
        new Promise(resolve => {
          resolveRefresh = resolve
        })
    )
    await act(async () => handlers.onHistoryInvalidated?.())
    expect(client.send).not.toHaveBeenCalled()
    await act(async () => resolveRefresh(work))
    expect(client.send).toHaveBeenCalledOnce()
  })
  it('preserves pending replies across drawer unmount and permits cancel without saving or executing', async () => {
    await mount()
    await send('Still pending')
    await mount(false)
    await mount()
    expect(container.textContent).toContain('Still pending')
    const cancel = container.querySelector<HTMLElement>('[data-testid^="queue-cancel-button-"]')!
    await act(async () => cancel.click())
    expect(container.querySelector('[data-testid="conversation-queue-panel"]')).toBeNull()
    expect(client.send).not.toHaveBeenCalled()
    expect(runtime.work.sendRuntimeMessage).not.toHaveBeenCalled()
  })
  it('preserves the runtime attachment IDs when importing files into the reply comment', async () => {
    await mount()
    const fileInput = container.querySelector<HTMLInputElement>('input[type=file]')!
    Object.defineProperty(fileInput, 'files', { value: [new File(['a'], 'notes.txt')] })
    await act(async () => fileInput.dispatchEvent(new Event('change', { bubbles: true })))
    await send('Read this')
    await act(async () => handlers.onAssistantSettled?.('turn-1', 'succeeded'))
    expect(api.attachments.importContexts).toHaveBeenCalledWith('issue-1', [21])
    expect(runtime.work.sendRuntimeMessage).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentIds: [21] })
    )
    expect(client.send).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Read this\n\n[notes.txt](wegent://attachments/issue-attachment)',
      })
    )
  })
})
