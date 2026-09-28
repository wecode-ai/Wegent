// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps, ContextType } from 'react'
import { BrowserTaskDraftContext, createDraftOperations } from './browserTaskDraftContext'
import { BrowserIssueActivityTools } from './BrowserIssueActivityTools'
import { BrowserIssueExecution } from './BrowserIssueExecution'
import { createCollaborationTranslator } from '../i18n'
import type { CollaborationIssue, CollaborationProject } from '../types'
import type { SharedWorkspaceRuntimeApi } from '../ports/SharedWorkspaceApi'
import { startTaskAiRun } from '../execution/taskAiExecution'

vi.mock('../execution/taskAiExecution', async importOriginal => ({
  ...(await importOriginal<typeof import('../execution/taskAiExecution')>()),
  startTaskAiRun: vi.fn().mockResolvedValue(undefined),
}))

describe('Web adapter for the PC activity tools', () => {
  let root: Root
  let container: HTMLDivElement
  let props: ComponentProps<typeof BrowserIssueActivityTools>
  const issue = {
    id: 'issue-1',
    cloud_project_id: 'project-1',
    version: 7,
    status: 'in_progress',
    execution_state: 'waiting_approval',
    assignee_agent_id: 'agent-1',
  } as CollaborationIssue
  beforeEach(() => {
    vi.mocked(startTaskAiRun).mockClear()
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    props = {
      api: {
        issues: {
          approveRun: vi.fn().mockResolvedValue({ ...issue, version: 8 }),
          rejectRun: vi.fn().mockResolvedValue({ ...issue, version: 8 }),
          update: vi.fn().mockResolvedValue({ ...issue, status: 'completed', version: 8 }),
        },
      } as ComponentProps<typeof BrowserIssueActivityTools>['api'],
      issue,
      project: {
        id: 'project-1',
        name: 'Project',
        project_store: 'backend',
      } as CollaborationProject,
      agents: [
        {
          id: 'agent-1',
          name: 'Engineer',
          status: 'active',
          createdByUserId: 4,
          createdByUserName: 'Owner',
        },
      ],
      currentUserId: '4',
      messages: [],
      onMessages: vi.fn(),
      onTaskUpdated: vi.fn(),
      translate: createCollaborationTranslator('zh-CN'),
    }
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })
  const button = (action: string) =>
    container.querySelector<HTMLButtonElement>(
      `[data-testid="cloud-task-activity-${action}-${props.issue.id}"]`
    )
  async function mount() {
    await act(async () =>
      root.render(<BrowserIssueActivityTools key={props.issue.id} {...props} />)
    )
  }

  it('approves the owning project and current version, coalesces clicks and displays retryable failure', async () => {
    let reject!: (reason: Error) => void
    vi.mocked(props.api.issues.approveRun).mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail
        })
    )
    await mount()
    await act(async () => {
      button('approve')!.click()
      button('approve')!.click()
    })
    expect(props.api.issues.approveRun).toHaveBeenCalledTimes(1)
    expect(props.api.issues.approveRun).toHaveBeenCalledWith('project-1', 'issue-1', 7)
    expect(button('approve')!.disabled).toBe(true)
    await act(async () => reject(new Error('version conflict')))
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('version conflict')
    expect(button('approve')!.disabled).toBe(false)
    await act(async () => button('approve')!.click())
    expect(props.onTaskUpdated).toHaveBeenCalledWith(expect.objectContaining({ version: 8 }))
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('requires an identified creator or explicit backend approval capability', async () => {
    props.currentUserId = undefined
    props.agents[0].createdByUserId = undefined
    await mount()
    expect(button('approve')).toBeNull()
    expect(button('execution-status')?.getAttribute('aria-label')).toBe('待 Owner 批准')
    props.issue = { ...issue, can_approve: true }
    await mount()
    expect(button('approve')).not.toBeNull()
  })

  it('treats prompt cancellation as no action and sends the trimmed rejection reason', async () => {
    const prompt = vi
      .spyOn(window, 'prompt')
      .mockReturnValueOnce(null)
      .mockReturnValueOnce('  missing evidence  ')
    await mount()
    await act(async () => button('reject')!.click())
    expect(props.api.issues.rejectRun).not.toHaveBeenCalled()
    await act(async () => button('reject')!.click())
    expect(props.api.issues.rejectRun).toHaveBeenCalledWith(
      'project-1',
      'issue-1',
      7,
      'missing evidence'
    )
    expect(prompt).toHaveBeenCalledTimes(2)
  })

  it('accepts the Issue without inventing another run and ignores a late response after switching Issues', async () => {
    let finish!: (issue: CollaborationIssue) => void
    vi.mocked(props.api.issues.update).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    props.issue = { ...issue, status: 'in_review' }
    await mount()
    await act(async () => button('accept')!.click())
    expect(props.api.issues.update).toHaveBeenCalledWith('issue-1', {
      version: 7,
      status: 'completed',
    })
    props.issue = { ...issue, id: 'issue-2' }
    await mount()
    await act(async () => finish({ ...issue, status: 'completed' }))
    expect(props.onTaskUpdated).not.toHaveBeenCalled()
  })

  it('uses the shared rerun pipeline and last requested model', async () => {
    const model = { name: 'original-model', type: 'public' as const, config: {} }
    const runtime = {
      listDevices: vi.fn().mockResolvedValue([
        {
          device_id: 'device-1',
          status: 'online',
          device_type: 'local',
          executor_version: '1.9.0',
          is_default: true,
        },
      ]),
      work: { listRuntimeWork: vi.fn().mockResolvedValue({ projects: [], chats: [] }) },
      listModels: vi.fn().mockResolvedValue([model]),
    } as unknown as SharedWorkspaceRuntimeApi
    props.issue = { ...issue, execution_state: 'failed' }
    props.messages = [
      { messageId: 'request-1', sender: { type: 'user' }, metadata: { model: model.name } },
    ] as typeof props.messages
    props.api = { ...props.api, runtime, activity: {} as never, taskBindings: {} as never }
    await act(async () =>
      root.render(
        <BrowserIssueExecution runtime={runtime}>
          <BrowserIssueActivityTools {...props} />
        </BrowserIssueExecution>
      )
    )
    await act(async () => button('rerun')!.click())
    expect(startTaskAiRun).toHaveBeenCalledWith(
      expect.objectContaining({
        project: props.project,
        task: props.issue,
        agent: props.agents[0],
        executionProject: null,
        selectedModel: model,
        selectedModelOptions: {},
      })
    )
    expect(runtime.listModels).toHaveBeenCalledWith('device-1')
    const input = vi.mocked(startTaskAiRun).mock.calls[0][0]
    await act(async () => input.onError('execution failed after dispatch'))
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'execution failed after dispatch'
    )
  })

  it('shares the main composer operation lock and preserves its draft', async () => {
    const scope = 'issue:project-1:issue-1'
    const operations = createDraftOperations()
    operations.begin(scope)
    const context = {
      operations,
      drafts: { [scope]: { busy: true, text: 'Keep my comment' } },
      update: vi.fn(),
    } as unknown as NonNullable<ContextType<typeof BrowserTaskDraftContext>>
    await act(async () =>
      root.render(
        <BrowserTaskDraftContext.Provider value={context}>
          <BrowserIssueActivityTools {...props} />
        </BrowserTaskDraftContext.Provider>
      )
    )
    expect(button('approve')?.disabled).toBe(true)
    await act(async () => button('approve')!.click())
    expect(props.api.issues.approveRun).not.toHaveBeenCalled()
    operations.end(scope)
    context.drafts[scope].busy = false
    await act(async () =>
      root.render(
        <BrowserTaskDraftContext.Provider value={{ ...context }}>
          <BrowserIssueActivityTools {...props} />
        </BrowserTaskDraftContext.Provider>
      )
    )
    await act(async () => button('approve')!.click())
    expect(props.api.issues.approveRun).toHaveBeenCalledTimes(1)
    expect(context.drafts[scope].text).toBe('Keep my comment')
    expect(operations.begin(scope)).toBe(true)
  })
})
