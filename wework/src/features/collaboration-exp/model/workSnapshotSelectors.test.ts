import { describe, expect, it } from 'vitest'
import type { RuntimeTaskSummary } from '@/types/api'
import type { RuntimeTaskReminderItem } from '@/features/workbench/runtimeTaskReminders'
import { experienceIssueFixture, experienceProjectFixture } from './fixtures'
import { selectTaskRows } from './taskSelectors'
import { selectExperienceWorkSnapshot } from './workSnapshotSelectors'
import type { ExperienceTaskRow, ExperienceWorkSnapshotInput } from './types'

const roles: ExperienceWorkSnapshotInput['roles'] = [
  { id: null, name: null, enabled: true, isDefault: true },
  { id: 'research', name: 'Research', enabled: true, isDefault: false },
  { id: 'editing', name: 'Editing', enabled: true, isDefault: false },
]

function work(
  taskId: string,
  roleId = 'default',
  task: Partial<RuntimeTaskSummary> = {},
  deviceId = 'device-1'
): RuntimeTaskReminderItem {
  const summary: RuntimeTaskSummary = {
    taskId,
    title: taskId,
    workspacePath: '',
    runtime: 'codex',
    updatedAt: '2026-11-01T00:00:00Z',
    runtimeHandle: { origin: { initiatedBy: 'stand_in', standInId: roleId, userId: 7 } },
    ...task,
  }
  return {
    key: `${deviceId}\0${taskId}`,
    address: { deviceId, taskId },
    task: summary,
    projectName: '',
    workspace: { deviceId, available: true, workspacePath: '', tasks: [summary] },
  }
}

function row(id: string, overrides: Partial<ExperienceTaskRow> = {}): ExperienceTaskRow {
  const [source] = selectTaskRows({
    viewer: 7,
    projects: [{ project: experienceProjectFixture(), issues: [experienceIssueFixture({ id })] }],
  })
  return { ...source, ...overrides }
}

describe('selectExperienceWorkSnapshot', () => {
  it('uses one waiting-over-running-over-idle relay rule and keeps completed members idle', () => {
    const snapshot = selectExperienceWorkSnapshot({
      roles,
      work: [
        work('default-running', '@primary', { running: true }),
        work('research-running', 'research', { running: true }),
        work('research-waiting', 'research', { interactionStatus: 'waitingForUserInput' }),
        work('editing-completed', 'editing', { status: 'done' }),
      ],
    })
    expect(snapshot.counts).toEqual({ waiting: 1, running: 2, completed: 1 })
    expect(snapshot.team.map(member => [member.id, member.state])).toEqual([
      [null, 'running'],
      ['research', 'waiting'],
      ['editing', 'idle'],
    ])
    expect(snapshot.team[1].counts).toEqual({ waiting: 1, running: 1, completed: 0 })
  })

  it('does not fabricate active work from unknown, failed or idle execution snapshots', () => {
    const snapshot = selectExperienceWorkSnapshot({
      roles,
      work: [
        work('unknown'),
        work('failed', 'research', { status: 'failed' }),
        work('idle', 'editing', {
          executionState: {
            revision: '1',
            phase: 'idle',
            turnId: null,
            latestTurnId: null,
            outcome: null,
          },
        }),
      ],
    })
    expect(snapshot.counts).toEqual({ waiting: 0, running: 0, completed: 0 })
    expect(snapshot.team.every(member => member.state === 'idle')).toBe(true)
    expect(snapshot.current).toBeNull()
  })

  it('maps existing inbox grouping, sending and sent states without creating new identities', () => {
    const inbox = (id: string, status: string) =>
      work(id, 'research', {
        runtimeHandle: {
          origin: { initiatedBy: 'stand_in', standInId: 'research', inboxStatus: status },
        },
      })
    const snapshot = selectExperienceWorkSnapshot({
      roles,
      work: [inbox('group', 'needs_grouping'), inbox('send', 'sending'), inbox('sent', 'sent')],
    })
    expect(snapshot.counts).toEqual({ waiting: 1, running: 1, completed: 1 })
    expect(snapshot.current?.address).toEqual({ deviceId: 'device-1', taskId: 'send' })
  })

  it('deduplicates native addresses and proposals while keeping different devices distinct', () => {
    const snapshot = selectExperienceWorkSnapshot({
      roles,
      work: [
        work('same', 'default', { running: true }),
        work('same', 'default', { status: 'done', running: false, completedAt: '2026-11-02' }),
        work('same', 'default', { running: true }, 'device-2'),
        work('ordinary', 'research', { runtimeHandle: { origin: { initiatedBy: 'user' } } }),
      ],
      pendingDecisions: [
        { id: 'proposal-1', summary: 'Approve plan', roleId: 'research' },
        { id: 'proposal-1', summary: 'Approve revised plan', roleId: 'research' },
      ],
    })
    expect(snapshot.items).toHaveLength(3)
    expect(snapshot.counts).toEqual({ waiting: 1, running: 1, completed: 1 })
    expect(snapshot.team[1].state).toBe('waiting')
    expect(snapshot.items.find(item => item.title === 'Approve revised plan')).toBeDefined()
  })

  it('counts only the current visible Issue rows while relay stays based on owned global work', () => {
    const waiting = row('EXP-1', { needsUser: true, executionState: 'running' })
    const running = row('EXP-2', { needsUser: false, executionState: 'running' })
    const completed = row('EXP-3', { status: 'completed', needsUser: false })
    const globalWork = [work('global', 'research', { interactionStatus: 'awaitingUserReply' })]
    const full = selectExperienceWorkSnapshot({
      roles,
      work: globalWork,
      rows: [waiting, running, running, completed],
    })
    expect(full.counts).toEqual({ waiting: 1, running: 1, completed: 1 })
    expect(full.current?.taskRow).toBe(running)
    const filtered = selectExperienceWorkSnapshot({ roles, work: globalWork, rows: [completed] })
    expect(filtered.counts).toEqual({ waiting: 0, running: 0, completed: 1 })
    expect(filtered.current).toBeNull()
    expect(filtered.team).toEqual(full.team)
    expect(selectExperienceWorkSnapshot({ roles, work: globalWork, rows: [] }).counts).toEqual({
      waiting: 0,
      running: 0,
      completed: 0,
    })
  })

  it('uses native completion evidence for custom board states without guessing from labels', () => {
    const snapshot = selectExperienceWorkSnapshot({
      roles: [],
      work: [],
      rows: [
        row('EXP-1', { status: 'custom-done', statusName: 'Done', needsUser: false }),
        row('EXP-2', {
          status: 'custom-end',
          completedAt: '2026-11-02',
          needsUser: true,
          executionState: 'running',
        }),
        row('EXP-3', { status: 'cancelled', needsUser: false, executionState: 'running' }),
      ],
    })
    expect(snapshot.counts).toEqual({ waiting: 0, running: 0, completed: 2 })
    expect(snapshot.items[0].state).toBe('idle')
  })

  it('selects only a visible execution, by stable updated time then identity', () => {
    const old = row('EXP-1', {
      needsUser: false,
      executionState: 'running',
      updatedAt: '2026-11-01',
    })
    const newer = row('EXP-2', {
      needsUser: false,
      executionState: 'running',
      updatedAt: '2026-11-03',
    })
    const snapshot = selectExperienceWorkSnapshot({ roles: [], work: [], rows: [old, newer] })
    expect(snapshot.current?.taskRow).toBe(newer)
    const tie = { ...old, updatedAt: newer.updatedAt }
    expect(
      selectExperienceWorkSnapshot({ roles: [], work: [], rows: [newer, tie] }).current?.taskRow
    ).toBe(tie)
  })

  it('never includes hidden Issue titles or counts from the authorized rows selector', () => {
    const rows = selectTaskRows(
      {
        viewer: 7,
        projects: [
          {
            project: experienceProjectFixture(),
            issues: [
              experienceIssueFixture({ id: 'SECRET', title: 'Hidden', can_view_detail: false }),
            ],
          },
        ],
      },
      { relevance: 'all' }
    )
    const snapshot = selectExperienceWorkSnapshot({ roles: [], work: [], rows })
    expect(snapshot.items).toEqual([])
    expect(snapshot.counts).toEqual({ waiting: 0, running: 0, completed: 0 })
  })
})
