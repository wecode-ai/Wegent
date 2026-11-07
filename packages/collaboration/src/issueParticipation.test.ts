import { describe, expect, it } from 'vitest'
import {
  issueWaitingSince,
  issueHumanAssignees,
  issueNeedsUser,
  issueParticipation,
  standInProcessingActor,
  type IssueHumanRequest,
} from './issueParticipation'

const request: IssueHumanRequest = {
  id: 'question',
  project_id: 'project',
  issue_id: 'issue',
  root_comment_id: 'root',
  runtime_device_id: 'device',
  runtime_task_id: 'task',
  item_id: 'native-question',
  question: 'Choose a scope',
  recipient_user_id: 7,
  recipient_name: 'Member',
  blocks_progress: false,
  status: 'pending',
  version: 1,
  created_at: '2026-11-07T00:00:00Z',
  updated_at: '2026-11-07T00:00:00Z',
}

describe('Issue participation', () => {
  it('uses the exact current handoff, not unrelated update or creation times', () => {
    const current = {
      ...request,
      waiting_since: '2026-11-08T02:00:00Z',
      updated_at: '2026-11-08T04:00:00Z',
    }
    expect(issueWaitingSince({ human_requests: [current] }, 7)).toBe(current.waiting_since)
    expect(
      issueWaitingSince({ human_requests: [{ ...current, waiting_since: undefined }] }, 7)
    ).toBeNull()
    expect(issueWaitingSince({ human_requests: [current] }, 8)).toBeNull()
    const owned = { created_by_user_id: 7, created_at: '2026-11-01T00:00:00Z' }
    expect(issueWaitingSince(owned, 7)).toBe(owned.created_at)
    expect(issueWaitingSince({ ...owned, execution_state: 'succeeded' }, 7)).toBeNull()
    expect(
      issueWaitingSince(
        {
          ...owned,
          execution_state: 'succeeded',
          ai_state: { completed_at: '2026-11-08T03:00:00Z' },
        },
        7
      )
    ).toBe('2026-11-08T03:00:00Z')
  })
  it('routes unassigned questions to the recorded responsible person, not an unrelated creator', () => {
    const current = {
      ...request,
      recipient_user_id: null,
      recipient_name: null,
      responsible_user_id: 8,
      responsible_user_name: 'Leader',
      waiting_since: '2026-11-08T02:00:00Z',
    }
    const item = {
      created_by_user_id: 7,
      created_by_user_name: 'Creator',
      human_requests: [current],
    }
    expect(issueHumanAssignees(item)).toEqual([{ id: 8, name: 'Leader' }])
    expect(issueNeedsUser(item, 7)).toBe(false)
    expect(issueNeedsUser(item, 8)).toBe(true)
    expect(issueWaitingSince(item, 8)).toBe(current.waiting_since)
  })
  it('does not count AI work since an older assignment as human waiting', () => {
    expect(
      issueWaitingSince(
        {
          created_by_user_id: 7,
          execution_state: 'succeeded',
          assignment_history: [{ to_type: 'user', to_id: '7', at: '2026-11-01T00:00:00Z' }],
        },
        7
      )
    ).toBeNull()
  })
  it('interprets legacy execution completion as UTC instead of viewer local time', () => {
    expect(
      issueWaitingSince(
        {
          created_by_user_id: 7,
          execution_state: 'succeeded',
          ai_state: { completed_at: '2026-11-08T03:00:00' },
        },
        7
      )
    ).toBe('2026-11-08T03:00:00Z')
  })
  it('does not infer AI activity from the Issue business status or absence of questions', () => {
    for (const status of ['pending', 'in_progress', 'in_review']) {
      expect(issueParticipation({ status })).toBe('human')
    }
    for (const execution_state of [
      'queued',
      'starting',
      'waiting_runtime',
      'succeeded',
      'failed',
      'cancelled',
    ]) {
      expect(issueParticipation({ status: 'in_progress', execution_state })).toBe('human')
    }
  })
  it('uses execution truth for AI activity, independent of who owns the Issue', () => {
    expect(issueParticipation({ execution_state: 'running' })).toBe('ai')
    expect(issueParticipation({ ai_state: { status: 'running' } })).toBe('ai')
    expect(
      issueParticipation({ execution_state: 'succeeded', ai_state: { status: 'running' } })
    ).toBe('human')
  })
  it('prioritizes unresolved input even while independent work can continue', () => {
    expect(issueParticipation({ human_requests: [request] })).toBe('human')
    expect(issueNeedsUser({ human_requests: [request] }, '7')).toBe(true)
    expect(issueNeedsUser({ human_requests: [request] }, 8)).toBe(false)
  })
  it('keeps accepted but not delivered answers pending and closes only the exact request', () => {
    expect(
      issueParticipation({
        human_requests: [{ ...request, status: 'answering' }],
      })
    ).toBe('human')
    expect(
      issueParticipation({
        human_requests: [{ ...request, status: 'resolved' }, request],
      })
    ).toBe('human')
    expect(
      issueParticipation({
        human_requests: [{ ...request, status: 'resolved' }],
      })
    ).toBe('human')
  })
  it('assigns idle work to its human owner or creator, including local user zero', () => {
    const item = { created_by_user_id: 0, created_by_user_name: '李四' }
    expect(issueHumanAssignees(item)).toEqual([{ id: 0, name: '李四' }])
    expect(issueNeedsUser(item, 0)).toBe(true)
    expect(issueHumanAssignees({ ...item, assignee_user_id: 7, assignee_name: '张三' })).toEqual([
      { id: 7, name: '张三' },
    ])
    expect(
      issueHumanAssignees({
        ...item,
        human_requests: [{ ...request, recipient_user_id: null, recipient_name: null }],
      })
    ).toEqual([{ id: 0, name: '李四' }])
    expect(issueNeedsUser({ ...item, execution_state: 'running' }, 0)).toBe(false)
  })
  it('identifies a running stand-in from its runtime origin, not human ownership', () => {
    const handle = { origin: { initiatedBy: 'stand_in', roleName: '研发分身' } }
    expect(standInProcessingActor(handle, true)).toEqual({ kind: 'stand_in', name: '研发分身' })
    expect(standInProcessingActor(handle, false)).toBeUndefined()
    expect(standInProcessingActor({ origin: { roleName: 'Not a stand-in' } }, true)).toBeUndefined()
  })
  it('never substitutes a database identifier for a missing person name', () => {
    expect(issueHumanAssignees({ created_by_user_id: 0 })).toEqual([{ id: 0, name: '' }])
  })
  it('resolves a local assignee zero from the same creator identity instead of hiding its name', () => {
    expect(
      issueHumanAssignees({
        assignee_user_id: 0,
        assignee_name: null,
        created_by_user_id: 0,
        created_by_user_name: 'local',
      })
    ).toEqual([{ id: 0, name: 'local' }])
    expect(
      issueHumanAssignees({
        assignee_user_id: 7,
        assignee_name: null,
        created_by_user_id: 0,
        created_by_user_name: 'local',
      })
    ).toEqual([{ id: 7, name: '' }])
  })
  it('does not turn terminal Issues into running AI work', () => {
    for (const status of ['completed', 'cancelled', 'archived']) {
      expect(issueParticipation({ status, human_requests: [request] })).toBeNull()
      expect(issueNeedsUser({ status, human_requests: [request] }, 7)).toBe(false)
    }
  })
})
