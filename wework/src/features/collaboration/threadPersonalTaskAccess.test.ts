// @vitest-environment node

import type {
  CollaborationAssignment,
  CollaborationIssue,
  CollaborationProject,
  SharedWorkspaceApi,
} from '@wegent/collaboration'
import { describe, expect, it, vi } from 'vitest'
import type { ThreadActionContext } from './threadActions'
import {
  canStartThreadPersonalTask,
  currentPersonalAssignment,
  hasThreadWorkOwner,
  requireThreadPersonalTaskStart,
  threadActionOwner,
  threadWorkOwner,
} from './threadPersonalTaskAccess'

const item: CollaborationIssue = {
  id: 'thread',
  group_id: 'group',
  cloud_project_id: 'group',
  joined: true,
  sequence_number: 1,
  parent_id: null,
  created_by_user_id: 0,
  assignee_user_id: null,
  title: 'Review delivery',
  description: '',
  status: 'in_progress',
  priority: 'medium',
  due_at: null,
  tags: [],
  sort_order: 0,
  version: 1,
  created_at: '2026-11-11T00:00:00Z',
  updated_at: '2026-11-11T00:00:00Z',
  completed_at: null,
}

function setup(fresh: CollaborationIssue = item, assignments: CollaborationAssignment[] = []) {
  const get = vi.fn().mockResolvedValue(fresh)
  const list = vi.fn().mockResolvedValue(assignments)
  const context: ThreadActionContext = {
    accountScope: 'account',
    sourceStore: 'local',
    item,
    project: {
      id: 'group',
      resource_type: 'chat_group',
      project_store: 'local',
    } as CollaborationProject,
    group: {
      id: 'group',
      project_key: 'G',
      name: 'Group',
      description: '',
      status: 'active',
      role: 'Developer',
      version: 1,
      created_by_user_id: 0,
      created_at: item.created_at,
      updated_at: item.updated_at,
    },
    participation: {
      current_user_id: 0,
      joined: true,
      can_comment: true,
      participants: [],
      show_in_sidebar: true,
    },
    api: { issues: { get }, assignments: { list } } as unknown as SharedWorkspaceApi,
    requestLeave: vi.fn(),
  }
  return { context, get, list }
}

function assignment(
  target: string,
  updated: string,
  status: CollaborationAssignment['status'] = 'active'
): CollaborationAssignment {
  return {
    id: target + updated,
    issue_id: item.id,
    target_type: 'human',
    target_id: target,
    target_name: target,
    body: '',
    comment_id: null,
    created_by_user_id: 0,
    created_by_user_name: null,
    status,
    created_at: item.created_at,
    updated_at: updated,
  }
}

describe('Thread personal-task access uses the exact owning group and fresh authority', () => {
  it('accepts canonical local identity zero and returns the fresh server item', async () => {
    const fresh = { ...item, assignee_user_id: 0, version: 8 }
    const { context, get, list } = setup(fresh)
    await expect(requireThreadPersonalTaskStart(context, 'Unavailable')).resolves.toBe(fresh)
    expect(get).toHaveBeenCalledExactlyOnceWith('thread')
    expect(list).toHaveBeenCalledExactlyOnceWith('thread')
  })

  it('keeps account, store, group and Thread identities distinct', () => {
    const { context } = setup()
    const owner = threadActionOwner(context)
    expect(owner).toBe(threadWorkOwner('account', 'local', 'group', 'thread'))
    for (const args of [
      ['other', 'local', 'group', 'thread'],
      ['account', 'cloud', 'group', 'thread'],
      ['account', 'local', 'other', 'thread'],
      ['account', 'local', 'group', 'other'],
    ] as const) {
      expect(threadWorkOwner(...args)).not.toBe(owner)
    }
    expect(threadWorkOwner('a,b', 'local', 'c', 'd')).not.toBe(
      threadWorkOwner('a', 'local', 'b,c', 'd')
    )
  })

  it.each<[string, (context: ThreadActionContext) => void]>([
    [
      'not joined',
      (c: ThreadActionContext) => {
        c.participation!.joined = false
      },
    ],
    [
      'unknown participation',
      (c: ThreadActionContext) => {
        c.participation = null
      },
    ],
    [
      'comment revoked',
      (c: ThreadActionContext) => {
        c.participation!.can_comment = false
      },
    ],
    [
      'viewer',
      (c: ThreadActionContext) => {
        c.group.role = 'Viewer'
      },
    ],
    [
      'archived group',
      (c: ThreadActionContext) => {
        c.group.status = 'archived'
      },
    ],
    [
      'project container',
      (c: ThreadActionContext) => {
        c.project.resource_type = 'project'
      },
    ],
    [
      'different group resource',
      (c: ThreadActionContext) => {
        c.project.id = 'other'
      },
    ],
    [
      'different item group',
      (c: ThreadActionContext) => {
        c.item = { ...item, group_id: 'other' }
      },
    ],
    [
      'classification project as owner',
      (c: ThreadActionContext) => {
        c.item = { ...item, cloud_project_id: 'classification' }
      },
    ],
    [
      'wrong store',
      (c: ThreadActionContext) => {
        c.project.project_store = 'backend'
      },
    ],
    ...['completed', 'cancelled', 'archived'].map(
      status =>
        [
          status,
          (c: ThreadActionContext) => {
            c.item = { ...item, status }
          },
        ] as const
    ),
  ])('rejects %s before any task or assignment query', async (_, change) => {
    const { context, get, list } = setup()
    change(context)
    expect(canStartThreadPersonalTask(context)).toBe(false)
    await expect(requireThreadPersonalTaskStart(context, 'Unavailable')).rejects.toThrow(
      'Unavailable'
    )
    expect(get).not.toHaveBeenCalled()
    expect(list).not.toHaveBeenCalled()
  })

  it('accepts cloud only with the backend group owner and never its classification project', () => {
    const { context } = setup()
    context.sourceStore = 'cloud'
    expect(hasThreadWorkOwner(context)).toBe(false)
    context.project.project_store = 'backend'
    expect(hasThreadWorkOwner(context)).toBe(true)
    context.project.id = 'classification'
    expect(hasThreadWorkOwner(context)).toBe(false)
  })

  it.each([
    { id: 'other' },
    { group_id: 'other' },
    { cloud_project_id: 'other' },
    { joined: false },
    { group_status: 'archived' },
    { permissions: { execute: false } },
    { status: 'completed' },
    { status: 'cancelled' },
    { status: 'archived' },
    { assignee_user_id: 8 },
    { assignee_agent_id: 'agent' },
    { assignee_group_id: 'crew' },
    { assignee_team_id: 3 },
  ])('rejects fresh revoked authority or changed assignment %j', async patch => {
    const { context, get, list } = setup({ ...item, ...patch })
    expect(canStartThreadPersonalTask(context)).toBe(true)
    await expect(requireThreadPersonalTaskStart(context, 'Unavailable')).rejects.toThrow(
      'Unavailable'
    )
    expect(get).toHaveBeenCalledOnce()
    expect(list).toHaveBeenCalledOnce()
  })

  it('uses the newest active assignment and does not alias 00 to canonical zero', async () => {
    const old = assignment('8', '2026-11-11T01:00:00Z')
    const latest = assignment('0', '2026-11-11T02:00:00Z')
    const inactive = assignment('8', '2026-11-11T03:00:00Z', 'completed')
    const entries = [latest, inactive, old]
    expect(currentPersonalAssignment(entries)).toBe(latest)
    expect(entries).toEqual([latest, inactive, old])
    const allowed = setup(item, entries)
    await expect(requireThreadPersonalTaskStart(allowed.context, 'Unavailable')).resolves.toBe(item)
    const denied = setup(item, [assignment('00', latest.updated_at)])
    await expect(requireThreadPersonalTaskStart(denied.context, 'Unavailable')).rejects.toThrow(
      'Unavailable'
    )
    const agent = setup(item, [{ ...latest, target_type: 'agent' }])
    await expect(requireThreadPersonalTaskStart(agent.context, 'Unavailable')).rejects.toThrow(
      'Unavailable'
    )
  })

  it('propagates a fresh authorization read failure without starting from stale UI facts', async () => {
    const { context, get } = setup()
    const denied = new Error('Access revoked')
    get.mockRejectedValueOnce(denied)
    await expect(requireThreadPersonalTaskStart(context, 'Unavailable')).rejects.toBe(denied)
  })
})
