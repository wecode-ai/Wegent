import { activityDisplayBody } from './activityDisplayBody'
import { issueActivityEntries } from './issueActivityEntries'
// @vitest-environment jsdom

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, useState } from 'react'
import { createCollaborationTranslator } from '../i18n'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type {
  CollaborationAgent,
  CollaborationAssignment,
  CollaborationComment,
  CollaborationExecution,
  CollaborationIssue,
  CollaborationMember,
} from '../types'
import { IssueActivityPanel } from './IssueActivityPanel'
import type { ProjectChatMessage } from '@wegent/chat-core'
import type { SharedWorkspaceRuntimeApi } from '../ports/SharedWorkspaceApi'
import { RuntimeConversationScope } from '../conversation/RuntimeConversationScope'
import { IssueExecutionDetails } from './IssueExecutionDetails'
import type { RuntimeExecutionTarget } from './runtimeExecutionTarget'
import type { RuntimeConversationHandlers } from '@wegent/chat-core/runtime-conversation-client'

const issue = {
  id: 'issue-1',
  cloud_project_id: 'project-1',
  sequence_number: 1,
  parent_id: null,
  created_by_user_id: 1,
  assignee_user_id: null,
  title: 'Issue one',
  description: '',
  status: 'inbox',
  priority: 'none',
  due_at: null,
  tags: [],
  sort_order: 0,
  version: 1,
  created_at: '2026-09-11T00:00:00Z',
  updated_at: '2026-09-11T00:00:00Z',
  completed_at: null,
} satisfies CollaborationIssue

describe('IssueActivityPanel', () => {
  let container: HTMLDivElement
  let root: Root

  it('uses only the current Issue chat stream instead of adding REST records to the PC feed', async () => {
    const messages: ProjectChatMessage[] = Array.from({ length: 7 }, (_, index) => ({
      messageId: 'chat-' + index,
      projectId: issue.cloud_project_id,
      taskId: issue.id,
      sequenceNumber: index + 1,
      sender: { type: 'user', id: '1', name: 'admin' },
      type: 'text',
      content: 'PC message ' + index,
      status: 'completed',
      metadata: {},
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
    }))
    let receive!: (message: ProjectChatMessage) => void
    const api = {
      comments: { create: vi.fn() },
      activity: {
        subscribe: vi.fn(async (_project, _issue, _sequence, onMessage) => {
          receive = onMessage
          return {
            snapshot: {
              messages: [
                ...messages,
                {
                  ...messages[0],
                  messageId: 'other',
                  taskId: 'other-issue',
                  content: 'Other Issue',
                },
              ],
            },
            unsubscribe: vi.fn(),
          }
        }),
      },
    } as unknown as Parameters<typeof IssueActivityPanel>[0]['api']
    await act(async () =>
      root.render(
        <IssueActivityPanel
          api={api}
          issue={issue}
          members={[]}
          agents={[]}
          assignments={[]}
          comments={Array.from(
            { length: 5 },
            (_, index) =>
              ({
                id: 'rest-' + index,
                body: 'probe',
                created_at: issue.created_at,
              }) as CollaborationComment
          )}
          executions={[]}
          canComment={false}
          translate={createCollaborationTranslator('zh-CN')}
          onCommentsChange={vi.fn()}
          onError={vi.fn()}
        />
      )
    )
    expect(container.textContent).toContain('共 7 条')
    expect(container.textContent).not.toContain('probe')
    expect(container.textContent).not.toContain('Other Issue')
    await act(async () =>
      receive({
        ...messages[0],
        messageId: 'live-other',
        taskId: 'other-issue',
        content: 'Other live Issue',
      })
    )
    expect(container.textContent).toContain('共 7 条')
    expect(container.textContent).not.toContain('Other live Issue')
    await act(async () =>
      receive({
        ...messages[0],
        messageId: 'live-current',
        sequenceNumber: 8,
        content: 'New current message',
      })
    )
    expect(container.textContent).toContain('共 8 条')
    expect(container.textContent).toContain('New current message')
  })

  it('updates the actual activity badge and viewer from one execution subscription', async () => {
    const message: ProjectChatMessage = {
      messageId: 'running-message',
      projectId: 'project-1',
      taskId: issue.id,
      sequenceNumber: 1,
      sender: { type: 'agent', id: 'agent', name: 'Codex' },
      type: 'text',
      content: 'Working',
      status: 'streaming',
      metadata: { run_status: 'running' },
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      runtimeAddress: { deviceId: 'actual-device', taskId: 'runtime-task' },
    }
    let handlers: RuntimeConversationHandlers | undefined
    const unsubscribe = vi.fn()
    const runtime = {
      getTranscript: vi.fn().mockResolvedValue({
        runtime: 'codex',
        running: true,
        rangeStart: 0,
        rangeEnd: 1,
        messages: [],
        turns: [{ id: 'original-turn', status: 'streaming', items: [] }],
      }),
      subscribe: vi.fn(async (_address, incoming) => {
        handlers = incoming
        return unsubscribe
      }),
      work: {
        listRuntimeWork: vi.fn().mockResolvedValue({ projects: [], chats: [] }),
      },
      cancel: vi.fn(),
      readWorkspaceFile: vi.fn(),
      readAttachment: vi.fn(),
    } as unknown as SharedWorkspaceRuntimeApi
    const api = {
      comments: { create: vi.fn() },
      runtime,
      activity: {
        subscribe: vi.fn().mockResolvedValue({
          snapshot: { messages: [message] },
          unsubscribe: vi.fn(),
        }),
      },
    } as unknown as Parameters<typeof IssueActivityPanel>[0]['api']
    const translate = createCollaborationTranslator('zh-CN')
    function Harness() {
      const [target, setTarget] = useState<RuntimeExecutionTarget | null>(null)
      return (
        <RuntimeConversationScope runtime={runtime}>
          <IssueActivityPanel
            api={api}
            issue={issue}
            members={[]}
            agents={[]}
            assignments={[]}
            comments={[]}
            executions={[]}
            canComment={false}
            translate={translate}
            onOpenExecution={setTarget}
            onCommentsChange={vi.fn()}
            onError={vi.fn()}
          />
          {target && (
            <IssueExecutionDetails
              target={target}
              runtime={runtime}
              translate={translate}
              onClose={() => setTarget(null)}
            />
          )}
        </RuntimeConversationScope>
      )
    }
    await act(async () => root.render(<Harness />))
    const badge = container.querySelector<HTMLButtonElement>(
      '[data-testid="cloud-task-activity-execution-badge-running-message"]'
    )!
    expect(badge.getAttribute('data-status')).toBe('running')
    expect(runtime.getTranscript).not.toHaveBeenCalled()
    await act(async () => badge.click())
    expect(
      document.querySelector('[data-testid="runtime-execution-detail-status"]')?.textContent
    ).toContain('执行中')
    expect(runtime.subscribe).toHaveBeenCalledTimes(1)
    await act(async () =>
      (
        document.querySelector(
          '[data-testid="runtime-execution-detail-close"]'
        ) as HTMLButtonElement
      ).click()
    )
    expect(unsubscribe).not.toHaveBeenCalled()
    await act(async () =>
      handlers?.onMessageAction?.({
        type: 'assistant_done',
        subtaskId: 'original-turn',
        itemId: 'answer',
        content: 'Done',
      })
    )
    expect(badge.getAttribute('data-status')).toBe('succeeded')
    await act(async () =>
      handlers?.onMessageAction?.({
        type: 'assistant_started',
        subtaskId: 'next-turn',
      })
    )
    expect(badge.getAttribute('data-status')).toBe('succeeded')
    vi.mocked(runtime.getTranscript).mockRejectedValueOnce(new Error('device offline'))
    await act(async () => badge.click())
    expect(
      document.querySelector('[data-testid="runtime-execution-detail-status"]')?.textContent
    ).toContain('执行成功')
    expect(message.metadata.run_status).toBe('running')
    expect(runtime.subscribe).toHaveBeenCalledTimes(1)
  })

  it('stops the displayed runtime task and shows a recoverable stop failure', async () => {
    const message: ProjectChatMessage = {
      messageId: 'running-message',
      projectId: 'project-1',
      taskId: issue.id,
      sequenceNumber: 1,
      sender: { type: 'agent', id: 'agent', name: 'Codex' },
      type: 'text',
      content: 'Working',
      status: 'streaming',
      metadata: {},
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      runtimeAddress: { deviceId: 'actual-device', taskId: 'runtime-task' },
    }
    const cancel = vi
      .fn()
      .mockRejectedValueOnce(new Error('executor offline'))
      .mockResolvedValue(undefined)
    const api = {
      comments: { create: vi.fn() },
      activity: {
        subscribe: vi.fn().mockResolvedValue({
          snapshot: { messages: [message] },
          unsubscribe: vi.fn(),
        }),
      },
      runtime: { cancel } as unknown as SharedWorkspaceRuntimeApi,
    } as unknown as Parameters<typeof IssueActivityPanel>[0]['api']
    await act(async () =>
      root.render(
        <IssueActivityPanel
          api={api}
          issue={issue}
          members={[]}
          agents={[]}
          assignments={[]}
          comments={[]}
          executions={[]}
          canComment={false}
          translate={createCollaborationTranslator('zh-CN')}
          onCommentsChange={vi.fn()}
          onError={vi.fn()}
          onOpenExecution={vi.fn()}
        />
      )
    )
    const stop = container.querySelector<HTMLButtonElement>(
      '[data-testid="cloud-task-activity-stop-running-message"]'
    )!
    expect(stop).not.toBeNull()
    await act(async () => stop.click())
    expect(cancel).toHaveBeenCalledWith({
      deviceId: 'actual-device',
      taskId: 'runtime-task',
    })
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('executor offline')
    expect(stop.disabled).toBe(false)
    await act(async () => stop.click())
    expect(cancel).toHaveBeenCalledTimes(2)
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

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
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('identifies a successful manager run without claiming the Issue completed', () => {
    render(issue, {
      executions: [
        {
          id: 626,
          loop_item_id: issue.id,
          cloud_project_id: issue.cloud_project_id,
          task_title: 'Issue 智能调度',
          executor_type: 'automation_manager',
          display_state: 'succeeded',
          created_at: '2026-09-14T10:24:48Z',
        } as CollaborationExecution,
      ],
    })
    const event = container.querySelector('[data-testid="collaboration-run-626"]')!
    expect(event.querySelector('header')?.textContent?.includes('AI 调度')).toBe(true)
    expect(event.textContent).toContain('已完成')
    expect(event.textContent).toContain('步骤执行与整个 Issue 的完成状态请查看上方进度')
    expect(event.textContent).not.toContain('succeeded')
  })

  function render(
    targetIssue: CollaborationIssue,
    options: {
      assignments?: CollaborationAssignment[]
      executions?: CollaborationExecution[]
      comments?: CollaborationComment[]
      api?: Pick<SharedWorkspaceApi, 'assignments' | 'comments'>
      onAssignmentsChange?: ReturnType<typeof vi.fn>
      onCommentsChange?: ReturnType<typeof vi.fn>
      onError?: ReturnType<typeof vi.fn>
      canComment?: boolean
      canAssign?: boolean
      members?: CollaborationMember[]
      agents?: CollaborationAgent[]
    } = {}
  ) {
    const api =
      options.api ??
      ({
        assignments: { create: vi.fn() },
        comments: { create: vi.fn() },
      } as unknown as Pick<SharedWorkspaceApi, 'assignments' | 'comments'>)
    const onAssignmentsChange = options.onAssignmentsChange ?? vi.fn()
    const onCommentsChange = options.onCommentsChange ?? vi.fn()
    act(() => {
      root.render(
        <IssueActivityPanel
          api={api}
          issue={targetIssue}
          members={
            options.members ?? [
              {
                id: 1,
                user_id: 7,
                user_name: '李明',
                email: null,
                role: 'Developer',
              },
            ]
          }
          agents={options.agents ?? []}
          assignments={options.assignments ?? []}
          comments={options.comments ?? []}
          executions={options.executions ?? []}
          canComment={options.canComment ?? true}
          translate={createCollaborationTranslator('zh-CN')}
          onCommentsChange={onCommentsChange}
          onError={options.onError ?? vi.fn()}
        />
      )
    })
    return { api, onAssignmentsChange, onCommentsChange }
  }

  function change(testId: string, value: string) {
    const target = container.querySelector<HTMLElement>(`[data-testid="${testId}"]`) as
      | HTMLInputElement
      | HTMLSelectElement
      | HTMLTextAreaElement
    const prototype =
      target instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : target instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(target, value)
    act(() => {
      target.dispatchEvent(new Event('change', { bubbles: true }))
      target.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  function typeMentionTrigger() {
    const input = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="collaboration-issue-comment"]'
    )!
    const start = input.selectionStart
    const end = input.selectionEnd
    const value = `${input.value.slice(0, start)}@${input.value.slice(end)}`
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        input,
        value
      )
      input.setSelectionRange(start + 1, start + 1)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  async function click(testId: string) {
    const target = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)
    expect(target).toBeTruthy()
    await act(async () => {
      target?.click()
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it('keeps one comment composer and clears it when the issue changes', () => {
    render(issue)
    change('collaboration-issue-comment', '正在处理')

    render({ ...issue, id: 'issue-2', sequence_number: 2 })

    expect(
      (
        container.querySelector(
          '[data-testid="collaboration-issue-comment"]'
        ) as HTMLTextAreaElement
      ).value
    ).toBe('')
    expect(container.querySelector('[data-testid="collaboration-assignment-target"]')).toBeNull()
    expect(
      container.querySelector('[data-testid="collaboration-assignment-workflow-step"]')
    ).toBeNull()
    expect(container.querySelectorAll('textarea')).toHaveLength(1)
  })

  it('preserves the comment draft across focus changes', () => {
    render(issue)

    const textarea = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="collaboration-issue-comment"]'
    )

    act(() => textarea?.focus())

    act(() => textarea?.blur())

    act(() => textarea?.focus())
    change('collaboration-issue-comment', '补充上下文')
    act(() => textarea?.blur())
    expect(textarea?.value).toBe('补充上下文')
  })

  it('inserts a selected mention into the shared comment body', async () => {
    render(issue)

    typeMentionTrigger()
    expect(
      container.querySelector('[data-testid="collaboration-issue-mention-popup"]')
    ).toBeTruthy()
    await click('collaboration-issue-mention-member-7')

    expect(
      (
        container.querySelector(
          '[data-testid="collaboration-issue-comment"]'
        ) as HTMLTextAreaElement
      ).value
    ).toBe('@李明 ')
    expect(
      container.querySelector('[data-testid="collaboration-issue-assignment-preview"]')
    ).toBeNull()
    expect(
      container
        .querySelector('[data-testid="collaboration-issue-comment-submit"]')
        ?.getAttribute('aria-label')
    ).toBe('发送消息')
  })

  it('confirms the active mention with Enter instead of submitting the comment', async () => {
    const api = {
      assignments: { create: vi.fn() },
      comments: { create: vi.fn() },
    } as unknown as Pick<SharedWorkspaceApi, 'assignments' | 'comments'>
    render(issue, { api })

    typeMentionTrigger()
    const textarea = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="collaboration-issue-comment"]'
    )!
    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        })
      )
      await Promise.resolve()
    })

    expect(textarea.value).toBe('@李明 ')
    expect(api.comments.create).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="collaboration-issue-mention-popup"]')).toBeNull()
  })

  it('uses arrow keys to choose a mention before confirming it with Enter', async () => {
    render(issue, {
      members: [
        {
          id: 1,
          user_id: 7,
          user_name: '李明',
          email: null,
          role: 'Developer',
        },
        {
          id: 2,
          user_id: 8,
          user_name: '王芳',
          email: null,
          role: 'Developer',
        },
      ],
    })

    typeMentionTrigger()
    const textarea = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="collaboration-issue-comment"]'
    )!
    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowDown',
          bubbles: true,
          cancelable: true,
        })
      )
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        })
      )
      await Promise.resolve()
    })

    expect(textarea.value).toBe('@王芳 ')
  })

  it('places the caret after a mention before the next input can arrive', async () => {
    render(issue)
    change('collaboration-issue-comment', 'Keep this suffix')
    const textarea = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="collaboration-issue-comment"]'
    )!
    textarea.setSelectionRange(0, 0)
    typeMentionTrigger()
    await click('collaboration-issue-mention-member-7')
    expect(textarea.value).toBe('@李明 Keep this suffix')
    expect(document.activeElement).toBe(textarea)
    expect(textarea.selectionStart).toBe(4)
    expect(textarea.selectionEnd).toBe(4)
  })

  it('replaces the typed mention trigger instead of inserting a second at sign', async () => {
    render(issue)

    change('collaboration-issue-comment', '@')
    await click('collaboration-issue-mention-member-7')

    expect(
      (
        container.querySelector(
          '[data-testid="collaboration-issue-comment"]'
        ) as HTMLTextAreaElement
      ).value
    ).toBe('@李明 ')
  })

  it('inserts the exact selected collaborator when names share a prefix', async () => {
    const prefixMember = {
      id: 2,
      user_id: 8,
      user_name: '李',
      email: null,
      role: 'Developer',
    } satisfies CollaborationMember
    render(issue, {
      members: [
        prefixMember,
        {
          id: 1,
          user_id: 7,
          user_name: '李明',
          email: null,
          role: 'Developer',
        },
      ],
    })

    typeMentionTrigger()
    await click('collaboration-issue-mention-member-7')

    expect(
      (
        container.querySelector(
          '[data-testid="collaboration-issue-comment"]'
        ) as HTMLTextAreaElement
      ).value
    ).toBe('@李明 ')
  })

  it('keeps mention insertion independent from assignment', async () => {
    render(issue)

    typeMentionTrigger()
    await click('collaboration-issue-mention-member-7')
    expect(
      (
        container.querySelector(
          '[data-testid="collaboration-issue-comment"]'
        ) as HTMLTextAreaElement
      ).value
    ).toBe('@李明 ')
    expect(
      container.querySelector('[data-testid="collaboration-issue-assignment-preview"]')
    ).toBeNull()
    expect(
      container
        .querySelector('[data-testid="collaboration-issue-comment-submit"]')
        ?.getAttribute('aria-label')
    ).toBe('发送消息')
  })

  it('does not infer an assignment from manually typed mention text', () => {
    render(issue, {
      members: [
        {
          id: 2,
          user_id: 8,
          user_name: '李',
          email: null,
          role: 'Developer',
        },
      ],
    })

    change('collaboration-issue-comment', '@李明 看一下')

    expect(
      container.querySelector('[data-testid="collaboration-issue-assignment-preview"]')
    ).toBeNull()
    expect(
      container
        .querySelector('[data-testid="collaboration-issue-comment-submit"]')
        ?.getAttribute('aria-label')
    ).toBe('发送消息')
  })

  it('does not turn an agent mention into an assignment', async () => {
    render(issue, {
      agents: [{ id: 'agent-1', name: '李明' }],
    })

    typeMentionTrigger()
    await click('collaboration-issue-mention-agent-agent-1')

    expect(
      container.querySelector('[data-testid="collaboration-issue-assignment-preview"]')
    ).toBeNull()
  })

  it('submits a plain body through comments.create', async () => {
    const comment = {
      id: 'comment-1',
      issue_id: issue.id,
      author: '李明',
      body: '已确认接口契约',
      created_at: '2026-09-12T00:00:00Z',
    } satisfies CollaborationComment
    const api = {
      assignments: { create: vi.fn() },
      comments: { create: vi.fn().mockResolvedValue(comment) },
    } as unknown as Pick<SharedWorkspaceApi, 'assignments' | 'comments'>
    const { onCommentsChange } = render(issue, { api })

    change('collaboration-issue-comment', comment.body)
    await click('collaboration-issue-comment-submit')

    expect(api.comments.create).toHaveBeenCalledWith(issue.id, comment.body)
    expect(api.assignments?.create).not.toHaveBeenCalled()
    expect(onCommentsChange).toHaveBeenCalledWith([comment])
  })

  it('keeps the composer draft until the pending comment succeeds', async () => {
    let resolveComment: ((comment: CollaborationComment) => void) | undefined
    const pendingComment = new Promise<CollaborationComment>(resolve => {
      resolveComment = resolve
    })
    const comment = {
      id: 'comment-1',
      issue_id: issue.id,
      author: '李明',
      body: '已确认接口契约',
      created_at: '2026-09-12T00:00:00Z',
    } satisfies CollaborationComment
    const api = {
      assignments: { create: vi.fn() },
      comments: { create: vi.fn().mockReturnValue(pendingComment) },
    } as unknown as Pick<SharedWorkspaceApi, 'assignments' | 'comments'>
    render(issue, { api })

    change('collaboration-issue-comment', comment.body)
    const submitButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="collaboration-issue-comment-submit"]'
    )
    act(() => submitButton?.click())

    expect(
      (
        container.querySelector(
          '[data-testid="collaboration-issue-comment"]'
        ) as HTMLTextAreaElement
      ).value
    ).toBe(comment.body)

    await act(async () => {
      resolveComment?.(comment)
      await pendingComment
    })
    expect(
      container.querySelector<HTMLTextAreaElement>('[data-testid="collaboration-issue-comment"]')!
        .value
    ).toBe('')
  })

  it('restores the submitted body when comment creation fails', async () => {
    const onError = vi.fn()
    const api = {
      assignments: { create: vi.fn() },
      comments: {
        create: vi.fn().mockRejectedValue(new Error('request failed')),
      },
    } as unknown as Pick<SharedWorkspaceApi, 'assignments' | 'comments'>
    render(issue, { api, onError })

    change('collaboration-issue-comment', '  保留失败内容  ')
    await click('collaboration-issue-comment-submit')

    expect(
      (
        container.querySelector(
          '[data-testid="collaboration-issue-comment"]'
        ) as HTMLTextAreaElement
      ).value
    ).toBe('  保留失败内容  ')
    expect(onError).toHaveBeenCalledOnce()
  })

  it('does not restore a stale submission after switching issues', async () => {
    let rejectComment: ((error: Error) => void) | undefined
    const pendingComment = new Promise<CollaborationComment>((_resolve, reject) => {
      rejectComment = reject
    })
    const onError = vi.fn()
    const api = {
      assignments: { create: vi.fn() },
      comments: { create: vi.fn().mockReturnValue(pendingComment) },
    } as unknown as Pick<SharedWorkspaceApi, 'assignments' | 'comments'>
    render(issue, { api, onError })

    change('collaboration-issue-comment', '旧 Issue 内容')
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="collaboration-issue-comment-submit"]')
        ?.click()
    })
    render({ ...issue, id: 'issue-2', sequence_number: 2 }, { api, onError })

    await act(async () => {
      rejectComment?.(new Error('request failed'))
      await pendingComment.catch(() => undefined)
    })

    expect(
      (
        container.querySelector(
          '[data-testid="collaboration-issue-comment"]'
        ) as HTMLTextAreaElement
      ).value
    ).toBe('')
    expect(onError).not.toHaveBeenCalled()
  })

  it('does not publish a stale successful submission after switching issues', async () => {
    let resolveComment: ((comment: CollaborationComment) => void) | undefined
    const pendingComment = new Promise<CollaborationComment>(resolve => {
      resolveComment = resolve
    })
    const submittedComment = {
      id: 'comment-old-issue',
      issue_id: issue.id,
      author: '李明',
      body: '旧 Issue 评论',
      created_at: '2026-09-12T00:00:00Z',
    } satisfies CollaborationComment
    const onCommentsChange = vi.fn()
    const api = {
      assignments: { create: vi.fn() },
      comments: { create: vi.fn().mockReturnValue(pendingComment) },
    } as unknown as Pick<SharedWorkspaceApi, 'assignments' | 'comments'>
    render(issue, { api, onCommentsChange })

    change('collaboration-issue-comment', submittedComment.body)
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="collaboration-issue-comment-submit"]')
        ?.click()
    })
    render({ ...issue, id: 'issue-2', sequence_number: 2 }, { api, onCommentsChange })

    await act(async () => {
      resolveComment?.(submittedComment)
      await pendingComment
    })

    expect(onCommentsChange).not.toHaveBeenCalled()
  })

  it('submits a recognized mention as a normal comment', async () => {
    const comment = {
      id: 'comment-1',
      issue_id: issue.id,
      author: '项目经理',
      body: '@李明 请处理登录异常',
      created_at: '2026-09-12T00:00:00Z',
    } satisfies CollaborationComment
    const api = {
      assignments: { create: vi.fn() },
      comments: { create: vi.fn().mockResolvedValue(comment) },
    } as unknown as Pick<SharedWorkspaceApi, 'assignments' | 'comments'>
    const { onAssignmentsChange, onCommentsChange } = render(issue, { api })

    typeMentionTrigger()
    await click('collaboration-issue-mention-member-7')
    change('collaboration-issue-comment', comment.body)
    await click('collaboration-issue-comment-submit')

    expect(api.assignments?.create).not.toHaveBeenCalled()
    expect(api.comments.create).toHaveBeenCalledWith(issue.id, comment.body)
    expect(onAssignmentsChange).not.toHaveBeenCalled()
    expect(onCommentsChange).toHaveBeenCalledWith([comment])
    expect(
      (
        container.querySelector(
          '[data-testid="collaboration-issue-comment"]'
        ) as HTMLTextAreaElement
      ).value
    ).toBe('')
    expect(
      container.querySelector('[data-testid="collaboration-issue-assignment-preview"]')
    ).toBeNull()
    expect(
      container
        .querySelector('[data-testid="collaboration-issue-comment-submit"]')
        ?.getAttribute('aria-label')
    ).toBe('发送消息')
  })

  it('submits a mention of an active assignee as a normal comment', async () => {
    const activeAssignment = {
      id: 'assignment-1',
      issue_id: issue.id,
      target_type: 'human',
      target_id: '7',
      target_name: '李明',
      workflow_step: null,
      body: '',
      comment_id: 'assignment-1',
      created_by_user_id: 1,
      created_by_user_name: '项目经理',
      status: 'active',
      created_at: '2026-09-12T00:00:00Z',
      updated_at: '2026-09-12T00:00:00Z',
    } satisfies CollaborationAssignment
    const body = '@李明 请继续补充验证结果'
    const comment = {
      id: 'comment-2',
      issue_id: issue.id,
      author: '项目经理',
      body,
      created_at: '2026-09-12T00:01:00Z',
    } satisfies CollaborationComment
    const api = {
      assignments: { create: vi.fn() },
      comments: { create: vi.fn().mockResolvedValue(comment) },
    } as unknown as Pick<SharedWorkspaceApi, 'assignments' | 'comments'>
    const { onCommentsChange } = render(issue, {
      api,
      assignments: [activeAssignment],
    })

    typeMentionTrigger()
    await click('collaboration-issue-mention-member-7')
    change('collaboration-issue-comment', body)

    expect(
      container.querySelector('[data-testid="collaboration-issue-assignment-preview"]')
    ).toBeNull()
    expect(
      container
        .querySelector('[data-testid="collaboration-issue-comment-submit"]')
        ?.getAttribute('aria-label')
    ).toBe('发送消息')

    await click('collaboration-issue-comment-submit')

    expect(api.assignments?.create).not.toHaveBeenCalled()
    expect(api.comments.create).toHaveBeenCalledWith(issue.id, body)
    expect(onCommentsChange).toHaveBeenCalledWith([comment])
  })

  it('renders an assignment comment event only once', () => {
    const assignment = {
      id: 'comment-1',
      comment_id: 'comment-1',
      created_at: '2026-09-12T00:00:00Z',
    } as CollaborationAssignment
    const comment = {
      id: 'comment-1',
      created_at: '2026-09-12T00:00:00Z',
    } as CollaborationComment

    expect(issueActivityEntries([assignment], [comment], [])).toEqual([
      {
        kind: 'assignment',
        at: '2026-09-12T00:00:00Z',
        assignment,
      },
    ])
  })

  it('converts internal automation markers into product language', () => {
    expect(activityDisplayBody('CLAUDE_STAGE_PLAN_SUBMITTED', '分配给 @Claude')).toBe(
      '自动化规则已将当前阶段分配给 Claude'
    )
    expect(activityDisplayBody('LOCAL_AUTOMATION_CLAUDE_STAGE_E2E_COMPLETED', '')).toBe(
      'Claude 已完成，Codex 阶段已自动解锁'
    )
    expect(activityDisplayBody('LOCAL_AUTOMATION_CODEX_STAGE_E2E_COMPLETED', '')).toBe(
      'Codex 已完成，所有自动化阶段已完成'
    )
    expect(activityDisplayBody('正常评论', '')).toBe('正常评论')
  })

  it('does not show an execution from before the current assignment', () => {
    const assignment = {
      id: 'assignment-1',
      issue_id: issue.id,
      target_type: 'agent',
      target_id: 'agent-1',
      target_name: 'Codex',
      workflow_step: null,
      body: '',
      comment_id: null,
      created_by_user_id: 1,
      created_by_user_name: '李明',
      status: 'active',
      created_at: '2026-09-12T09:00:00Z',
      updated_at: '2026-09-12T09:00:00Z',
    } satisfies CollaborationAssignment
    const staleExecution = {
      id: 1,
      loop_item_id: issue.id,
      cloud_project_id: issue.cloud_project_id,
      task_title: 'Old run',
      task_status: null,
      task_priority: null,
      executor_type: 'agent',
      agent_id: 'agent-1',
      assigner_user_id: 1,
      executor_owner_user_id: null,
      status: 'completed',
      display_state: '已完成',
      observed_state: 'completed',
      sync_state: 'synced',
      queued_at: null,
      execution_note: null,
      runtime_profile_id: null,
      runtime_source: '旧运行环境',
      can_select_runtime: false,
      waiting_runtime_reason: null,
      version: 1,
      created_at: '2026-09-12T08:00:00Z',
      updated_at: '2026-09-12T08:30:00Z',
    } satisfies CollaborationExecution

    render(issue, {
      assignments: [assignment],
      executions: [staleExecution],
    })

    const current = container.querySelector('[data-testid="collaboration-assignment-assignment-1"]')
    expect(current?.textContent).toContain('Codex')
    expect(current?.textContent).not.toContain('已完成')
    expect(current?.textContent).not.toContain('旧运行环境')
  })

  it('shows why a run failed', () => {
    const assignment = {
      id: 'assignment-1',
      issue_id: issue.id,
      target_type: 'agent',
      target_id: 'agent-1',
      target_name: 'Codex',
      workflow_step: null,
      body: '',
      comment_id: null,
      created_by_user_id: 1,
      created_by_user_name: '李明',
      status: 'active',
      created_at: '2026-09-12T09:00:00Z',
      updated_at: '2026-09-12T09:00:00Z',
    } satisfies CollaborationAssignment
    const failedExecution = {
      id: 2,
      loop_item_id: issue.id,
      cloud_project_id: issue.cloud_project_id,
      task_title: 'Failed run',
      task_status: null,
      task_priority: null,
      executor_type: 'agent',
      agent_id: 'agent-1',
      assigner_user_id: 1,
      executor_owner_user_id: null,
      status: 'failed',
      display_state: 'failed',
      observed_state: 'failed',
      sync_state: 'in_sync',
      queued_at: null,
      error_message:
        'worktree_persistent_storage_unverified: Persistent Worktree storage is not verified',
      execution_note: 'runtime_start_rejected',
      runtime_profile_id: null,
      runtime_source: null,
      can_select_runtime: false,
      waiting_runtime_reason: null,
      version: 1,
      created_at: '2026-09-12T10:00:00Z',
      updated_at: '2026-09-12T10:00:00Z',
    } satisfies CollaborationExecution

    render(issue, {
      assignments: [assignment],
      executions: [failedExecution],
    })

    const error = container.querySelector('[data-testid="collaboration-run-error-2"]')
    expect(error?.textContent).toBe(failedExecution.error_message)
  })
})
