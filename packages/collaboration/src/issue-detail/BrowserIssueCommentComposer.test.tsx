import { BrowserIssueExecution } from './BrowserIssueExecution'
// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectChatClient, ProjectChatMessage } from '@wegent/chat-core'
import type { SharedWorkspaceApi, SharedWorkspaceRuntimeApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationIssue, CollaborationProject } from '../types'
import { createCollaborationTranslator } from '../i18n'
import { BrowserTaskDrafts } from './BrowserTaskDrafts'
import { BrowserIssueCommentComposer } from './BrowserIssueCommentComposer'

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
  cloud_project_id: project.id,
  title: 'Check directory',
  status: 'in_progress',
  assignee_agent_id: 'agent-1',
} as CollaborationIssue
const agent = {
  id: 'agent-1',
  name: 'Engineer',
  status: 'active',
  systemPrompt: 'Inspect the workspace',
}
const model = {
  name: 'my-model',
  type: 'user' as const,
  provider: 'cloud',
  namespace: 'team',
  resourceUserId: 7,
  config: { protocol: 'openai-responses' },
}
const attachment = {
  id: 14,
  filename: 'notes.txt',
  file_size: 4,
  file_extension: 'txt',
  mime_type: 'text/plain',
  status: 'ready' as const,
  created_at: '',
}
const message = {
  messageId: 'root-comment',
  projectId: project.id,
  taskId: issue.id,
  sequenceNumber: 1,
  content: 'Run pwd',
  sender: { type: 'user', id: '1', name: 'User' },
  status: 'completed',
  metadata: {},
} as ProjectChatMessage

describe('browser main comment with the PC execution pipeline', () => {
  let root: Root
  let container: HTMLDivElement
  let runtime: SharedWorkspaceRuntimeApi
  let api: Pick<SharedWorkspaceApi, 'issues' | 'attachments' | 'taskBindings'>
  let client: ProjectChatClient
  const onMessages = vi.fn()
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }))
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      }
    )
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    runtime = {
      executeCommand: vi.fn(),
      fileChangesFromError: () => undefined,
      listDevices: vi.fn().mockResolvedValue([
        {
          id: 1,
          device_id: 'device-1',
          device_type: 'local',
          name: 'Laptop',
          status: 'online',
          is_default: true,
          executor_version: '1.9.0',
        },
      ]),
      listModels: vi.fn().mockResolvedValue([model]),
      subscribeChatStream: vi.fn().mockResolvedValue(() => {}),
      work: {
        listRuntimeWork: vi.fn().mockResolvedValue({
          projects: [
            {
              project: { key: 'repo', name: 'Repository', stateDeviceId: 'device-1' },
              deviceWorkspaces: [
                {
                  deviceId: 'device-1',
                  workspacePath: '/repo',
                  deviceStatus: 'online',
                  available: true,
                  tasks: [],
                },
              ],
            },
          ],
          chats: [],
          totalTasks: 0,
        }),
        createRuntimeTask: vi
          .fn()
          .mockImplementation(async input => ({ accepted: true, ...input })),
        sendRuntimeMessage: vi.fn(),
        guideRuntimeTask: vi.fn(),
        interruptAndSendRuntimeMessage: vi.fn(),
        cancelRuntimeTask: vi.fn(),
        revertRuntimeFileChanges: vi.fn(),
        getRuntimeGoal: vi.fn().mockResolvedValue({ accepted: true, taskId: 'task-1', goal: null }),
      },
      uploadAttachment: vi.fn().mockResolvedValue(attachment),
      deleteAttachment: vi.fn(),
      readAttachment: vi.fn(),
      readWorkspaceFile: vi.fn(),
      openModelSettings: vi.fn(),
      getTranscript: vi.fn(),
      subscribe: vi.fn(),
      cancel: vi.fn(),
      dispose: vi.fn(),
    }
    api = {
      issues: { get: vi.fn().mockResolvedValue(issue) } as unknown as SharedWorkspaceApi['issues'],
      taskBindings: {
        list: vi.fn(),
        bindTask: vi.fn().mockResolvedValue(undefined),
        unbindTask: vi.fn().mockResolvedValue(undefined),
      },
      attachments: {
        importContexts: vi.fn().mockResolvedValue([
          {
            id: 'issue-file-14',
            display_name: 'notes.txt',
            markdown_url: 'wegent://attachments/issue-file-14',
          },
        ]),
      } as unknown as SharedWorkspaceApi['attachments'],
    }
    client = {
      send: vi.fn().mockResolvedValue(message),
      startAgentResponse: vi
        .fn()
        .mockResolvedValue({ ...message, messageId: 'response', status: 'streaming' }),
      failAgentResponse: vi
        .fn()
        .mockResolvedValue({ ...message, messageId: 'response', status: 'failed' }),
    } as unknown as ProjectChatClient
    onMessages.mockClear()
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })
  const element = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!
  const input = () => element('collaboration-issue-comment') as HTMLTextAreaElement
  async function mount(
    members: {
      id: number
      user_id: number
      user_name: string
      email: null
      role: 'Developer'
    }[] = [],
    agents = [agent]
  ) {
    await act(async () =>
      root.render(
        <BrowserTaskDrafts runtime={runtime}>
          <BrowserIssueExecution runtime={runtime}>
            <BrowserIssueCommentComposer
              api={api}
              runtime={runtime}
              client={client}
              project={project}
              issue={issue}
              agents={agents}
              members={members}
              messages={[]}
              canComment
              canAttach
              loading={false}
              translate={createCollaborationTranslator('en')}
              onMessages={onMessages}
            />
          </BrowserIssueExecution>
        </BrowserTaskDrafts>
      )
    )
  }
  async function type(text: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'setSelectionRange'
      )!.value!.call(input(), text.length, text.length)
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        input(),
        text
      )
      input().dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  async function click(id: string) {
    await act(async () => element(id).click())
  }
  it('executes an assigned hidden agent without requiring the members own runtime catalog', async () => {
    client.executeTaskComment = vi.fn().mockResolvedValue([message])
    vi.mocked(runtime.listDevices).mockResolvedValue([])
    vi.mocked(runtime.listModels).mockResolvedValue([])
    await mount([], [])
    await type('Run pwd')
    await click('collaboration-issue-comment-submit')
    expect(client.executeTaskComment).toHaveBeenCalledWith({
      projectId: project.id,
      taskId: issue.id,
      triggerMessageId: message.messageId,
      attachmentIds: [],
    })
    expect(runtime.work.createRuntimeTask).not.toHaveBeenCalled()
    expect(client.startAgentResponse).not.toHaveBeenCalled()
    expect(input().value).toBe('')
    expect(element('collaboration-comment-settings-toggle')).toBeNull()
  })

  it('renders PC controls and launches the explicitly selected project with the complete model identity', async () => {
    await mount()
    await type('Run pwd')
    await click('collaboration-comment-settings-toggle')
    expect(element('permission-mode-menu-button')).not.toBeNull()
    await click('project-work-button')
    const option = document.querySelector<HTMLElement>('[data-testid^="project-option-"]')!
    await act(async () => option.click())
    await click('collaboration-issue-comment-submit')
    expect(client.send).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Run pwd',
        mentions: [{ type: 'agent', id: agent.id, label: agent.name }],
      })
    )
    expect(runtime.work.createRuntimeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'device-1',
        workspacePath: '/repo',
        runtimeProjectKey: 'repo',
        modelSelection: expect.objectContaining({
          modelName: 'my-model',
          options: expect.objectContaining({
            weworkCloudModelNamespace: 'team',
            weworkCloudModelResourceUserId: '7',
          }),
        }),
      })
    )
    expect(runtime.work.sendRuntimeMessage).not.toHaveBeenCalled()
    expect(input().value).toBe('')
  })
  it('sends the structured target for a project member mention', async () => {
    await mount([
      { id: 3, user_id: 8, user_name: 'bob', email: null, role: 'Developer' },
    ])
    await type('@')
    const option = element('collaboration-issue-mention-member-8')
    expect(option).not.toBeNull()
    await act(async () => option.click())
    expect(input().value).toBe('@bob ')
    await type('@bob please review')
    await click('collaboration-issue-comment-submit')
    expect(client.send).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '@bob please review',
        mentions: [
          { type: 'agent', id: agent.id, label: agent.name },
          { type: 'user', id: '8', label: 'bob' },
        ],
      })
    )
  })
  it('uses actual uploaded runtime IDs and imports them for durable Issue links', async () => {
    await mount()
    await type('Read notes')
    const fileInput = element('collaboration-comment-attach-input') as HTMLInputElement
    Object.defineProperty(fileInput, 'files', { value: [new File(['data'], 'notes.txt')] })
    await act(async () => fileInput.dispatchEvent(new Event('change', { bubbles: true })))
    await click('collaboration-issue-comment-submit')
    expect(api.attachments.importContexts).toHaveBeenCalledWith(issue.id, [14])
    expect(client.send).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Read notes\n\n[notes.txt](wegent://attachments/issue-file-14)',
      })
    )
    expect(runtime.work.createRuntimeTask).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentIds: [14], attachments: [] })
    )
  })
  it('retains the draft if comment persistence fails and never dispatches execution', async () => {
    vi.mocked(client.send).mockRejectedValueOnce(new Error('Comment save failed'))
    await mount()
    await type('Keep my draft')
    await click('collaboration-issue-comment-submit')
    expect(input().value).toBe('Keep my draft')
    expect(container.textContent).toContain('Comment save failed')
    expect(runtime.work.createRuntimeTask).not.toHaveBeenCalled()
  })
  it('closes a rejected execution without duplicating the persisted comment', async () => {
    vi.mocked(runtime.work.createRuntimeTask).mockResolvedValueOnce({
      accepted: false,
      error: 'Device went offline',
    } as never)
    await mount()
    await type('Run pwd')
    await click('collaboration-issue-comment-submit')
    expect(input().value).toBe('')
    expect(container.textContent).toContain('Device went offline')
    expect(client.send).toHaveBeenCalledOnce()
    expect(client.failAgentResponse).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Device went offline' })
    )
    expect(api.taskBindings.unbindTask).toHaveBeenCalledOnce()
  })
})
