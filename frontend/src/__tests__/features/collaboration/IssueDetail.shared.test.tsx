// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'

if (typeof globalThis.structuredClone !== 'function') {
  Object.defineProperty(globalThis, 'structuredClone', {
    configurable: true,
    value: <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T,
  })
}

jest.mock('@xyflow/react', () => ({
  Background: () => null,
  Controls: () => null,
  Handle: () => null,
  MarkerType: { ArrowClosed: 'arrowclosed' },
  Position: { Left: 'left', Right: 'right' },
  ReactFlow: () => <div data-testid="mock-workflow-flow" />,
}))

import {
  IssueCreate,
  IssueDetail,
  collaborationMessages,
  dueDateTimeLocalFromSource,
  type CollaborationIssue,
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

  function renderDetail(
    api: IssueDetailApi,
    props: Partial<ComponentProps<typeof IssueDetail>> = {}
  ) {
    return render(
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

  it('persists editable fields and appends a non-exclusive assignment activity', async () => {
    const updated = { ...issue, version: 2, description: '新描述', priority: 'high' as const }
    const assignment = {
      id: 'assignment-1',
      issue_id: issue.id,
      target_type: 'human' as const,
      target_id: '5',
      target_name: '张三',
      workflow_step: '交互设计',
      comment_id: 'comment-1',
      created_by_user_id: 1,
      created_by_user_name: 'Owner',
      status: 'active' as const,
      created_at: '2026-09-11T00:00:00Z',
      updated_at: '2026-09-11T00:00:00Z',
    }
    const assignmentComment = {
      id: 'comment-1',
      author: 'Owner',
      body: '请完成交互稿',
      web_url: null,
      created_at: '2026-09-11T00:00:00Z',
      updated_at: '2026-09-11T00:00:00Z',
    }
    const update = jest.fn().mockResolvedValue(updated)
    const createAssignment = jest.fn().mockResolvedValue({
      assignment,
      comment: assignmentComment,
      issue: updated,
    })
    const onChange = jest.fn()
    const onAssignmentsChange = jest.fn()
    const onCommentsChange = jest.fn()
    const api = createApi({
      issues: { update, assign: jest.fn() },
      assignments: {
        list: jest.fn().mockResolvedValue([]),
        create: createAssignment,
      },
    })
    renderDetail(api, {
      agents: [{ id: 'bot-1', name: '代码机器人' }],
      members: [member, secondMember],
      onAssignmentsChange,
      onCommentsChange,
      onChange,
    })

    expect(screen.getByTestId('cloud-todo-detail')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-tasks')).toBeInTheDocument()
    expect(screen.getByTestId('collaboration-comments')).toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-detail-assignee')).not.toBeInTheDocument()
    expect(screen.getByRole('option', { name: '张三' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: '代码机器人' })).toBeInTheDocument()

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
    fireEvent.change(screen.getByTestId('collaboration-assignment-target'), {
      target: { value: 'human:5' },
    })
    fireEvent.change(screen.getByTestId('collaboration-assignment-workflow-step'), {
      target: { value: '交互设计' },
    })
    fireEvent.change(screen.getByTestId('collaboration-issue-comment'), {
      target: { value: assignmentComment.body },
    })
    fireEvent.click(screen.getByTestId('collaboration-issue-comment-submit'))

    await waitFor(() =>
      expect(createAssignment).toHaveBeenCalledWith(issue.id, {
        targetType: 'human',
        targetId: '5',
        workflowStep: '交互设计',
        commentBody: assignmentComment.body,
        notifyTarget: true,
      })
    )
    expect(onAssignmentsChange).toHaveBeenCalledWith([assignment])
    expect(onCommentsChange).toHaveBeenCalledWith([assignmentComment])
    expect(onChange).toHaveBeenCalledWith(updated)
    expect(api.issues.assign).not.toHaveBeenCalled()
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
    expect(screen.queryByTestId('cloud-todo-detail-assignee')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-detail-parent')).toBeDisabled()
    expect(screen.getByTestId('cloud-todo-detail-due-date')).toBeDisabled()
    expect(screen.queryByTestId('cloud-todo-detail-tag-input')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-detail-tag-tag-remove-只读')).not.toBeInTheDocument()
    expect(screen.getByTestId('collaboration-issue-comment')).toBeEnabled()
    expect(screen.getByTestId('collaboration-assignment-target')).toBeEnabled()
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
      project: { ...project, access_role: 'Reporter' },
      issue: { ...issue, can_edit: false, can_view_detail: true },
      allIssues: [{ ...issue, can_edit: false, can_view_detail: true }],
      members: [member],
      onCreateTask,
    })

    expect(screen.getByTestId('collaboration-issue-comment')).toBeEnabled()
    expect(screen.getByTestId('collaboration-assignment-target')).toBeDisabled()
    fireEvent.click(screen.getByTestId('cloud-todo-create-task'))
    expect(onCreateTask).toHaveBeenCalledWith()
  })

  it('keeps comments and assignment closed for a restricted viewer without blocking work', () => {
    const onCreateTask = jest.fn()

    renderDetail(createApi(), {
      project: { ...project, access_role: 'RestrictedAnalyst' },
      issue: { ...issue, can_edit: false, can_view_detail: true },
      allIssues: [{ ...issue, can_edit: false, can_view_detail: true }],
      onCreateTask,
    })

    expect(screen.getByTestId('collaboration-issue-comment')).toBeDisabled()
    expect(screen.getByTestId('collaboration-assignment-target')).toBeDisabled()
    fireEvent.click(screen.getByTestId('cloud-todo-create-task'))
    expect(onCreateTask).toHaveBeenCalledWith()
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
