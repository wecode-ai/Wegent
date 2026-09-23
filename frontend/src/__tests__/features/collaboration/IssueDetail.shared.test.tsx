// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'

if (typeof globalThis.structuredClone !== 'function') {
  Object.defineProperty(globalThis, 'structuredClone', {
    configurable: true,
    value: <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T,
  })
}

import {
  IssueCreate,
  IssueDetail,
  collaborationMessages,
  dueDateTimeLocalFromSource,
  type CollaborationIssue,
  type CollaborationExecution,
  type SharedWorkspaceApi,
  type WorkspaceDelivery,
  type WorkspaceWorkflowPlan,
} from '@wegent/collaboration'

const issue: CollaborationIssue = {
  id: 'issue-1',
  cloud_project_id: 'project-1',
  sequence_number: 7,
  parent_id: null,
  created_by_user_id: 1,
  assignee_user_id: null,
  title: '共享详情',
  description: '原描述',
  status: 'pending',
  priority: 'none',
  due_at: null,
  tags: [],
  sort_order: 0,
  version: 1,
  created_at: '2026-09-10T00:00:00Z',
  updated_at: '2026-09-10T00:00:00Z',
  completed_at: null,
  can_edit: true,
}

const project = {
  id: 'project-1',
  public_id: 'project-1',
  project_key: 'COL',
  name: '共享协作项目',
  description: '',
  project_store: 'backend' as const,
  task_provider: 'native',
  provider_config: {},
  board_config: {
    group_by: 'status' as const,
    processing_start_status_id: null,
    statuses: [
      { id: 'pending', name: '待开始', color: 'blue' as const },
      { id: 'in_progress', name: '进行中', color: 'orange' as const },
    ],
  },
  created_by_user_id: 1,
  current_user_id: 1,
  access_role: 'Owner' as const,
  status: 'active',
  tags: [],
  version: 1,
  created_at: '2026-09-10T00:00:00Z',
  updated_at: '2026-09-10T00:00:00Z',
}

describe('shared IssueDetail', () => {
  type IssueDetailApi = Pick<
    SharedWorkspaceApi,
    | 'activity'
    | 'issues'
    | 'members'
    | 'agents'
    | 'attachments'
    | 'comments'
    | 'assignments'
    | 'collaborators'
    | 'taskBindings'
    | 'workflowPlans'
    | 'deliveries'
    | 'automations'
  >

  const member = {
    id: 5,
    user_id: 5,
    user_name: '张三',
    email: null,
    role: 'Developer' as const,
  }
  const secondMember = {
    id: 6,
    user_id: 6,
    user_name: '李四',
    email: null,
    role: 'Developer' as const,
  }
  const collaborator = {
    id: 'collaborator-5',
    issueId: issue.id,
    userId: 5,
    userName: '张三',
    email: null,
    source: 'manual',
    addedByUserId: 1,
    createdAt: '2026-09-10T00:00:00Z',
  }
  const workflowPlan = (status: WorkspaceWorkflowPlan['status']): WorkspaceWorkflowPlan => ({
    runId: `run-${status}`,
    issueId: issue.id,
    stageId: 'stage-1',
    planVersion: 1,
    approvalPolicy: 'required',
    status,
    summary: `方案 ${status}`,
    items: [{ id: 'step-1', title: '实现共享详情' }],
  })
  const delivery: WorkspaceDelivery = {
    id: 'delivery-1',
    issueId: issue.id,
    status: 'delivered',
    markdown: '详情交付',
    assets: [],
    fulfillments: [],
    createdAt: '2026-09-10T00:00:00Z',
    deliveredAt: '2026-09-10T01:00:00Z',
  }

  function createApi(overrides: Record<string, unknown> = {}): IssueDetailApi {
    return {
      issues: {
        get: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        assign: jest.fn(),
        approveRun: jest.fn(),
        rejectRun: jest.fn(),
      },
      members: {
        list: jest.fn().mockResolvedValue([member, secondMember]),
      },
      agents: {
        list: jest.fn().mockResolvedValue([{ id: 'bot-1', name: '代码机器人' }]),
      },
      attachments: {
        list: jest.fn().mockResolvedValue([]),
        upload: jest.fn(),
        access: jest.fn().mockResolvedValue({
          url: 'https://example.test/attachment',
          expiresInSeconds: 60,
        }),
        read: jest.fn().mockResolvedValue(new Blob(['attachment'])),
        remove: jest.fn(),
      },
      comments: {
        create: jest.fn(),
      },
      assignments: {
        list: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
      },
      collaborators: {
        list: jest.fn().mockResolvedValue([]),
        add: jest.fn().mockResolvedValue(collaborator),
        remove: jest.fn().mockResolvedValue(undefined),
      },
      taskBindings: {
        list: jest.fn().mockResolvedValue([]),
      },
      workflowPlans: {
        get: jest.fn().mockResolvedValue(null),
      },
      deliveries: {
        list: jest.fn().mockResolvedValue([]),
        get: jest.fn().mockResolvedValue(delivery),
        create: jest.fn(),
        addAsset: jest.fn(),
        finalize: jest.fn(),
        discardDraft: jest.fn(),
      },
      automations: {
        runWorkflowNode: jest.fn(),
      },
      ...overrides,
    } as unknown as IssueDetailApi
  }

  function detailView(
    api: IssueDetailApi,
    props: Partial<ComponentProps<typeof IssueDetail>> = {}
  ) {
    return (
      <IssueDetail
        api={api}
        project={project}
        issue={issue}
        allIssues={[issue]}
        comments={[]}
        messages={collaborationMessages['zh-CN']}
        onClose={jest.fn()}
        onChange={jest.fn()}
        onCommentsChange={jest.fn()}
        onConflict={jest.fn()}
        onError={jest.fn()}
        {...props}
      />
    )
  }

  function renderDetail(
    api: IssueDetailApi,
    props: Partial<ComponentProps<typeof IssueDetail>> = {}
  ) {
    return render(detailView(api, props))
  }

  it('loads the PC project thread and sends replies through the same transport', async () => {
    const message = {
      messageId: 'chat-root',
      projectId: project.id,
      taskId: issue.id,
      sequenceNumber: 1,
      sender: { type: 'agent' as const, id: 'bot-1', name: 'Codex' },
      type: 'text' as const,
      content: 'Shared project conversation',
      metadata: {},
      status: 'completed' as const,
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
    }
    const unsubscribe = jest.fn()
    const subscribe = jest.fn().mockResolvedValue({
      snapshot: { messages: [message], latestSequence: 1, currentUserId: '1' },
      unsubscribe,
    })
    const send = jest.fn().mockResolvedValue({
      ...message,
      messageId: 'reply-1',
      rootMessageId: message.messageId,
      sequenceNumber: 2,
      content: 'Follow up',
    })
    const createComment = jest.fn()
    const api = createApi({
      activity: { subscribe, send } as unknown as NonNullable<SharedWorkspaceApi['activity']>,
      comments: { create: createComment },
    })
    const { unmount } = renderDetail(api)
    expect(await screen.findByText(message.content)).toBeInTheDocument()
    expect(subscribe).toHaveBeenCalledWith(
      project.id,
      issue.id,
      0,
      expect.any(Function),
      expect.any(Function)
    )
    expect(screen.queryByTestId('collaboration-current-assignment')).not.toBeInTheDocument()
    fireEvent.change(screen.getByTestId('collaboration-chat-reply-input-chat-root'), {
      target: { value: 'Follow up' },
    })
    fireEvent.click(screen.getByTestId('collaboration-chat-reply-send-chat-root'))
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: project.id,
          taskId: issue.id,
          text: 'Follow up',
          replyToMessageId: message.messageId,
        })
      )
    )
    expect(await screen.findByTestId('collaboration-chat-replies-chat-root')).toHaveTextContent(
      'Follow up'
    )
    expect(createComment).not.toHaveBeenCalled()
    unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('loads details only for a changed Issue or API, not changed callbacks', async () => {
    const api = createApi()
    const aiIssue: CollaborationIssue = {
      ...issue,
      workflow: { advancement_policy: 'ai' },
    }
    const view = renderDetail(api, { issue: aiIssue })
    await act(async () => {})
    for (let index = 0; index < 10; index += 1) {
      view.rerender(detailView(api, { issue: aiIssue }))
      await act(async () => {})
    }
    const requests = [
      api.attachments.list,
      api.deliveries.list,
      api.taskBindings.list,
      api.collaborators.list,
      api.members.list,
      api.agents.list,
      api.workflowPlans.get,
    ]
    for (const request of requests) expect(request).toHaveBeenCalledTimes(1)

    const nextIssue = { ...aiIssue, id: 'issue-2' }
    view.rerender(detailView(api, { issue: nextIssue }))
    await act(async () => {})
    for (const request of requests) expect(request).toHaveBeenCalledTimes(2)
    expect(api.attachments.list).toHaveBeenLastCalledWith(nextIssue.id)

    const nextApi = createApi()
    view.rerender(detailView(nextApi, { issue: nextIssue }))
    await act(async () => {})
    expect(nextApi.attachments.list).toHaveBeenCalledTimes(1)
    expect(nextApi.workflowPlans.get).toHaveBeenCalledWith(nextIssue.id)
  })

  it.each([409, 500])('uses the latest callbacks after a %s save failure', async status => {
    const api = createApi()
    jest
      .mocked(api.issues.update)
      .mockRejectedValue(Object.assign(new Error('Save failed'), { status }))
    const original = { onError: jest.fn(), onConflict: jest.fn() }
    const latest = { onError: jest.fn(), onConflict: jest.fn() }
    const view = renderDetail(api, original)
    await act(async () => {})
    view.rerender(detailView(api, latest))
    fireEvent.change(screen.getByTestId('cloud-todo-detail-title'), {
      target: { value: '修改标题' },
    })
    fireEvent.click(screen.getByTestId('cloud-todo-save'))
    await waitFor(() =>
      expect(status === 409 ? latest.onConflict : latest.onError).toHaveBeenCalledTimes(1)
    )
    expect(original.onError).not.toHaveBeenCalled()
    expect(original.onConflict).not.toHaveBeenCalled()
    expect(api.attachments.list).toHaveBeenCalledTimes(1)
  })

  it('wires the PC approval toolbar through the complete Web Issue host', async () => {
    const api = createApi()
    const approved = { ...issue, version: 2, execution_state: 'queued' }
    jest.mocked(api.issues.approveRun).mockResolvedValue(approved)
    const onChange = jest.fn()
    renderDetail(api, {
      issue: { ...issue, can_approve: true, execution_state: 'waiting_approval' },
      onChange,
    })
    fireEvent.click(await screen.findByTestId('cloud-task-activity-approve-issue-1'))
    await waitFor(() =>
      expect(api.issues.approveRun).toHaveBeenCalledWith('project-1', 'issue-1', issue.version)
    )
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(approved))
  })

  it('separates bound task drawers from execution details and preserves the Issue draft', async () => {
    // JSDOM does not lay out the viewport. Keep the real virtualizer and supply
    // the browser geometry it observes instead of replacing the message list.
    const dimensions = ['offsetHeight', 'clientHeight', 'offsetWidth', 'clientWidth'] as const
    const geometry = dimensions.map(name =>
      jest.spyOn(HTMLElement.prototype, name, 'get').mockReturnValue(600)
    )
    const canvas = jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: (text: string) => ({ width: text.length * 7 }),
    } as unknown as CanvasRenderingContext2D)
    const scrollTo = jest.spyOn(Element.prototype, 'scrollTo').mockImplementation(() => {})
    const originalMatchMedia = window.matchMedia
    window.matchMedia = jest.fn().mockReturnValue({
      matches: false,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    })
    try {
      const runtime = {
        listDevices: jest.fn().mockResolvedValue([]),
        subscribeChatStream: jest.fn().mockResolvedValue(jest.fn()),
        work: {
          createRuntimeTask: jest.fn(),
          listRuntimeWork: jest.fn().mockResolvedValue({
            projects: [],
            totalTasks: 1,
            chats: [
              {
                deviceId: 'device-1',
                deviceName: 'Actual execution device',
                workspacePath: '/work',
                available: true,
                tasks: [
                  {
                    taskId: 'actual-runtime-task',
                    title: 'Current task title',
                    runtime: 'codex',
                    workspacePath: '/work',
                    modelSelection: { modelName: 'Current task model' },
                  },
                ],
              },
            ],
          }),
          sendRuntimeMessage: jest.fn(),
          guideRuntimeTask: jest.fn(),
          interruptAndSendRuntimeMessage: jest.fn(),
          cancelRuntimeTask: jest.fn(),
        },
        getTranscript: jest.fn().mockResolvedValue({
          runtime: 'codex',
          workspacePath: '/work',
          running: false,
          title: '检查 pwd',
          messages: [],
          turns: [
            {
              id: 'turn-1',
              status: 'done',
              items: [
                {
                  id: 'answer',
                  type: 'assistant_text',
                  content: 'Actual runtime output',
                  createdAt: '2026-09-17T00:00:00Z',
                },
              ],
            },
          ],
        }),
        subscribe: jest.fn().mockResolvedValue(jest.fn()),
        cancel: jest.fn().mockResolvedValue(undefined),
        listModels: jest.fn().mockResolvedValue([]),
        uploadAttachment: jest.fn(),
        deleteAttachment: jest.fn(),
        openModelSettings: jest.fn(),
        openCloudConnections: jest.fn(),
        readAttachment: jest.fn(),
        readWorkspaceFile: jest.fn(),
        dispose: jest.fn(),
      }
      const api = createApi({
        runtime,
        taskBindings: {
          bindTask: jest.fn(),
          unbindTask: jest.fn(),
          list: jest.fn().mockResolvedValue([
            {
              id: 'binding-1',
              projectId: project.id,
              issueId: issue.id,
              taskUserId: 1,
              deviceId: 'device-1',
              taskId: 'actual-runtime-task',
              taskTitle: '检查 pwd',
              backendTaskId: null,
              linkedAt: '2026-09-17T00:00:00Z',
            },
          ]),
        },
      })
      const execution = {
        id: 92,
        loop_item_id: issue.id,
        task_title: '检查 pwd',
        executor_type: 'project_robot',
        display_state: 'succeeded',
        runtime_device_id: 'device-1',
        runtime_task_id: 'actual-runtime-task',
        created_at: '2026-09-10T01:00:00Z',
      } as CollaborationExecution
      await act(async () => {
        renderDetail(api, { executions: [execution] })
      })
      const editor = screen.getByTestId('cloud-todo-detail')
      const comment = screen.getByTestId('collaboration-issue-comment')
      fireEvent.change(comment, { target: { value: '保留这条草稿' } })
      fireEvent.click(screen.getByTestId('collaboration-open-execution-92'))
      expect(await screen.findByText('Actual runtime output')).toBeInTheDocument()
      expect(await screen.findByText(/Actual execution device/)).toBeInTheDocument()
      expect(screen.getByText(/Current task model/)).toBeInTheDocument()
      expect(runtime.getTranscript).toHaveBeenCalledWith({
        deviceId: 'device-1',
        taskId: 'actual-runtime-task',
        limit: 50,
        refresh: true,
        projectSession: { projectId: 'project-1', issueId: 'issue-1' },
      })
      expect(screen.getByTestId('runtime-execution-detail-overlay')).toBeInTheDocument()
      expect(screen.getByTestId('runtime-execution-detail-close')).toHaveFocus()
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(screen.queryByTestId('runtime-execution-detail-overlay')).not.toBeInTheDocument()
      expect(screen.getByTestId('cloud-todo-detail')).toBe(editor)
      expect(comment).toHaveValue('保留这条草稿')
      fireEvent.click(screen.getByTestId('collaboration-open-task-92'))
      expect(await screen.findByTestId('ai-chat-modal')).toBeInTheDocument()
      expect(screen.queryByTestId('runtime-execution-detail-overlay')).not.toBeInTheDocument()
      expect(screen.getByTestId('project-chat-composer')).toBeInTheDocument()
      expect(await screen.findByText('Actual runtime output')).toBeInTheDocument()
      const track = document.querySelector('.issue-conversation-drawers')
      expect(track).toHaveAttribute('data-has-conversation', 'true')
      fireEvent.click(screen.getByTestId('collaboration-open-execution-92'))
      expect(await screen.findByTestId('runtime-execution-detail-overlay')).toBeInTheDocument()
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(screen.queryByTestId('runtime-execution-detail-overlay')).not.toBeInTheDocument()
      expect(screen.getByTestId('ai-chat-modal')).toBeInTheDocument()
      fireEvent.click(screen.getByTestId('ai-chat-modal-close'))
      await waitFor(() => expect(screen.queryByTestId('ai-chat-modal')).not.toBeInTheDocument())
      expect(track).toHaveAttribute('data-has-conversation', 'false')
      expect(screen.getByTestId('cloud-todo-detail')).toBe(editor)
      expect(comment).toHaveValue('保留这条草稿')
    } finally {
      geometry.forEach(mock => mock.mockRestore())
      canvas.mockRestore()
      scrollTo.mockRestore()
      window.matchMedia = originalMatchMedia
    }
  })

  it('creates an Issue through the same shared editor and detail port used by Wework', async () => {
    const created = {
      ...issue,
      id: 'issue-created',
      title: '共享创建界面',
      description: '由共享详情编辑器创建',
      priority: 'high' as const,
    }
    const create = jest.fn().mockResolvedValue(created)
    const onCreated = jest.fn()
    const api = createApi({
      issues: {
        create,
        update: jest.fn(),
        assign: jest.fn(),
      },
    })

    render(
      <IssueCreate
        api={api}
        project={project}
        allIssues={[issue]}
        messages={collaborationMessages['zh-CN']}
        onClose={jest.fn()}
        onCreated={onCreated}
        onError={jest.fn()}
      />
    )

    expect(screen.getByTestId('collaboration-issue-create-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-create-panel')).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('cloud-todo-title'), {
      target: { value: created.title },
    })
    fireEvent.change(screen.getByTestId('cloud-todo-detail-description'), {
      target: { value: created.description },
    })
    fireEvent.change(screen.getByTestId('cloud-todo-create-priority'), {
      target: { value: 'high' },
    })
    fireEvent.click(screen.getByTestId('cloud-todo-create-confirm'))

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(project.id, {
        title: created.title,
        description: created.description,
        status: 'pending',
        priority: 'high',
        tags: [],
      })
    )
    expect(onCreated).toHaveBeenCalledWith(created)
  }, 30_000)

  it('persists content and assigns through the shared assignee control', async () => {
    const updated = { ...issue, version: 2, description: '新描述', priority: 'high' as const }
    const update = jest.fn().mockResolvedValue(updated)
    const assign = jest.fn().mockResolvedValue({ ...updated, assignee_user_id: 5, version: 3 })
    const onChange = jest.fn()
    const onAssignmentsChange = jest.fn()
    const onCommentsChange = jest.fn()
    const api = createApi({
      issues: { update, assign },
    })
    renderDetail(api, {
      agents: [{ id: 'bot-1', name: '代码机器人' }],
      members: [member, secondMember],
      onAssignmentsChange,
      onCommentsChange,
      onChange,
    })

    expect(screen.getByTestId('cloud-todo-detail')).toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-tasks')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-state-summary')).toHaveTextContent('待开始')
    expect(screen.getByTestId('cloud-todo-state-summary')).not.toHaveTextContent('执行任务')
    expect(screen.getByTestId('collaboration-comments')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-detail-assignee')).toBeEnabled()
    expect(screen.queryByTestId('collaboration-assignment-target')).not.toBeInTheDocument()
    expect(screen.queryByTestId('collaboration-assignment-workflow-step')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('cloud-todo-edit-content'))
    fireEvent.change(screen.getByTestId('cloud-todo-detail-description'), {
      target: { value: '新描述' },
    })
    fireEvent.change(screen.getByTestId('cloud-todo-detail-priority'), {
      target: { value: 'high' },
    })
    fireEvent.click(screen.getByTestId('cloud-todo-save'))

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('issue-1', {
        version: 1,
        title: '共享详情',
        description: '新描述',
        status: 'pending',
        priority: 'high',
        parentId: null,
        dueAt: null,
        tags: [],
      })
    )
    fireEvent.click(screen.getByTestId('cloud-todo-detail-assignee'))
    fireEvent.click(await screen.findByTestId('cloud-todo-detail-assignee-option-user:5'))
    fireEvent.click(screen.getByTestId('wework-assignment-notify-confirm'))
    fireEvent.click(screen.getByTestId('cloud-todo-save'))
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith(project.id, issue.id, {
        version: 2,
        assigneeType: 'user',
        assigneeId: '5',
        notifyAssignee: true,
      })
    )
    expect(screen.queryByTestId('collaboration-current-assignment')).not.toBeInTheDocument()
    expect(onCommentsChange).not.toHaveBeenCalled()
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ assignee_user_id: 5 }))
  })

  it('allows assignment without granting permission to edit Issue content', async () => {
    const assign = jest.fn().mockResolvedValue({ ...issue, assignee_user_id: 5, version: 2 })
    const update = jest.fn()
    const api = createApi({ issues: { assign, update } })
    renderDetail(api, { issue: { ...issue, can_edit: false }, members: [member] })
    fireEvent.click(screen.getByTestId('cloud-todo-detail-assignee'))
    fireEvent.click(await screen.findByTestId('cloud-todo-detail-assignee-option-user:5'))
    fireEvent.click(screen.getByTestId('wework-assignment-notify-confirm'))
    fireEvent.click(screen.getByTestId('cloud-todo-save'))
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith(project.id, issue.id, {
        version: 1,
        assigneeType: 'user',
        assigneeId: '5',
        notifyAssignee: true,
      })
    )
    expect(update).not.toHaveBeenCalled()
  })

  it('keeps an uploaded attachment when an older list request resolves afterward', async () => {
    let resolveAttachments: (attachments: []) => void = () => undefined
    const list = jest.fn(
      () =>
        new Promise<[]>(resolve => {
          resolveAttachments = resolve
        })
    )
    const uploaded = {
      id: 'attachment-race',
      loop_item_id: issue.id,
      display_name: 'race.txt',
      content_type: 'text/plain',
      size_bytes: 4,
      created_by_user_id: 1,
      created_at: '2026-09-15T00:00:00Z',
      markdown_url: 'attachment://attachment-race',
    }
    const upload = jest.fn().mockResolvedValue(uploaded)
    const api = createApi({
      attachments: {
        list,
        upload,
        access: jest.fn(),
        read: jest.fn(),
        remove: jest.fn(),
      },
    })

    renderDetail(api)
    fireEvent.click(screen.getByTestId('cloud-todo-edit-content'))
    fireEvent.change(screen.getByTestId('cloud-todo-attachment-input'), {
      target: { files: [new File(['race'], uploaded.display_name, { type: 'text/plain' })] },
    })

    expect(await screen.findByText(uploaded.display_name)).toBeVisible()
    await act(async () => {
      resolveAttachments([])
    })
    expect(screen.getByText(uploaded.display_name)).toBeVisible()
  })

  it('keeps an uploaded attachment when a list request starts during the upload', async () => {
    const uploaded = {
      id: 'attachment-concurrent-race',
      loop_item_id: issue.id,
      display_name: 'concurrent-race.txt',
      content_type: 'text/plain',
      size_bytes: 4,
      created_by_user_id: 1,
      created_at: '2026-09-14T00:00:00Z',
      markdown_url: 'attachment://attachment-concurrent-race',
    }
    let resolveUpload: (attachment: typeof uploaded) => void = () => undefined
    let resolveAttachments: (attachments: []) => void = () => undefined
    const list = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockImplementationOnce(
        () =>
          new Promise<[]>(resolve => {
            resolveAttachments = resolve
          })
      )
    const upload = jest.fn(
      () =>
        new Promise<typeof uploaded>(resolve => {
          resolveUpload = resolve
        })
    )
    const api = createApi({
      attachments: {
        list,
        upload,
        access: jest.fn(),
        read: jest.fn(),
        remove: jest.fn(),
      },
    })
    const { rerender } = renderDetail(api)

    await waitFor(() => expect(list).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByTestId('cloud-todo-edit-content'))
    fireEvent.change(screen.getByTestId('cloud-todo-attachment-input'), {
      target: { files: [new File(['race'], uploaded.display_name, { type: 'text/plain' })] },
    })
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1))

    rerender(detailView({ ...api }))
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    await act(async () => {
      resolveUpload(uploaded)
    })
    expect(await screen.findByText(uploaded.display_name)).toBeVisible()

    await act(async () => {
      resolveAttachments([])
    })
    expect(screen.getByText(uploaded.display_name)).toBeVisible()
  })

  it('ignores an attachment upload completion after switching to another Issue', async () => {
    const secondIssue = {
      ...issue,
      id: 'issue-2',
      sequence_number: 8,
      title: '第二个任务',
      description: '第二个任务描述',
    }
    const uploaded = {
      id: 'attachment-from-first-issue',
      loop_item_id: issue.id,
      display_name: 'first-issue.txt',
      content_type: 'text/plain',
      size_bytes: 4,
      created_by_user_id: 1,
      created_at: '2026-09-14T00:00:00Z',
      markdown_url: 'attachment://attachment-from-first-issue',
    }
    let resolveUpload: (attachment: typeof uploaded) => void = () => undefined
    const upload = jest.fn(
      () =>
        new Promise<typeof uploaded>(resolve => {
          resolveUpload = resolve
        })
    )
    const api = createApi({
      attachments: {
        list: jest.fn().mockResolvedValue([]),
        upload,
        access: jest.fn(),
        read: jest.fn(),
        remove: jest.fn(),
      },
    })
    const { rerender } = renderDetail(api)

    fireEvent.click(screen.getByTestId('cloud-todo-edit-content'))
    fireEvent.change(screen.getByTestId('cloud-todo-attachment-input'), {
      target: { files: [new File(['race'], uploaded.display_name, { type: 'text/plain' })] },
    })
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1))

    await act(async () => {
      rerender(
        detailView(api, {
          issue: secondIssue,
          allIssues: [issue, secondIssue],
        })
      )
    })
    fireEvent.click(screen.getByTestId('cloud-todo-edit-content'))
    expect(screen.getByTestId('cloud-todo-attachment-input')).not.toBeDisabled()

    await act(async () => {
      resolveUpload(uploaded)
    })
    expect(screen.queryByText(uploaded.display_name)).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-detail-description')).toHaveValue(secondIssue.description)
  })

  it('ignores an attachment paste completion after switching away and back', async () => {
    const secondIssue = {
      ...issue,
      id: 'issue-2',
      sequence_number: 8,
      title: '第二个任务',
      description: '第二个任务描述',
    }
    const uploaded = {
      id: 'pasted-attachment-from-old-load',
      loop_item_id: issue.id,
      display_name: 'old-load.png',
      content_type: 'image/png',
      size_bytes: 4,
      created_by_user_id: 1,
      created_at: '2026-09-14T00:00:00Z',
      markdown_url: 'attachment://pasted-attachment-from-old-load',
      markdown: '![old-load.png](attachment://pasted-attachment-from-old-load)',
    }
    let resolveUpload: (attachment: typeof uploaded) => void = () => undefined
    const upload = jest.fn(
      () =>
        new Promise<typeof uploaded>(resolve => {
          resolveUpload = resolve
        })
    )
    const api = createApi({
      attachments: {
        list: jest.fn().mockResolvedValue([]),
        upload,
        access: jest.fn(),
        read: jest.fn(),
        remove: jest.fn(),
      },
    })
    const { rerender } = renderDetail(api)

    fireEvent.click(screen.getByTestId('cloud-todo-edit-content'))
    fireEvent.paste(screen.getByTestId('cloud-todo-detail-description'), {
      clipboardData: {
        files: [new File(['race'], uploaded.display_name, { type: uploaded.content_type })],
      },
    })
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1))

    await act(async () => {
      rerender(
        detailView(api, {
          issue: secondIssue,
          allIssues: [issue, secondIssue],
        })
      )
    })
    await act(async () => {
      rerender(
        detailView(api, {
          issue,
          allIssues: [issue, secondIssue],
        })
      )
    })

    await act(async () => {
      resolveUpload(uploaded)
    })
    expect(screen.queryByText(uploaded.display_name)).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-detail-description')).toHaveValue(issue.description)
  })

  it('keeps Issue editing, comments, assignment and starting work as separate permissions', async () => {
    const update = jest.fn()
    const legacyAssign = jest.fn()
    const createComment = jest.fn()
    const upload = jest.fn()
    const removeAttachment = jest.fn()
    const addCollaborator = jest.fn()
    const removeCollaborator = jest.fn()
    const onCreateTask = jest.fn()
    const readOnlyIssue = {
      ...issue,
      can_edit: false,
      can_view_detail: true,
      tags: ['只读'],
    }
    const api = createApi({
      issues: { update, assign: legacyAssign },
      comments: { create: createComment },
      attachments: {
        list: jest.fn().mockResolvedValue([
          {
            id: 'attachment-read-only',
            loop_item_id: issue.id,
            display_name: 'readonly.txt',
            content_type: 'text/plain',
            size_bytes: 8,
            created_by_user_id: 1,
            created_at: '2026-09-10T00:00:00Z',
            markdown_url: 'attachment://attachment-read-only',
          },
        ]),
        upload,
        access: jest.fn(),
        read: jest.fn(),
        remove: removeAttachment,
      },
      collaborators: {
        list: jest.fn().mockResolvedValue([collaborator]),
        add: addCollaborator,
        remove: removeCollaborator,
      },
    })

    renderDetail(api, {
      issue: readOnlyIssue,
      allIssues: [readOnlyIssue],
      members: [member],
      onCreateTask,
    })

    expect(screen.getByTestId('cloud-todo-detail-title')).toHaveAttribute('readonly')
    expect(screen.getByTestId('cloud-todo-detail-description')).toHaveAttribute('readonly')
    expect(screen.getByTestId('cloud-todo-detail-status')).toBeDisabled()
    expect(screen.getByTestId('cloud-todo-detail-priority')).toBeDisabled()
    expect(screen.getByTestId('cloud-todo-detail-assignee')).toBeEnabled()
    expect(screen.getByTestId('cloud-todo-detail-parent')).toBeDisabled()
    expect(screen.getByTestId('cloud-todo-detail-due-date')).toBeDisabled()
    expect(screen.queryByTestId('cloud-todo-detail-tag-input')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-detail-tag-tag-remove-只读')).not.toBeInTheDocument()
    expect(screen.getByTestId('collaboration-issue-comment')).toBeEnabled()
    expect(screen.queryByTestId('collaboration-assignment-target')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('cloud-todo-create-task'))
    expect(onCreateTask).toHaveBeenCalledWith()
    expect(screen.getByTestId('cloud-todo-add-collaborator')).toBeDisabled()
    expect(screen.queryByRole('button', { name: '移除参与者 张三' })).not.toBeInTheDocument()
    expect(await screen.findByText('readonly.txt')).toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-attachment-input')).not.toBeInTheDocument()
    expect(
      screen.queryByTestId('cloud-todo-attachment-delete-attachment-read-only')
    ).not.toBeInTheDocument()

    fireEvent.change(screen.getByTestId('cloud-todo-detail-title'), {
      target: { value: '不应保存' },
    })
    fireEvent.keyDown(screen.getByTestId('cloud-todo-detail'), {
      key: 'Enter',
      metaKey: true,
    })

    expect(update).not.toHaveBeenCalled()
    expect(legacyAssign).not.toHaveBeenCalled()
    expect(createComment).not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
    expect(removeAttachment).not.toHaveBeenCalled()
    expect(addCollaborator).not.toHaveBeenCalled()
    expect(removeCollaborator).not.toHaveBeenCalled()
  })

  it('allows a project member to comment and start work without assignment permission', () => {
    const onCreateTask = jest.fn()

    renderDetail(createApi(), {
      project: { ...project, access_role: 'Developer' },
      issue: { ...issue, can_edit: false, can_view_detail: true },
      allIssues: [{ ...issue, can_edit: false, can_view_detail: true }],
      members: [member],
      onCreateTask,
    })

    expect(screen.getByTestId('collaboration-issue-comment')).toBeEnabled()
    expect(screen.queryByTestId('collaboration-assignment-target')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('cloud-todo-create-task'))
    expect(onCreateTask).toHaveBeenCalledWith()
  })

  it('keeps comments, assignment, and work closed for a viewer', () => {
    const onCreateTask = jest.fn()

    renderDetail(createApi(), {
      project: { ...project, access_role: 'Viewer' },
      issue: { ...issue, can_edit: false, can_view_detail: true },
      allIssues: [{ ...issue, can_edit: false, can_view_detail: true }],
      onCreateTask,
    })

    expect(screen.getByTestId('collaboration-issue-comment')).toBeDisabled()
    expect(screen.queryByTestId('collaboration-assignment-target')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-create-task')).not.toBeInTheDocument()
    expect(onCreateTask).not.toHaveBeenCalled()
  })

  it('allows an explicitly editable Issue to submit a comment', async () => {
    const createdComment = {
      id: 'comment-1',
      author: 'Owner',
      body: '可编辑评论',
      web_url: null,
      created_at: '2026-09-11T00:00:00Z',
      updated_at: '2026-09-11T00:00:00Z',
    }
    const createComment = jest.fn().mockResolvedValue(createdComment)
    const onCommentsChange = jest.fn()
    const api = createApi({
      comments: { create: createComment },
    })

    renderDetail(api, { onCommentsChange })

    fireEvent.change(screen.getByTestId('collaboration-issue-comment'), {
      target: { value: createdComment.body },
    })
    fireEvent.click(screen.getByTestId('collaboration-issue-comment-submit'))

    await waitFor(() => expect(createComment).toHaveBeenCalledWith(issue.id, createdComment.body))
    expect(onCommentsChange).toHaveBeenCalledWith([createdComment])
  })

  it('preserves a date-only due_at when saving another field', async () => {
    const dateOnlyIssue = { ...issue, due_at: '2026-09-12' }
    const updated = { ...dateOnlyIssue, title: '仅修改标题', version: 2 }
    const update = jest.fn().mockResolvedValue(updated)
    const api = createApi({ issues: { update, assign: jest.fn() } })

    renderDetail(api, { issue: dateOnlyIssue, allIssues: [dateOnlyIssue] })

    expect(screen.getByTestId('cloud-todo-detail-due-date')).toHaveValue('2026-09-12T00:00')
    fireEvent.change(screen.getByTestId('cloud-todo-detail-title'), {
      target: { value: '仅修改标题' },
    })
    fireEvent.click(screen.getByTestId('cloud-todo-save'))

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('issue-1', {
        version: 1,
        title: '仅修改标题',
        description: '原描述',
        status: 'pending',
        priority: 'none',
        parentId: null,
        dueAt: '2026-09-12',
        tags: [],
      })
    )
  })

  it('converts an edited datetime-local due date to UTC before saving', async () => {
    const timestampIssue = {
      ...issue,
      due_at: '2026-09-12T02:30:00.000Z',
    }
    const updated = { ...timestampIssue, version: 2 }
    const update = jest.fn().mockResolvedValue(updated)
    const api = createApi({ issues: { update, assign: jest.fn() } })
    const editedLocalValue = '2026-09-13T09:45'
    const expectedUtcValue = new Date(editedLocalValue).toISOString()

    renderDetail(api, { issue: timestampIssue, allIssues: [timestampIssue] })

    expect(screen.getByTestId('cloud-todo-detail-due-date')).toHaveValue(
      dueDateTimeLocalFromSource(timestampIssue.due_at)
    )
    fireEvent.change(screen.getByTestId('cloud-todo-detail-due-date'), {
      target: { value: editedLocalValue },
    })
    fireEvent.click(screen.getByTestId('cloud-todo-save'))

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        'issue-1',
        expect.objectContaining({ dueAt: expectedUtcValue })
      )
    )
  })

  it('opens attachments and manages collaborators, bindings, and delivery detail', async () => {
    const open = jest.spyOn(window, 'open').mockImplementation(() => null)
    const createObjectURL = jest.fn().mockReturnValue('blob:https://example.test/attachment')
    const revokeObjectURL = jest.fn()
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectURL,
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectURL,
    })
    const anchorClick = jest
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined)
    const api = createApi({
      attachments: {
        list: jest.fn().mockResolvedValue([
          {
            id: 'attachment-1',
            loop_item_id: issue.id,
            display_name: 'design.png',
            content_type: 'image/png',
            size_bytes: 512,
            created_by_user_id: 1,
            created_at: '2026-09-10T00:00:00Z',
            markdown_url: 'attachment://attachment-1',
          },
        ]),
        upload: jest.fn(),
        access: jest.fn().mockResolvedValue({
          url: 'https://example.test/attachment',
          expiresInSeconds: 60,
        }),
        read: jest.fn().mockResolvedValue(new Blob(['attachment'])),
        remove: jest.fn(),
      },
      collaborators: {
        list: jest.fn().mockResolvedValue([collaborator]),
        add: jest.fn().mockResolvedValue({
          ...collaborator,
          id: 'collaborator-6',
          userId: 6,
          userName: '李四',
        }),
        remove: jest.fn().mockResolvedValue(undefined),
      },
      taskBindings: {
        list: jest.fn().mockResolvedValue([
          {
            id: 9,
            projectId: issue.cloud_project_id,
            issueId: issue.id,
            taskUserId: 5,
            deviceId: 'device-1',
            taskId: 'task-1',
            taskTitle: '实现任务',
            backendTaskId: 91,
            linkedAt: '2026-09-10T00:00:00Z',
          },
        ]),
      },
      deliveries: {
        list: jest.fn().mockResolvedValue([
          {
            ...delivery,
            assets: [
              {
                id: 'asset-1',
                kind: 'file',
                displayName: 'report.md',
                relativePath: 'report.md',
                contentType: 'text/markdown',
                sizeBytes: 128,
                sha256: 'abc',
              },
            ],
          },
        ]),
        get: jest.fn().mockResolvedValue({
          ...delivery,
          assets: [
            {
              id: 'asset-1',
              kind: 'file',
              displayName: 'report.md',
              relativePath: 'report.md',
              contentType: 'text/markdown',
              sizeBytes: 128,
              sha256: 'abc',
            },
          ],
        }),
      },
    })

    renderDetail(api)

    fireEvent.click(await screen.findByTestId('cloud-todo-toggle-tasks'))
    expect(await screen.findByText('实现任务')).toBeInTheDocument()
    expect(document.querySelector('[title="张三"]')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('cloud-todo-attachment-open-attachment-1'))
    await waitFor(() => expect(api.attachments.access).toHaveBeenCalledWith('attachment-1'))
    expect(open).toHaveBeenCalledWith(
      'https://example.test/attachment',
      '_blank',
      'noopener,noreferrer'
    )
    await waitFor(() => expect(screen.queryByText('下载中…')).not.toBeInTheDocument())
    fireEvent.click(screen.getByTestId('cloud-todo-attachment-download-attachment-1'))
    await waitFor(() => expect(api.attachments.read).toHaveBeenCalledWith('attachment-1'))
    expect(createObjectURL).toHaveBeenCalled()
    expect(anchorClick).toHaveBeenCalled()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:https://example.test/attachment')

    fireEvent.click(screen.getByTestId('cloud-todo-add-collaborator'))
    fireEvent.change(screen.getByTestId('cloud-todo-collaborator-select'), {
      target: { value: '6' },
    })
    fireEvent.click(screen.getByTestId('cloud-todo-confirm-collaborator'))
    await waitFor(() => expect(api.collaborators.add).toHaveBeenCalledWith(issue.id, 6))
    expect(await screen.findByTitle('李四')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '移除参与者 张三' }))
    await waitFor(() => expect(api.collaborators.remove).toHaveBeenCalledWith(issue.id, 5))

    fireEvent.click(screen.getByRole('button', { name: /交付结果/ }))
    expect(screen.getByTestId('todo-detail-deliveries')).toHaveTextContent('1 个附件')
    expect(await screen.findByText('report.md')).toBeInTheDocument()
    open.mockRestore()
    anchorClick.mockRestore()
    delete (URL as Partial<typeof URL>).createObjectURL
    delete (URL as Partial<typeof URL>).revokeObjectURL
  })

  it('loads a workflow plan and executes every supported cloud workflow action', async () => {
    const approve = jest.fn().mockResolvedValue(workflowPlan('awaiting_review'))
    const approveReview = jest.fn().mockResolvedValue(workflowPlan('running'))
    const pause = jest.fn().mockResolvedValue(workflowPlan('paused'))
    const resume = jest.fn().mockResolvedValue(workflowPlan('running'))
    const replan = jest.fn().mockResolvedValue(workflowPlan('awaiting_approval'))
    const api = createApi({
      workflowPlans: {
        get: jest.fn().mockResolvedValue(workflowPlan('awaiting_approval')),
        approve,
        approveReview,
        pause,
        resume,
        replan,
      },
    })

    renderDetail(api, {
      issue: {
        ...issue,
        workflow: {
          advancement_policy: 'ai',
          orchestration_status: 'awaiting_approval',
          nodes: [],
        },
      },
    })

    fireEvent.click(await screen.findByTestId('cloud-todo-toggle-tasks'))
    fireEvent.click(await screen.findByTestId('cloud-todo-workflow-replan'))
    await waitFor(() => expect(replan).toHaveBeenCalledWith(issue.id))

    fireEvent.click(await screen.findByTestId('cloud-todo-workflow-approve'))
    await waitFor(() => expect(approve).toHaveBeenCalledWith(issue.id))

    fireEvent.click(await screen.findByTestId('cloud-todo-workflow-review'))
    await waitFor(() => expect(approveReview).toHaveBeenCalledWith(issue.id))

    fireEvent.click(await screen.findByTestId('cloud-todo-workflow-pause'))
    await waitFor(() => expect(pause).toHaveBeenCalledWith(issue.id))

    fireEvent.click(await screen.findByTestId('cloud-todo-workflow-resume'))
    await waitFor(() => expect(resume).toHaveBeenCalledWith(issue.id))
  })

  it('runs workflow nodes and completes stage deliverables through the shared cloud chain', async () => {
    const runningIssue = {
      ...issue,
      version: 2,
      workflow: {
        advancement_policy: 'manual' as const,
        nodes: [
          {
            id: 'automation-stage',
            name: '自动检查',
            depends_on: [],
            required: true,
            workspace_policy: 'composer' as const,
            execution_mode: 'robot' as const,
            automation_rule_id: 'automation-1',
            status: 'running' as const,
          },
        ],
      },
    }
    const runWorkflowNode = jest.fn().mockResolvedValue({ id: 'run-1' })
    const getIssue = jest.fn().mockResolvedValue(runningIssue)
    const onChange = jest.fn()
    const runApi = createApi({
      issues: {
        get: getIssue,
        create: jest.fn(),
        update: jest.fn(),
        assign: jest.fn(),
      },
      automations: { runWorkflowNode },
    })
    const runView = renderDetail(runApi, {
      issue: {
        ...issue,
        workflow: {
          advancement_policy: 'manual',
          nodes: [
            {
              id: 'automation-stage',
              name: '自动检查',
              depends_on: [],
              required: true,
              workspace_policy: 'composer',
              execution_mode: 'robot',
              automation_rule_id: 'automation-1',
              status: 'ready',
            },
          ],
        },
      },
      onChange,
    })

    fireEvent.click(await screen.findByTestId('cloud-todo-toggle-tasks'))
    fireEvent.click(await screen.findByTestId('cloud-todo-run-workflow-node-automation-stage'))
    await waitFor(() =>
      expect(runWorkflowNode).toHaveBeenCalledWith(
        project.id,
        issue.id,
        'automation-stage',
        'automation-1'
      )
    )
    expect(getIssue).toHaveBeenCalledWith(issue.id)
    expect(onChange).toHaveBeenCalledWith(runningIssue)
    runView.unmount()

    const completedIssue = {
      ...issue,
      version: 3,
      workflow: {
        advancement_policy: 'manual' as const,
        nodes: [],
      },
    }
    const createDelivery = jest.fn().mockResolvedValue({
      ...delivery,
      id: 'delivery-draft',
      status: 'draft',
    })
    const finalize = jest.fn().mockResolvedValue(delivery)
    const decideNode = jest.fn().mockResolvedValue(completedIssue)
    const completionApi = createApi({
      issues: {
        get: jest.fn().mockResolvedValue(completedIssue),
        create: jest.fn(),
        update: jest.fn(),
        assign: jest.fn(),
      },
      taskBindings: {
        list: jest.fn().mockResolvedValue([
          {
            id: 1,
            projectId: project.id,
            issueId: issue.id,
            taskUserId: 1,
            deviceId: 'device-1',
            taskId: 'task-1',
            taskTitle: '实现任务',
            backendTaskId: 7,
            workflowNodeId: 'review-stage',
            linkedAt: '2026-09-11T00:00:00Z',
          },
        ]),
      },
      workflowPlans: {
        get: jest.fn().mockResolvedValue(null),
        decideNode,
      },
      deliveries: {
        list: jest.fn().mockResolvedValue([]),
        get: jest.fn().mockResolvedValue(delivery),
        create: createDelivery,
        addAsset: jest.fn(),
        finalize,
        discardDraft: jest.fn(),
      },
    })
    renderDetail(completionApi, {
      issue: {
        ...issue,
        workflow: {
          advancement_policy: 'manual',
          nodes: [
            {
              id: 'review-stage',
              name: '人工验收',
              depends_on: [],
              required: true,
              workspace_policy: 'composer',
              execution_mode: 'human',
              status: 'awaiting_approval',
              required_deliverables: [
                {
                  id: 'report',
                  name: '验收报告',
                  description: '',
                  value_type: 'text',
                },
              ],
            },
          ],
        },
      },
      onChange,
    })

    fireEvent.click(await screen.findByTestId('cloud-todo-toggle-tasks'))
    fireEvent.click(await screen.findByTestId('cloud-todo-approve-workflow-node-review-stage'))
    const deliverable = await screen.findByTestId('workflow-deliverable-input-report')
    fireEvent.change(deliverable.querySelector('textarea')!, {
      target: { value: '验收通过' },
    })
    fireEvent.click(screen.getByTestId('workflow-stage-completion-submit'))

    await waitFor(() =>
      expect(createDelivery).toHaveBeenCalledWith(
        issue.id,
        expect.objectContaining({
          sourceTask: expect.objectContaining({
            deviceId: 'device-1',
            taskId: 'task-1',
            backendTaskId: 7,
          }),
        })
      )
    )
    expect(finalize).toHaveBeenCalledWith('delivery-draft', {
      fulfillments: [
        {
          requirement_id: 'report',
          kind: 'text',
          text: '验收通过',
        },
      ],
    })
    expect(decideNode).toHaveBeenCalledWith(issue.id, 'review-stage', 'approve', '')
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(completedIssue))
  })
})
