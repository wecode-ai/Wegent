// @vitest-environment node

import { describe, expect, it } from 'vitest'
import type { WorkspaceIssueCollaborator } from '@wegent/collaboration'
import { newStandInRole } from '@/api/personalStandIn'
import {
  selectAssistantSummary,
  selectPrivateConversations,
  selectProjectScopes,
  selectTaskRows,
  selectTaskTimeline,
} from './selectors'
import {
  experienceBindingFixture as binding,
  experienceHumanRequestFixture as request,
  experienceIssueFixture as issue,
  experienceMessageFixture as message,
  experienceProjectFixture as project,
  experienceRuntimeFixture as runtime,
  experienceStandInFixture as standIn,
} from './fixtures'
import type { ExperienceReadModelInput, ExperienceTimelineInput } from './types'

function modelInput(overrides: Partial<ExperienceReadModelInput> = {}): ExperienceReadModelInput {
  return {
    viewer: 7,
    projects: [{ project: project(), issues: [issue()], taskBindings: [binding()] }],
    ...overrides,
  }
}

function timelineInput(overrides: Partial<ExperienceTimelineInput> = {}): ExperienceTimelineInput {
  return {
    project: project(),
    issue: issue(),
    viewer: 7,
    messages: [message()],
    taskBindings: [binding()],
    ...overrides,
  }
}

describe('experience task read model', () => {
  it('uses local native readers for pending human requests and manual sharing without widening cloud', () => {
    const pending = issue({
      id: 'native-pending',
      assignee_user_id: 8,
      human_requests: [request({ issue_id: 'native-pending', recipient_user_id: 0 })],
    })
    const shared = issue({ id: 'native-shared', assignee_user_id: 8 })
    const collaborators: WorkspaceIssueCollaborator[] = [
      {
        id: 'native-share',
        issueId: shared.id,
        userId: 0,
        userName: 'Local',
        email: null,
        source: 'manual',
        addedByUserId: 7,
        createdAt: '',
      },
    ]
    const rows = selectTaskRows(
      modelInput({
        projects: (['local', 'backend'] as const).map(store => ({
          project: project({ project_store: store }),
          participationViewer: [0, 7],
          issues: [pending, shared],
          collaborators,
        })),
      })
    )
    expect(rows.map(row => [row.project.store, row.id, row.needsUser])).toEqual([
      ['local', 'native-pending', true],
      ['local', 'native-shared', false],
    ])
  })

  it('keeps local native and profile participation separate from the cloud reader', () => {
    const candidates = [0, 7, 8].map(id => issue({ id: `owner-${id}`, assignee_user_id: id }))
    const input = modelInput({
      projects: [
        {
          project: project({ project_store: 'local' }),
          participationViewer: [0, 7],
          issues: candidates,
        },
        { project: project(), participationViewer: [0, 7], issues: candidates },
      ],
    })
    expect(selectTaskRows(input).map(row => [row.project.store, row.id])).toEqual([
      ['local', 'owner-0'],
      ['local', 'owner-7'],
      ['backend', 'owner-7'],
    ])
    expect(
      selectTaskRows({
        ...input,
        projects: [{ ...input.projects[0], participationViewer: [] }],
      })
    ).toEqual([])
  })

  it('keeps local and backend shapes identical apart from the explicit source identity', () => {
    const backend = selectTaskRows(modelInput())[0]
    const local = selectTaskRows(
      modelInput({
        projects: [
          {
            project: project({ project_store: 'local' }),
            issues: [issue()],
            taskBindings: [binding()],
          },
        ],
      })
    )[0]
    const { key: backendKey, project: backendProject, ...backendFields } = backend
    const { key: localKey, project: localProject, ...localFields } = local
    expect(localFields).toEqual({
      ...backendFields,
      conversations: {
        ...backendFields.conversations,
        items: backendFields.conversations.items.map(item => ({
          ...item,
          issueSource: { ...item.issueSource!, projectStore: 'local' },
        })),
      },
    })
    expect(backendKey).not.toBe(localKey)
    expect(localProject).toEqual({
      ...backendProject,
      key: '["local","project-1"]',
      store: 'local',
    })
  })

  it('uses existing handoff relevance rather than project membership, AI activity, or an invented sharing flag', () => {
    const unrelated = issue({ id: 'unrelated', created_by_user_id: 8, assignee_user_id: 8 })
    const running = issue({ id: 'running', execution_state: 'running' })
    const mine = issue({
      id: 'mine',
      created_by_user_id: 8,
      assignee_user_id: 8,
      human_requests: [request()],
    })
    const input = modelInput({
      projects: [{ project: project(), issues: [unrelated, running, mine] }],
    })
    expect(selectTaskRows(input).map(row => row.id)).toEqual(['running', 'mine'])
    expect(selectTaskRows(input, { relevance: 'all' }).map(row => row.id)).toEqual([
      'unrelated',
      'running',
      'mine',
    ])
    expect(selectTaskRows(input)[1]).toMatchObject({
      needsUser: true,
      waitingFor: [{ id: 7, name: 'Member' }],
      waitingSince: '2026-11-02T00:00:00Z',
    })
    expect(selectTaskRows(input, { relevance: 'all' })[1].waitingFor).toEqual([])
  })

  it('uses each project current principal, including local zero, without borrowing a cloud identity', () => {
    const input = modelInput({
      viewer: 86,
      projects: [
        {
          project: project({ project_store: 'local', current_user_id: 0 }),
          issues: [issue({ created_by_user_id: 0, assignee_user_id: 0 })],
        },
        {
          project: project({ current_user_id: 86 }),
          issues: [issue({ created_by_user_id: 0, assignee_user_id: 0 })],
        },
      ],
    })
    expect(selectTaskRows(input).map(row => row.project.store)).toEqual(['local'])
  })

  it('keeps actual ownership related across running and completed states without inventing membership relevance', () => {
    const input = modelInput({
      projects: [
        {
          project: project(),
          issues: [
            issue({ id: 'owned-running', execution_state: 'running' }),
            issue({ id: 'owned-completed', status: 'completed' }),
            issue({ id: 'unassigned-member', assignee_user_id: null, created_by_user_id: 8 }),
            issue({
              id: 'unassigned-handoff',
              assignee_user_id: null,
              created_by_user_id: 8,
              human_requests: [request()],
            }),
          ],
        },
      ],
    })
    expect(selectTaskRows(input).map(row => [row.id, row.needsUser])).toEqual([
      ['owned-running', false],
      ['owned-completed', false],
      ['unassigned-handoff', true],
    ])
  })

  it('requires an exact manual sharing record for the per-project viewer', () => {
    const shared = issue({ created_by_user_id: 8, assignee_user_id: 8 })
    const collaborator: WorkspaceIssueCollaborator = {
      id: 'collaborator-1',
      issueId: shared.id,
      userId: 7,
      userName: 'Member',
      email: null,
      source: 'manual',
      addedByUserId: 8,
      createdAt: '2026-11-02T00:00:00Z',
    }
    const rows = (overrides: Partial<WorkspaceIssueCollaborator>) =>
      selectTaskRows(
        modelInput({
          viewer: 86,
          projects: [
            {
              project: project({ current_user_id: 7 }),
              issues: [shared],
              collaborators: [{ ...collaborator, ...overrides }],
            },
          ],
        })
      )
    expect(rows({}).map(row => row.id)).toEqual([shared.id])
    expect(rows({ source: 'task' })).toEqual([])
    expect(rows({ source: 'delivery' })).toEqual([])
    expect(rows({ userId: 86 })).toEqual([])
    expect(rows({ issueId: 'different-issue' })).toEqual([])
  })

  it('emits one row per Issue while retaining every exact owned device/task and binding reference', () => {
    const first = binding()
    const second = binding({ id: 'binding-2', deviceId: 'device-2', taskId: 'task-1' })
    const third = binding({ id: 'binding-3', deviceId: 'device-1', taskId: 'task-1' })
    const item = { ...issue(), task_bindings: [first, second] }
    const input = modelInput({
      runtimeWork: runtime(),
      projects: [
        { project: project(), issues: [item], taskBindings: [third] },
        { project: project(), issues: [issue()], taskBindings: [first] },
      ],
    })
    const rows = selectTaskRows(input)
    expect(rows).toHaveLength(1)
    expect(rows[0].conversations.items).toHaveLength(2)
    expect(
      rows[0].conversations.items
        .find(item => item.address.deviceId === 'device-1')
        ?.bindingIds.sort()
    ).toEqual(['binding-1', 'binding-3'])
    expect(rows[0].conversations.items.map(item => item.address.taskId)).toEqual([
      'task-1',
      'task-1',
    ])
  })

  it('does not leak inaccessible titles, summaries, private bindings, or true hidden counts', () => {
    const secret = issue({
      id: 'SECRET-ID',
      title: 'SECRET-TITLE',
      description: 'SECRET-BODY',
      can_view_detail: false,
    })
    const input = modelInput({ projects: [{ project: project(), issues: [issue(), secret] }] })
    expect(selectTaskRows(input)).toHaveLength(1)
    expect(selectProjectScopes(input)[0]).toMatchObject({ taskCount: 1, needsUserCount: 1 })
    expect(JSON.stringify([selectTaskRows(input), selectProjectScopes(input)])).not.toContain(
      'SECRET'
    )
  })

  it('prefers the current Issue version and retains a same-version explicit denial', () => {
    const input = modelInput({
      projects: [
        {
          project: project(),
          issues: [
            issue({ title: 'Old title', version: 1 }),
            issue({ title: 'Current title', version: 2 }),
          ],
        },
      ],
    })
    expect(selectTaskRows(input)[0].title).toBe('Current title')
    input.projects = [{ project: project(), issues: [issue({ can_view_detail: false }), issue()] }]
    expect(selectTaskRows(input)).toEqual([])
  })

  it('combines project, status, relevance and case-insensitive search without losing other filters', () => {
    const input = modelInput({
      projects: [
        {
          project: project(),
          issues: [issue(), issue({ id: 'EXP-2', status: 'completed', title: 'Other' })],
        },
      ],
    })
    expect(
      selectTaskRows(input, {
        projectKey: '["backend","project-1"]',
        statuses: ['pending'],
        search: 'IMPLEMENT',
      })
    ).toHaveLength(1)
    expect(selectTaskRows(input, { projectKey: '["local","project-1"]' })).toEqual([])
    expect(selectTaskRows(input, { statuses: ['completed'] }).map(row => row.id)).toEqual(['EXP-2'])
    expect(
      selectTaskRows(input, { relevance: 'all', statuses: ['completed'] }).map(row => row.id)
    ).toEqual(['EXP-2'])
  })
})

describe('experience private conversation references', () => {
  it('keeps exact Issue source identity for cross-entry conversation navigation', () => {
    expect(selectPrivateConversations(timelineInput()).items[0].issueSource).toEqual({
      projectStore: 'backend',
      projectId: 'project-1',
      issueId: 'EXP-1',
    })
  })
  it('never substitutes an unrelated latest runtime task when an exact binding is missing', () => {
    const selection = selectPrivateConversations({
      ...timelineInput(),
      taskBindings: [binding({ taskId: 'missing', taskTitle: null, linkedAt: '' })],
      runtimeWork: runtime([{ taskId: 'newest-task', title: 'DO NOT USE' }]),
    })
    expect(selection.items[0]).toMatchObject({
      address: { deviceId: 'device-1', taskId: 'missing' },
      title: null,
      linkedAt: null,
    })
    expect(JSON.stringify(selection)).not.toContain('newest-task')
  })

  it('redacts other owners and returns unknown for unavailable bindings without guessing permissions', () => {
    expect(selectPrivateConversations({ ...timelineInput(), taskBindings: undefined })).toEqual({
      state: 'unknown',
      items: [],
    })
    const hidden = selectPrivateConversations({
      ...timelineInput(),
      taskBindings: [binding({ taskUserId: 8, taskTitle: 'SECRET-PRIVATE-TITLE' })],
    })
    expect(hidden).toEqual({ state: 'hidden', items: [] })
    expect(JSON.stringify(hidden)).not.toContain('SECRET')
    expect(
      selectPrivateConversations({
        ...timelineInput(),
        taskBindings: [binding({ issueId: 'other-issue' })],
      })
    ).toEqual({ state: 'ready', items: [] })
  })
})

describe('experience canonical timeline', () => {
  it('keeps a missing local reader unknown while proven foreign ownership stays hidden', () => {
    const input = timelineInput({
      project: project({ project_store: 'local' }),
      participationViewer: [],
      taskBindings: [binding({ taskUserId: 0 })],
      messages: [
        message({
          sender: { type: 'user', id: '0', name: 'Local' },
          runtimeAddress: { deviceId: 'device-1', taskId: 'task-1' },
        }),
      ],
    })
    expect(selectPrivateConversations(input)).toEqual({ state: 'unknown', items: [] })
    expect(selectTaskTimeline(input).nodes[0].conversation).toEqual({ state: 'unknown', items: [] })
    const foreign = {
      ...input,
      participationViewer: [7],
    }
    expect(selectPrivateConversations(foreign)).toEqual({ state: 'hidden', items: [] })
    expect(selectTaskTimeline(foreign).nodes[0].conversation).toEqual({
      state: 'hidden',
      items: [],
    })
  })

  it('binds a current-profile source message to its existing native-zero owned task', () => {
    const input = timelineInput({
      project: project({ project_store: 'local' }),
      participationViewer: [0, 7],
      taskBindings: [binding({ taskUserId: 0 })],
      messages: [
        message({
          sender: { type: 'user', id: '7', name: 'Current profile' },
          runtimeAddress: { deviceId: 'device-1', taskId: 'task-1' },
          metadata: { runtime_turn_id: 'native-source-turn' },
        }),
      ],
    })
    expect(selectTaskTimeline(input).nodes[0].conversation.items[0]).toMatchObject({
      ownerUserId: 0,
      historySource: { turnId: 'native-source-turn' },
    })
  })

  it.each([
    ['local', 0, true],
    ['local', 7, true],
    ['local', 8, false],
    ['backend', 0, false],
    ['backend', 7, true],
    ['backend', 8, false],
  ] as const)('proves %s source ownership for native author %s', (store, owner, allowed) => {
    const input = timelineInput({
      project: project({ project_store: store }),
      participationViewer: [0, 7],
      taskBindings: [binding({ taskUserId: owner })],
      messages: [
        message({
          sender: { type: 'user', id: String(owner), name: 'Source author' },
          runtimeAddress: { deviceId: 'device-1', taskId: 'task-1' },
          metadata: { runtime_turn_id: 'native-source-turn' },
        }),
      ],
    })
    const conversation = selectTaskTimeline(input).nodes[0].conversation
    expect(conversation.items).toHaveLength(allowed ? 1 : 0)
    expect(selectPrivateConversations(input).items).toHaveLength(allowed ? 1 : 0)
    if (allowed)
      expect(conversation.items[0]).toMatchObject({
        ownerUserId: owner,
        historySource: { turnId: 'native-source-turn' },
      })
  })

  it('includes persisted handoffs and status changes once, retaining user attribution and immutable order', () => {
    const assignment = {
      by_user_id: 7,
      to_type: 'user' as const,
      to_id: '8',
      to_name: 'Recipient',
      action: 'assign' as const,
      at: '2026-10-30T00:00:00Z',
      automation: { rule_id: 'SECRET-RULE', rule_name: 'SECRET-NAME', run_id: 'SECRET-RUN' },
    }
    const status = {
      by_user_id: 7,
      from_status: 'pending',
      to_status: 'in_progress',
      trigger: 'manual',
      at: '2026-10-31T00:00:00Z',
    }
    const input = timelineInput({
      issue: issue({ assignment_history: [assignment, assignment], status_history: [status] }),
    })
    const result = selectTaskTimeline(input)
    expect(result.nodes.map(node => node.kind)).toEqual(['handoff', 'status', 'comment'])
    expect(result.nodes[0]).toMatchObject({
      sequenceNumber: null,
      author: { id: '7', name: null },
      handoff: { targetId: '8', targetName: 'Recipient' },
    })
    expect(result.nodes[1].transition).toEqual({ from: 'pending', to: 'in_progress' })
    expect(JSON.stringify(result)).not.toContain('SECRET')
    expect(
      selectTaskTimeline({
        ...input,
        issue: { ...input.issue!, updated_at: '2026-12-01T00:00:00Z', execution_state: 'running' },
      }).nodes.map(node => node.id)
    ).toEqual(result.nodes.map(node => node.id))
  })

  it('uses native assignment records only when embedded history is absent and never copies their comment body', () => {
    const assignment = {
      id: 'assignment-1',
      issue_id: 'EXP-1',
      target_type: 'human' as const,
      target_id: '8',
      target_name: 'Recipient',
      body: 'DO NOT DUPLICATE THIS COMMENT',
      comment_id: 'comment-1',
      created_by_user_id: 7,
      created_by_user_name: 'Member',
      status: 'active' as const,
      created_at: '',
      updated_at: '2026-11-05T00:00:00Z',
    }
    const fallback = selectTaskTimeline(
      timelineInput({
        assignments: [assignment, assignment, { ...assignment, id: 'other', issue_id: 'OTHER' }],
      })
    )
    expect(fallback.nodes.filter(node => node.kind === 'handoff')).toEqual([
      expect.objectContaining({
        id: 'history:assignment:assignment-1',
        at: null,
        body: null,
        author: { id: '7', name: 'Member' },
      }),
    ])
    expect(JSON.stringify(fallback)).not.toContain('DO NOT DUPLICATE')
    const embedded = selectTaskTimeline(
      timelineInput({ issue: issue({ assignment_history: [] }), assignments: [assignment] })
    )
    expect(embedded.nodes.filter(node => node.kind === 'handoff')).toEqual([])
  })

  it('uses only current project+Issue ProjectChat messages, preserving canonical sequence and avoiding duplicate updates', () => {
    const newer = message({ messageId: 'second', sequenceNumber: 2 })
    const original = message({ status: 'pending' })
    const updated = message({ sequenceNumber: 99, updatedAt: '2026-11-03T00:00:00Z' })
    const result = selectTaskTimeline(
      timelineInput({
        messages: [
          newer,
          original,
          message({ projectId: 'other' }),
          message({ messageId: 'another-issue', taskId: 'other' }),
          message({ messageId: 'project-chat', taskId: null }),
          updated,
        ],
      })
    )
    expect(result.nodes.map(node => [node.id, node.sequenceNumber, node.status])).toEqual([
      ['message-1', 1, 'completed'],
      ['second', 2, 'completed'],
    ])
  })

  it('keeps absent streams and denied Issues explicitly unavailable without leaking existing source data', () => {
    expect(selectTaskTimeline(timelineInput({ messages: null }))).toEqual({
      state: 'unknown',
      nodes: [],
    })
    expect(selectTaskTimeline(timelineInput({ issue: null }))).toEqual({
      state: 'unknown',
      nodes: [],
    })
    const hidden = selectTaskTimeline(
      timelineInput({
        issue: issue({ title: 'SECRET-TITLE', can_view_detail: false }),
        messages: [message({ content: '[SECRET-FILE](wegent://attachments/secret)' })],
      })
    )
    expect(hidden).toEqual({ state: 'hidden', nodes: [] })
    expect(JSON.stringify(hidden)).not.toContain('SECRET')
  })

  it('binds a historical user node only through its exact related execution, never the newest conversation', () => {
    const run = message({
      messageId: 'run',
      sequenceNumber: 2,
      sender: { type: 'agent', id: 'agent', name: 'PRIVATE-ASSISTANT' },
      rootMessageId: 'message-1',
      triggerMessageId: 'message-1',
      runtimeAddress: { deviceId: 'device-1', taskId: 'historical' },
    })
    const result = selectTaskTimeline(
      timelineInput({
        messages: [run, message()],
        taskBindings: [
          binding({ taskId: 'newest' }),
          binding({ id: 'history', taskId: 'historical' }),
        ],
      })
    )
    expect(result.nodes[0].conversation.items.map(item => item.address.taskId)).toEqual([
      'historical',
    ])
    expect(result.nodes[0].conversation.items[0].sourceNodeIds).toEqual(['message-1'])
    expect(result.nodes[1].conversation.items[0].sourceNodeIds).toEqual(['run'])
  })

  it('requires the original human source and rejects other users nodes even when a binding belongs to the viewer', () => {
    const address = { deviceId: 'device-1', taskId: 'task-1' }
    const orphan = message({
      sender: { type: 'agent', id: 'agent', name: 'Assistant' },
      rootMessageId: 'missing-root',
      runtimeAddress: address,
    })
    expect(selectTaskTimeline(timelineInput({ messages: [orphan] })).nodes[0].conversation).toEqual(
      { state: 'unknown', items: [] }
    )
    const other = message({
      sender: { type: 'user', id: '8', name: 'Other member' },
      runtimeAddress: address,
    })
    expect(selectTaskTimeline(timelineInput({ messages: [other] })).nodes[0].conversation).toEqual({
      state: 'hidden',
      items: [],
    })
  })

  it('keeps native turn proof and original user message identities without inventing a historical range', () => {
    const user = message({ clientMessageId: 'native-user-message' })
    const run = message({
      messageId: 'run',
      sequenceNumber: 2,
      sender: { type: 'agent', id: 'agent', name: 'Assistant' },
      triggerMessageId: user.messageId,
      metadata: { runtime_turn_id: 'native-turn' },
      runtimeAddress: { deviceId: 'device-1', taskId: 'task-1' },
    })
    const nodes = selectTaskTimeline(timelineInput({ messages: [user, run] })).nodes
    expect(nodes[1].conversation.items[0].historySource).toEqual({
      turnId: 'native-turn',
      userMessageIds: ['message-1', 'native-user-message'],
    })
    expect(nodes[0].conversation.items[0].historySource).toEqual({
      turnId: null,
      userMessageIds: ['message-1', 'native-user-message'],
    })
  })

  it('does not use another user reply as an execution source for a user node', () => {
    const reply = message({
      messageId: 'other-reply',
      sender: { type: 'user', id: '8', name: 'Other member' },
      replyToMessageId: 'message-1',
      runtimeAddress: { deviceId: 'device-1', taskId: 'task-1' },
    })
    expect(
      selectTaskTimeline(timelineInput({ messages: [message(), reply] })).nodes[0].conversation
    ).toEqual({ state: 'unknown', items: [] })
  })

  it('attributes shared execution to its proven user and strips assistant prompts, arbitrary metadata and full private execution body', () => {
    const run = message({
      messageId: 'run',
      sequenceNumber: 2,
      sender: { type: 'agent', id: 'assistant', name: 'PRIVATE-ASSISTANT' },
      rootMessageId: 'message-1',
      content: 'PRIVATE-EXECUTION-BODY',
      metadata: { prompt: 'PRIVATE-PROMPT', privateArguments: 'PRIVATE-ARGS' },
      runtimeAddress: {
        deviceId: 'device-1',
        taskId: 'task-1',
        runtimeHandle: { secret: 'PRIVATE-HANDLE' },
      },
    })
    const nodes = selectTaskTimeline(timelineInput({ messages: [message(), run] })).nodes
    expect(nodes[1]).toMatchObject({
      kind: 'execution',
      body: null,
      author: { id: '7', name: 'Member' },
      executionAddress: { deviceId: 'device-1', taskId: 'task-1' },
    })
    expect(JSON.stringify(nodes)).not.toContain('PRIVATE-')
  })

  it('retains verified attachment provenance and unknown timestamps without guessing a current discussion', () => {
    const result = selectTaskTimeline(
      timelineInput({
        messages: [
          message({
            createdAt: '',
            content: '[Report](wegent://attachments/file-1)\n<!-- wegent-attachment:file-1 -->',
          }),
        ],
      })
    )
    expect(result.nodes[0]).toMatchObject({
      at: null,
      attachments: [{ id: 'file-1', name: 'Report', sourceNodeId: 'message-1' }],
      conversation: { state: 'unknown', items: [] },
    })
  })
})

describe('experience assistant summary', () => {
  it('retains independently proven own discussions when assistant settings fail without exposing another owner', () => {
    const conversation = selectPrivateConversations(timelineInput()).items[0]
    const result = selectAssistantSummary({
      viewer: 7,
      settings: undefined,
      conversations: [
        conversation,
        { ...conversation, ownerUserId: 8, title: 'SECRET other owner discussion' },
      ],
    })
    expect(result.state).toBe('unknown')
    expect(result.roles).toEqual([])
    expect(result.pendingDecisions).toEqual([])
    expect(result.recentDiscussions).toEqual([conversation])
    expect(result.recentDiscussions[0].address).toEqual(conversation.address)
    expect(result.recentDiscussions[0].issueSource).toEqual(conversation.issueSource)
    expect(result.recentDiscussions[0]).not.toBe(conversation)
    expect(JSON.stringify(result)).not.toContain('SECRET')
  })

  it('derives decisions from pending proposals and keeps prompts/configuration outside the presentation model', () => {
    const settings = standIn()
    const result = selectAssistantSummary({
      viewer: 7,
      settings,
      proposals: [
        { id: 'pending', summary: 'Please choose', settings, status: 'pending' },
        { id: 'accepted', summary: 'Already handled', settings, status: 'accepted' },
        {
          id: 'other-user',
          summary: 'SECRET-PROPOSAL',
          settings: standIn({ userId: 8 }),
          status: 'pending',
        },
      ],
    })
    expect(result.roles).toEqual([{ id: null, name: null, enabled: true, isDefault: true }])
    expect(result.pendingDecisions).toEqual([
      { id: 'pending', summary: 'Please choose', roleId: null },
    ])
    expect(JSON.stringify(result)).not.toMatch(/Private|SECRET/)
  })

  it('projects the native implicit primary separately from the initial disabled default role', () => {
    const settings = standIn({
      version: 0,
      primary: undefined,
      roles: [newStandInRole('device-1', 'default')],
    })
    expect(selectAssistantSummary({ viewer: 7, settings }).roles).toEqual([
      { id: null, name: null, enabled: true, isDefault: true },
      { id: 'default', name: null, enabled: false, isDefault: false },
    ])
    expect(settings.primary).toBeUndefined()
    expect(settings.roles[0].enabled).toBe(false)
  })

  it('preserves an explicitly disabled primary rather than enabling its intake', () => {
    const settings = standIn()
    settings.primary!.enabled = false
    expect(selectAssistantSummary({ viewer: 7, settings }).roles).toEqual([
      { id: null, name: null, enabled: false, isDefault: true },
    ])
  })

  it('does not project an implicit primary without owned settings or reveal another owner', () => {
    expect(selectAssistantSummary({ viewer: 7, settings: undefined }).state).toBe('unknown')
    expect(selectAssistantSummary({ viewer: 7, settings: undefined }).roles).toEqual([])
    expect(selectAssistantSummary({ viewer: 7, settings: null }).roles).toEqual([])
    const settings = standIn({
      userId: 8,
      primary: undefined,
      roles: [{ ...newStandInRole('device-1', 'default'), name: 'SECRET role' }],
    })
    expect(selectAssistantSummary({ viewer: 7, settings })).toEqual({
      state: 'hidden',
      roles: [],
      pendingDecisions: [],
      recentDiscussions: [],
      work: [],
    })
  })
})
