import { describe, expect, it } from 'vitest'
import type { RuntimeTaskSummary } from '@/types/api'
import {
  experienceBindingFixture as binding,
  experienceHumanRequestFixture as humanRequest,
  experienceIssueFixture as issue,
  experienceProjectFixture as project,
  experienceRuntimeFixture as runtime,
} from './fixtures'
import { selectTaskRows } from './taskSelectors'
import { selectExperienceWorkSnapshot } from './workSnapshotSelectors'
import type { ExperienceReadModelInput } from './types'

const origin = {
  initiatedBy: 'stand_in',
  projectStore: 'local',
  cloudProjectId: 'project-1',
  loopItemId: 'EXP-1',
  userId: 7,
  roleName: 'Development',
}

function input(task: Partial<RuntimeTaskSummary> = {}): ExperienceReadModelInput {
  return {
    viewer: 7,
    projects: [
      {
        project: project({ project_store: 'local' }),
        participationViewer: [0, 7],
        issues: [issue({ created_by_user_id: 0, assignee_user_id: null, status: 'in_progress' })],
        taskBindings: [binding({ taskUserId: 0 })],
      },
    ],
    runtimeWork: runtime([{ running: true, runtimeHandle: { origin }, ...task }]),
  }
}

function state(value: ExperienceReadModelInput) {
  const rows = selectTaskRows(value)
  const snapshot = selectExperienceWorkSnapshot({ roles: [], work: [], rows })
  return { rows, snapshot }
}

describe('bound native Issue execution projection', () => {
  it('shows an unassigned native creator Issue as running from its exact stand-in binding', () => {
    const value = input()
    value.projects = [
      {
        ...value.projects[0],
        taskBindings: undefined,
        issues: value.projects[0].issues.map(item => ({
          ...item,
          task_bindings: [binding({ taskUserId: 0 })],
        })),
      },
    ]
    const { rows, snapshot } = state(value)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      needsUser: false,
      waitingSince: null,
      waitingFor: [],
      executionState: 'running',
    })
    expect(snapshot.counts).toEqual({ waiting: 0, running: 1, completed: 0 })
    expect(snapshot.current?.taskRow?.id).toBe('EXP-1')
    expect(value.projects[0].issues[0].execution_state).toBeUndefined()
    expect(selectTaskRows({ ...value, runtimeWork: null })[0].needsUser).toBe(true)
  })

  it.each(['cloud', 'backend'])(
    'uses the explicit %s cloud origin without borrowing local zero',
    store => {
      const value = input({ runtimeHandle: { origin: { ...origin, projectStore: store } } })
      value.projects = [
        {
          ...value.projects[0],
          project: project({ project_store: 'backend' }),
          issues: [issue({ assignee_user_id: 7, status: 'in_progress' })],
          taskBindings: [binding()],
        },
      ]
      expect(state(value).rows[0]).toMatchObject({ needsUser: false, executionState: 'running' })
      value.projects = [
        {
          ...value.projects[0],
          issues: [issue({ created_by_user_id: 0, assignee_user_id: null })],
        },
      ]
      expect(selectTaskRows(value)).toEqual([])
    }
  )

  it('never accepts the local native zero binding as a cloud profile binding', () => {
    const value = input({ runtimeHandle: { origin: { ...origin, projectStore: 'cloud' } } })
    value.projects = [
      {
        ...value.projects[0],
        project: project({ project_store: 'backend' }),
        issues: [issue({ assignee_user_id: 7 })],
      },
    ]
    expect(state(value).rows[0]).toMatchObject({ needsUser: true, executionState: null })
  })

  it('requires an explicit profile owner instead of treating participation principals as origins', () => {
    const value = input()
    value.viewer = [0, 7]
    expect(state(value).rows[0]).toMatchObject({ needsUser: false, executionState: 'running' })
    value.projects = [
      {
        ...value.projects[0],
        project: project({ project_store: 'local', current_user_id: undefined }),
      },
    ]
    expect(state(value).rows[0]).toMatchObject({ needsUser: true, executionState: null })
  })

  it('uses queued runtime evidence and gives an actual running binding precedence', () => {
    const value = input({ status: 'queued', running: false })
    expect(state(value).rows[0]).toMatchObject({ needsUser: false, executionState: 'queued' })
    value.projects = [
      {
        ...value.projects[0],
        taskBindings: [
          binding({ taskUserId: 0 }),
          binding({ id: 'binding-2', taskId: 'running-task', taskUserId: 0 }),
        ],
      },
    ]
    value.runtimeWork = runtime([
      { status: 'queued', running: false, runtimeHandle: { origin } },
      { taskId: 'running-task', running: true, runtimeHandle: { origin } },
    ])
    expect(state(value).rows[0]).toMatchObject({ needsUser: false, executionState: 'running' })
  })

  it.each([
    { projectStore: 'cloud' },
    { projectStore: undefined },
    { cloudProjectId: 'other-project' },
    { loopItemId: 'other-issue' },
    { initiatedBy: 'user' },
    { userId: 0 },
    { userId: 8 },
    { userId: undefined },
  ])('rejects mismatched runtime origin %j', patch => {
    const { rows, snapshot } = state(input({ runtimeHandle: { origin: { ...origin, ...patch } } }))
    expect(rows[0]).toMatchObject({ needsUser: true, executionState: null })
    expect(snapshot.counts).toEqual({ waiting: 1, running: 0, completed: 0 })
  })

  it.each([
    { projectId: 'other-project' },
    { issueId: 'other-issue' },
    { deviceId: 'other-device' },
    { taskId: 'other-task' },
    { taskUserId: 8 },
  ])('requires the exact owned binding %j', patch => {
    const value = input()
    value.projects = [
      { ...value.projects[0], taskBindings: [binding({ taskUserId: 0, ...patch })] },
    ]
    expect(state(value).rows[0]).toMatchObject({ needsUser: true, executionState: null })
  })

  it('does not derive execution without a binding or when the Issue is hidden', () => {
    const value = input()
    value.projects = [{ ...value.projects[0], taskBindings: undefined }]
    expect(state(value).rows[0]).toMatchObject({ needsUser: true, executionState: null })
    value.projects = [
      {
        ...value.projects[0],
        taskBindings: [binding({ taskUserId: 0 })],
        issues: [issue({ can_view_detail: false })],
      },
    ]
    expect(state(value).rows).toEqual([])
    expect(state(value).snapshot.counts).toEqual({ waiting: 0, running: 0, completed: 0 })
  })

  it('keeps a pending human handoff waiting while its bound stand-in continues running', () => {
    const value = input()
    value.projects = [
      {
        ...value.projects[0],
        issues: [
          issue({
            created_by_user_id: 0,
            assignee_user_id: null,
            human_requests: [humanRequest({ recipient_user_id: 0, recipient_name: 'Local owner' })],
          }),
        ],
      },
    ]
    const { rows, snapshot } = state(value)
    expect(rows[0]).toMatchObject({
      needsUser: true,
      executionState: 'running',
      waitingFor: [{ id: 0, name: 'Local owner' }],
      waitingSince: '2026-11-02T00:00:00Z',
    })
    expect(snapshot.counts).toEqual({ waiting: 1, running: 0, completed: 0 })
  })

  it.each([
    { running: false },
    { status: 'failed' },
    { status: 'cancelled' },
    { status: 'archived' },
    { completedAt: '2026-11-02T00:00:00Z' },
    {
      executionState: {
        revision: '1',
        phase: 'idle',
        turnId: null,
        latestTurnId: null,
        outcome: null,
      },
    },
  ] satisfies Partial<RuntimeTaskSummary>[])(
    'does not retain a running actor from inactive runtime evidence %j',
    task => {
      expect(state(input(task)).rows[0]).toMatchObject({ needsUser: true, executionState: null })
    }
  )

  it('keeps terminal Issues terminal despite a stale running runtime task', () => {
    const value = input()
    value.projects = [
      {
        ...value.projects[0],
        issues: [issue({ status: 'completed', execution_state: 'succeeded' })],
      },
    ]
    const { rows, snapshot } = state(value)
    expect(rows[0]).toMatchObject({ needsUser: false, executionState: 'succeeded' })
    expect(snapshot.counts).toEqual({ waiting: 0, running: 0, completed: 1 })
  })

  it('never infers AI execution from an in-progress Issue status alone', () => {
    const value = input()
    value.runtimeWork = null
    value.projects = [
      { ...value.projects[0], issues: [issue({ assignee_user_id: 8, status: 'in_progress' })] },
    ]
    const rows = selectTaskRows(value, { relevance: 'all' })
    expect(rows[0]).toMatchObject({ needsUser: false, executionState: null })
    expect(selectExperienceWorkSnapshot({ roles: [], work: [], rows }).counts).toEqual({
      waiting: 0,
      running: 0,
      completed: 0,
    })
  })
})
