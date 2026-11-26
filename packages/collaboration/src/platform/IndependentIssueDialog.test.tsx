// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { IndependentIssueDialog } from './IndependentIssueDialog'
import {
  createPersonalIssuesApi,
  unlinkedIssueFromDetail,
  type IndependentIssue,
  type IssueDetailResponse,
  type PersonalIssuesApi,
} from './personalIssuesApi'
import { IssueDetailDraftProvider } from '../issue-detail/IssueDetailDraft'

it.each([false, true])(
  'uses the shared editor for attachments and atomic Issue edits (native download: %s)',
  async nativeDownload => {
    const issue: IndependentIssue = {
      id: 'standalone-issue',
      title: 'Review rollout',
      description: 'Check the rollout notes.',
      status: 'pending',
      priority: 'high',
      creator_id: 1,
      assignee_id: null,
      version: 1,
      created_at: '2026-11-24T00:00:00Z',
      updated_at: '2026-11-24T00:00:00Z',
      people: { 1: 'Owner', 2: 'Reviewer' },
      metadata: {
        participants: [2],
        archived: false,
        status_history: [
          {
            from_status: '',
            to_status: 'pending',
            to_status_name: '待开始',
            trigger: 'create',
            by_user_id: 1,
            at: '2026-11-24T00:00:00Z',
          },
        ],
        due_at: null,
        assignee_resource: { kind: 'group', id: 3 },
        resource_participants: [
          { kind: 'group', id: 3, name: 'Release group', human_ids: [2], team_id: null },
        ],
      },
    }
    const file = new Blob(['Rollout notes'])
    const downloadAttachment = vi.fn().mockResolvedValue(undefined)
    const attachments = {
      list: vi.fn().mockResolvedValue([
        {
          id: 'attachment-1',
          loop_item_id: issue.id,
          display_name: 'notes.txt',
          content_type: null,
          size_bytes: 10,
          created_by_user_id: 1,
          created_at: issue.created_at,
          markdown_url: '',
        },
      ]),
      read: vi.fn().mockResolvedValue(file),
      ...(nativeDownload ? { download: downloadAttachment } : {}),
      upload: vi.fn(),
      remove: vi.fn(),
    }
    const saveAttachment = vi.fn(async () => {})
    let savedIssue = issue
    let savedChild: IndependentIssue | undefined
    const detailPath = `/v1/loop-items/${issue.id}`
    const collaboratorsPath = `${detailPath}/collaborators`
    function detail(row: IndependentIssue): IssueDetailResponse {
      const { metadata, people } = row
      const resource = metadata.assignee_resource
      return {
        id: row.id,
        cloud_project_id: '',
        sequence_number: 0,
        parent_id: row.parent_id ?? null,
        title: row.title,
        description: row.description,
        status: row.status,
        status_history: metadata.status_history,
        priority: row.priority,
        due_at: metadata.due_at,
        created_by_user_id: row.creator_id,
        created_by_user_name: people[row.creator_id],
        assignee_user_id: row.assignee_id,
        assignee_name: row.assignee_id == null ? null : people[row.assignee_id],
        assignee_group_id: resource?.kind === 'group' ? String(resource.id) : null,
        assignee_group_name: resource?.kind === 'group' ? 'Release group' : null,
        assignee_agent_id: null,
        resource_participants: metadata.resource_participants,
        version: row.version,
        created_at: row.created_at,
        updated_at: row.updated_at,
        tags: [],
        sort_order: 0,
        completed_at: null,
        assignment_history: [
          {
            action: 'assign',
            by_user_id: 1,
            to_type: 'group',
            to_id: '3',
            to_name: 'Release group',
            at: issue.created_at,
          },
        ],
        edit_context: {
          participants: metadata.participants.map(user_id => ({
            user_id,
            user_name: people[user_id],
            direct: (metadata.direct_participants ?? metadata.participants).includes(user_id),
          })),
          resources: metadata.resource_participants ?? [],
          archived: metadata.archived,
          has_shared_source: false,
        },
      }
    }
    const get = vi.fn().mockImplementation(async (path: string) => {
      if (path.startsWith('/users/search?')) return { users: [] }
      if (path === detailPath) return detail(savedIssue)
      if (path === '/v1/loop-items/child' && savedChild) return detail(savedChild)
      if (path !== collaboratorsPath) throw new Error(`Unexpected GET ${path}`)
      return [
        {
          id: '2',
          loop_item_id: issue.id,
          user_id: 2,
          user_name: 'Reviewer',
          email: null,
          source: 'invitation',
          added_by_user_id: 1,
          created_at: issue.created_at,
        },
      ]
    })
    const api = {
      ...createPersonalIssuesApi({
        get,
        post: vi.fn(),
        patch: vi.fn(),
        delete: vi.fn(),
      }),
      comment: vi.fn().mockResolvedValue({ id: 'new-comment' }),
      create: vi.fn<PersonalIssuesApi['create']>().mockImplementation(
        async input =>
          (savedChild = {
            ...issue,
            id: 'child',
            parent_id: input.parent_id,
            title: input.title,
            description: input.description,
            assignee_id: input.assignee_id,
            metadata: {
              ...issue.metadata,
              participants: input.participants,
              assignee_resource: input.assignee_resource,
            },
          })
      ),
      updateWithParticipants: vi.fn<PersonalIssuesApi['updateWithParticipants']>(),
      updateDetail: vi
        .fn<PersonalIssuesApi['updateDetail']>()
        .mockImplementation(async (_, input) => {
          savedIssue = {
            ...savedIssue,
            version: input.version + 1,
            assignee_id: input.assignee_user_id ?? null,
            metadata: {
              ...savedIssue.metadata,
              assignee_resource: input.assignee_group_id
                ? { kind: 'group', id: Number(input.assignee_group_id) }
                : null,
            },
          }
          return unlinkedIssueFromDetail(detail(savedIssue))
        }),
      comments: vi.fn().mockResolvedValue([
        {
          messageId: 'comment-1',
          sequenceNumber: 1,
          projectId: '',
          taskId: issue.id,
          sender: { type: 'user', id: '2', name: issue.people[2] },
          type: 'text',
          content: 'Ready for review.',
          metadata: {},
          status: 'completed',
          createdAt: issue.created_at,
          updatedAt: issue.created_at,
        },
        {
          messageId: 'assistant-reply',
          sequenceNumber: 2,
          projectId: '',
          taskId: issue.id,
          sender: { type: 'agent', id: '2', name: 'Release assistant' },
          type: 'text',
          content: 'The checklist is complete.',
          metadata: { execution_dispatch: 'comment_only' },
          status: 'completed',
          createdAt: '2026-11-24T00:01:00.000000+00:00',
          updatedAt: '2026-11-24T00:01:00.000000+00:00',
        },
        {
          messageId: 'thread-reply',
          sequenceNumber: 3,
          projectId: '',
          taskId: issue.id,
          rootMessageId: 'comment-1',
          replyToMessageId: 'comment-1',
          sender: { type: 'user', id: '2', name: issue.people[2] },
          type: 'text',
          content: 'I added the review notes.',
          metadata: {},
          status: 'completed',
          createdAt: '2026-11-24T00:02:00.000000+00:00',
          updatedAt: '2026-11-24T00:02:00.000000+00:00',
        },
      ]),
    }
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      }
    )
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    const find = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
    try {
      await act(async () => {
        root.render(
          <IssueDetailDraftProvider scope="home">
            <IndependentIssueDialog
              api={api}
              attachments={attachments}
              userId={1}
              issueId={issue.id}
              presentation="embedded"
              onClose={() => {}}
              onSaved={() => {}}
              saveAttachment={saveAttachment}
            />
          </IssueDetailDraftProvider>
        )
      })
      expect(find('cloud-todo-detail-title')).toHaveProperty('value', issue.title)
      expect(find('cloud-todo-state-summary')?.textContent).toContain('Release group')
      expect(find('cloud-todo-detail-content')?.textContent).toContain(issue.description)
      expect(find('independent-issue-activity-list')?.textContent).toContain('Ready for review.')
      expect(find('cloud-task-activity-card-comment-1')?.textContent).toContain('Ready for review.')
      expect(find('cloud-task-activity-replies-comment-1')?.textContent).toContain(
        'I added the review notes.'
      )
      const reply = find('cloud-task-activity-message-assistant-reply')
      expect(
        reply?.closest('[data-testid="cloud-task-activity-card-assistant-reply"]')
      ).not.toBeNull()
      expect(reply?.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe(
        'Release assistant'
      )
      expect(reply?.textContent).toContain('The checklist is complete.')
      expect(find('cloud-task-activity-execution-badge-assistant-reply')).toBeNull()
      expect(find('cloud-task-status-event-0')?.textContent).toContain('Initial')
      expect(find('cloud-task-assignment-event-0')?.textContent).toContain('Release group')
      expect(find('task-comment-form-move')).toBeNull()
      expect(find('task-comment-form-assignment-mode')).not.toBeNull()
      expect(find('task-comment-form-send-actions')).not.toBeNull()
      expect(find('cloud-task-status-created')).toBeNull()
      expect(find('independent-issue-actions')).not.toBeNull()
      expect(get).toHaveBeenCalledWith(collaboratorsPath)
      const download = find('independent-issue-attachment-attachment-1')
      expect(download).not.toBeNull()
      await act(async () => download?.click())
      if (nativeDownload) {
        expect(downloadAttachment).toHaveBeenCalledWith('attachment-1', 'notes.txt')
        expect(saveAttachment).not.toHaveBeenCalled()
      } else {
        expect(attachments.read).toHaveBeenCalledWith('attachment-1')
        expect(saveAttachment).toHaveBeenCalledWith(file, 'notes.txt')
      }
      const addParticipant = find('cloud-todo-add-collaborator')
      expect(addParticipant).not.toBeNull()
      await act(async () => addParticipant?.click())
      expect(find('cloud-todo-collaborator-select')).not.toBeNull()
      await act(async () => find('independent-issue-actions')?.click())
      await act(async () => find('independent-issue-edit')?.click())
      const title = find('independent-issue-title')
      expect(title).not.toBeNull()
      expect(title?.closest('[data-testid="independent-issue-editor-scroll"]')).not.toBeNull()
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          title,
          'Discard this draft'
        )
        title?.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await act(async () => find('independent-issue-editor-cancel')?.click())
      expect(find('independent-issue-discard-dialog')).not.toBeNull()
      await act(async () => find('independent-issue-discard-confirm')?.click())
      expect(find('cloud-todo-detail-title')).toHaveProperty('value', issue.title)
      expect(api.updateDetail).not.toHaveBeenCalled()

      await act(async () => find('independent-issue-actions')?.click())
      await act(async () => find('independent-issue-edit')?.click())
      await act(async () => find('issue-participant-assignee-human:2')?.click())
      await act(async () => find('independent-issue-save')?.click())
      expect(api.updateDetail).toHaveBeenCalledExactlyOnceWith(issue.id, {
        assignee_user_id: 2,
        version: issue.version,
      })
      api.updateDetail.mockClear()
      const assign = find('task-comment-form-assignee')
      expect(assign).toBeInstanceOf(HTMLButtonElement)
      expect(assign?.querySelector('.task-detail-comment-action-value')?.textContent).toBe(
        'Reviewer'
      )
      await act(async () => assign?.click())
      const groupOption = find('task-comment-form-assignee-option-group:3')
      expect(groupOption).not.toBeNull()
      await act(async () => groupOption?.click())
      expect(assign?.querySelector('.task-detail-comment-action-value')?.textContent).toBe(
        'Release group'
      )
      expect(api.updateWithParticipants).not.toHaveBeenCalled()
      expect(api.updateDetail).not.toHaveBeenCalled()
      await act(async () => find('independent-issue-comment-send')?.click())
      expect(get).toHaveBeenCalledWith(detailPath)
      expect(api.updateDetail).toHaveBeenCalledExactlyOnceWith(
        issue.id,
        expect.objectContaining({ version: issue.version + 1, assignee_group_id: '3' })
      )
      expect(find('task-comment-form-assignee')?.textContent).toContain('Release group')
      expect(find('cloud-todo-state-assignee')?.textContent).toContain('Release group')
      const mode = find('task-comment-form-assignment-mode')
      expect(mode?.dataset.assignmentMode).toBe('current')
      expect(mode?.getAttribute('aria-label')).toContain('Assign current Issue')
      expect(mode?.textContent).toBe('')
      await act(async () => mode?.click())
      expect(find('task-comment-form-create-child')).not.toBeNull()
      await act(async () => find('task-comment-form-create-child')?.click())
      expect(mode?.dataset.assignmentMode).toBe('child')
      expect(mode?.getAttribute('aria-label')).toContain('Create child Issue')
      expect(mode?.textContent).toBe('')
      expect(find('task-comment-form-assignee')?.textContent).not.toContain('Release group')
      const comment = find('independent-issue-comment') as HTMLTextAreaElement
      const body = 'Follow up on the rollout'
      await act(async () => {
        comment.value = body
        comment.dispatchEvent(new KeyboardEvent('keyup', { key: 't', bubbles: true }))
      })
      await act(async () => find('independent-issue-comment-send')?.click())
      expect(api.create).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          parent_id: issue.id,
          request_id: expect.any(String),
          title: body,
          participants: [],
        })
      )
      expect(get).toHaveBeenCalledWith('/v1/loop-items/child')
    } finally {
      await act(async () => root.unmount())
      host.remove()
      vi.unstubAllGlobals()
    }
  }
)

it.each(['plain', 'share', 'attachment'] as const)(
  'submits the same draft fields with a selected project (%s)',
  async mode => {
    const share = mode === 'share'
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      }
    )
    const title = 'New project Issue'
    const description = 'Follow up on the rollout'
    const source = { device_id: 'device', task_id: 'task', title: 'Conversation' }
    const excerpt = { id: 'message', role: 'assistant' as const, content: 'keep this excerpt only' }
    const file = new File(['notes'], 'notes.txt')
    const loadFile = vi.fn().mockResolvedValue(file)
    const saved: IndependentIssue = {
      id: 'new',
      title,
      description,
      status: 'pending',
      priority: 'medium',
      creator_id: 1,
      assignee_id: 1,
      version: 1,
      created_at: '2026-11-24T00:00:00Z',
      updated_at: '2026-11-24T00:00:00Z',
      people: { 1: 'Owner' },
      metadata: { participants: [], archived: false, due_at: null },
    }
    const create = vi.fn().mockResolvedValue(saved)
    const updatedDescription = `${description} Review the latest notes.`
    const updateDetail = vi
      .fn()
      .mockResolvedValue({ ...saved, description: updatedDescription, version: 2 })
    const associate = vi.fn().mockResolvedValue({ project_id: '41', issue_id: 'new' })
    const createInProject = vi
      .fn()
      .mockRejectedValueOnce(new Error('Project temporarily unavailable'))
      .mockResolvedValue({ project_id: '41', issue_id: 'new' })
    const createShared = vi.fn().mockResolvedValue({ id: 'new', project_id: '41' })
    const onOpenProjectIssue = vi.fn()
    const api = {
      ...createPersonalIssuesApi({
        get: vi.fn(),
        post: vi.fn(),
        patch: vi.fn(),
        delete: vi.fn(),
      }),
      create,
      createInProject,
      updateDetail,
      associate,
      createShared,
      projects: vi.fn().mockResolvedValue({
        items: [
          {
            id: '41',
            name: 'Release project',
            project_store: 'backend',
            task_provider: 'backend',
            access_role: 'Developer',
            board_config: { statuses: [{ id: 'ready', name: 'Ready' }] },
          },
        ],
      }),
    }
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    const find = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
    const editField = (id: string, value: string) => {
      const element = find(id)
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement))
        throw new Error(`Missing ${id}`)
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')!.set!.call(
        element,
        value
      )
      element.dispatchEvent(new Event('input', { bubbles: true }))
    }
    try {
      await act(async () => {
        root.render(
          <IndependentIssueDialog
            api={api}
            userId={1}
            issueId={null}
            presentation="embedded"
            shareDraft={
              share
                ? {
                    title,
                    source,
                    requestId: 'share',
                    conversationFiles: [{ id: 'file', name: 'notes.txt', load: loadFile }],
                    excerpts: [excerpt],
                    selectedExcerpt: { excerpt, start: 0, end: 17, followingMessageIds: [] },
                  }
                : undefined
            }
            ShareFiles={({ children, onChange, onSelectConversationFiles }) => (
              <>
                {children}
                <button
                  type="button"
                  data-testid="select-source-file"
                  onClick={() => (share ? onSelectConversationFiles(['file']) : onChange([file]))}
                >
                  Select source file
                </button>
              </>
            )}
            onClose={() => {}}
            onSaved={() => {}}
            onOpenProjectIssue={onOpenProjectIssue}
            saveAttachment={async () => {}}
          />
        )
      })
      await act(async () => {
        editField('independent-issue-title', title)
        editField('independent-issue-description', description)
        find('independent-issue-project')?.click()
      })
      expect(find('independent-issue-project-option-41')).not.toBeNull()
      await act(async () => find('independent-issue-project-option-41')?.click())
      if (mode !== 'plain') await act(async () => find('select-source-file')?.click())
      expect(find('independent-issue-title')).toHaveProperty('value', title)
      expect(find('independent-issue-description')).toHaveProperty('value', description)
      await act(async () => find('independent-issue-save')?.click())
      if (share) {
        expect(createShared).toHaveBeenCalledExactlyOnceWith(
          'share',
          source,
          expect.objectContaining({
            title,
            description: expect.stringContaining('keep this excerpt'),
          }),
          [file],
          '41',
          'ready'
        )
        expect(createShared.mock.calls[0][2].description).toContain(description)
        expect(createShared.mock.calls[0][2].description).not.toContain('only')
        expect(create).not.toHaveBeenCalled()
      } else if (mode === 'attachment') {
        expect(createShared).toHaveBeenCalledExactlyOnceWith(
          expect.any(String),
          undefined,
          expect.objectContaining({ title, description }),
          [file],
          '41',
          'ready'
        )
        expect(create).not.toHaveBeenCalled()
        expect(createInProject).not.toHaveBeenCalled()
      } else {
        expect(host.querySelector('[role="alert"]')?.textContent).toContain(
          'Project temporarily unavailable'
        )
        expect(find('independent-issue-title')).toHaveProperty('value', title)
        expect(find('independent-issue-description')).toHaveProperty('value', description)
        await act(async () => editField('independent-issue-description', updatedDescription))
        await act(async () => find('independent-issue-save')?.click())
        expect(create).not.toHaveBeenCalled()
        expect(updateDetail).not.toHaveBeenCalled()
        expect(associate).not.toHaveBeenCalled()
        const requestId = createInProject.mock.calls[0][3]
        expect(requestId).toEqual(expect.any(String))
        expect(createInProject.mock.calls).toEqual([
          [expect.objectContaining({ title, description }), '41', 'ready', requestId],
          [
            expect.objectContaining({ title, description: updatedDescription }),
            '41',
            'ready',
            requestId,
          ],
        ])
        expect(createShared).not.toHaveBeenCalled()
      }
      expect(onOpenProjectIssue).toHaveBeenCalledOnce()
    } finally {
      await act(async () => root.unmount())
      host.remove()
      vi.unstubAllGlobals()
    }
  }
)
