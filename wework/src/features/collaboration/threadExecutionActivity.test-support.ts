// @vitest-environment node
import { vi } from 'vitest'
import type {
  CollaborationGroup,
  CollaborationIssue,
  SharedWorkspaceApi,
} from '@wegent/collaboration'
import type { ProjectChatClient, ProjectChatMessage } from '@wegent/chat-core'
import type { ChatGroup, ChatGroupApi } from '@/api/chatGroups'
import { groupWorkContainer } from '@/api/groupWorkContainer'
import type { ThreadActionContext } from './threadActions'
import { createThreadExecutionActions } from './threadExecutionActions'

export function activityFixture(crewId?: string) {
  const item = {
    id: 'T-1',
    group_id: 'group',
    cloud_project_id: 'group',
    status: 'in_review',
    title: 'Validate release',
    description: 'Keep the evidence',
    assignee_agent_id: crewId ? null : 'agent',
    assignee_group_id: crewId ?? null,
    assignee_group_source_id: crewId ? 'group' : null,
    version: 8,
    joined: true,
    permissions: { execute: true, edit_content: true, assign: true, comment: true },
    can_approve: true,
  } as CollaborationIssue
  const participation = {
    current_user_id: 7,
    joined: true,
    can_comment: true,
    participants: [],
    show_in_sidebar: true,
  }
  const group: ChatGroup = {
    id: 'group',
    role: 'Owner',
    status: 'active',
    project_key: 'G',
    name: 'Group',
    description: '',
    version: 1,
    created_by_user_id: 7,
    created_at: '2026-11-11T00:00:00Z',
    updated_at: '2026-11-11T00:00:00Z',
  }
  const crew: CollaborationGroup = {
    id: crewId ?? 'crew',
    workspace_id: null,
    owner_type: 'chat_group',
    owner_id: 'group',
    binding_owner_id: 'group',
    name: 'Crew',
    description: '',
    leader: { kind: 'agent', id: 'agent', responsibility: 'Coordinate review' },
    members: [],
    coordination_mode: 'manager',
    stages: [],
    version: 1,
    created_by_user_id: 7,
    created_at: group.created_at,
    updated_at: group.updated_at,
  }
  const api = {
    projects: { listCollaborationGroups: vi.fn(async () => [crew]) },
    issues: {
      get: vi.fn(async () => ({ ...item, version: 12 })),
      update: vi.fn(),
      approveRun: vi.fn(),
      rejectRun: vi.fn(),
    },
    executions: {
      list: vi.fn(async () => [
        { id: 15, loop_item_id: item.id, cloud_project_id: 'group', status: 'running' },
      ]),
      stop: vi.fn(),
    },
  } as unknown as SharedWorkspaceApi
  const groups = {
    get: vi.fn(async () => ({ group })),
    participation: vi.fn(async () => participation),
  } as unknown as ChatGroupApi
  const message = {
    messageId: 'run',
    taskId: item.id,
    projectId: 'group',
    sender: { type: 'agent', id: 'agent', name: 'Agent' },
    content: 'Result',
    status: 'failed',
    type: 'text',
    sequenceNumber: 1,
    createdAt: '2026-11-11T00:00:00Z',
    updatedAt: '2026-11-11T00:00:00Z',
    metadata: {
      execution_id: 15,
      ...(crewId
        ? {
            dispatch_role: 'manager',
            manager_agent_id: 'agent',
            collaboration_group: {
              id: crewId,
              binding_owner_id: 'group',
              leader: { kind: 'agent', id: 'agent', responsibility: 'Coordinate review' },
            },
          }
        : {}),
    },
  } as ProjectChatMessage
  const unsubscribe = vi.fn()
  const chat = {
    subscribe: vi.fn(async () => ({ unsubscribe, snapshot: { messages: [message] } })),
    send: vi.fn(async () => ({ messageId: 'trigger' })),
    executeTaskComment: vi.fn(async () => []),
  } as unknown as ProjectChatClient
  const context: ThreadActionContext = {
    group,
    item,
    project: groupWorkContainer(group, 'local'),
    participation,
    api,
    sourceStore: 'local',
    accountScope: 'account',
    requestLeave: vi.fn(),
  }
  const isCurrent = vi.fn(() => true)
  const onChanged = vi.fn()
  const actions = createThreadExecutionActions({
    context,
    groups,
    chat,
    unavailable: 'Unavailable',
    isCurrent,
    onChanged,
  })
  return {
    crew,
    item,
    participation,
    group,
    api,
    groups,
    message,
    unsubscribe,
    chat,
    context,
    isCurrent,
    onChanged,
    actions,
  }
}
