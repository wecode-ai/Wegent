import type {
  CollaborationIssue,
  CollaborationProject,
  IssueHumanRequest,
  WorkspaceTaskBinding,
} from '@wegent/collaboration'
import type { ProjectChatMessage } from '@wegent/chat-core'
import type { RuntimeTaskSummary, RuntimeWorkListResponse } from '@/types/api'
import type { PersonalStandInSettings } from '@/api/personalStandIn'

export function experienceProjectFixture(
  overrides: Partial<CollaborationProject> = {}
): CollaborationProject {
  return {
    id: 'project-1',
    public_id: 'public-project-1',
    project_key: 'EXP',
    name: 'Experience project',
    description: '',
    project_store: 'backend',
    task_provider: 'local',
    provider_config: {},
    created_by_user_id: 7,
    current_user_id: 7,
    access_role: 'Developer',
    status: 'active',
    tags: [],
    version: 1,
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-01T00:00:00Z',
    ...overrides,
  }
}

export function experienceIssueFixture(
  overrides: Partial<CollaborationIssue> = {}
): CollaborationIssue {
  return {
    id: 'EXP-1',
    cloud_project_id: 'project-1',
    sequence_number: 1,
    parent_id: null,
    created_by_user_id: 7,
    created_by_user_name: 'Member',
    assignee_user_id: 7,
    assignee_name: 'Member',
    title: 'Implement the experience',
    description: '',
    status: 'pending',
    priority: 'medium',
    due_at: null,
    tags: [],
    sort_order: 0,
    current_delivery_id: null,
    can_view_detail: true,
    can_edit: true,
    version: 1,
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-01T00:00:00Z',
    completed_at: null,
    ...overrides,
  }
}

export function experienceBindingFixture(
  overrides: Partial<WorkspaceTaskBinding> = {}
): WorkspaceTaskBinding {
  return {
    id: 'binding-1',
    projectId: 'project-1',
    issueId: 'EXP-1',
    taskUserId: 7,
    deviceId: 'device-1',
    taskId: 'task-1',
    taskTitle: 'Private task',
    backendTaskId: null,
    bindingType: 'user',
    linkedAt: '2026-11-02T00:00:00Z',
    ...overrides,
  }
}

export function experienceMessageFixture(
  overrides: Partial<ProjectChatMessage> = {}
): ProjectChatMessage {
  return {
    messageId: 'message-1',
    sequenceNumber: 1,
    projectId: 'project-1',
    taskId: 'EXP-1',
    sender: { type: 'user', id: '7', name: 'Member' },
    type: 'text',
    content: 'Confirmed conclusion',
    metadata: {},
    status: 'completed',
    createdAt: '2026-11-02T00:00:00Z',
    updatedAt: '2026-11-02T00:00:00Z',
    ...overrides,
  }
}

export function experienceHumanRequestFixture(
  overrides: Partial<IssueHumanRequest> = {}
): IssueHumanRequest {
  return {
    id: 'request-1',
    project_id: 'project-1',
    issue_id: 'EXP-1',
    root_comment_id: 'message-1',
    runtime_device_id: 'device-1',
    runtime_task_id: 'task-1',
    item_id: 'native-request',
    question: 'Choose the scope',
    recipient_user_id: 7,
    recipient_name: 'Member',
    blocks_progress: false,
    status: 'pending',
    version: 1,
    created_at: '2026-11-02T00:00:00Z',
    updated_at: '2026-11-02T00:00:00Z',
    waiting_since: '2026-11-02T00:00:00Z',
    ...overrides,
  }
}

export function experienceRuntimeFixture(
  tasks: Partial<RuntimeTaskSummary>[] = [{}]
): RuntimeWorkListResponse {
  return {
    projects: [],
    chats: [
      {
        deviceId: 'device-1',
        available: true,
        workspacePath: '/workspace/experience',
        tasks: tasks.map(task => ({
          taskId: 'task-1',
          title: 'Runtime private task',
          runtime: 'codex',
          workspacePath: '/workspace/experience',
          ...task,
        })),
      },
    ],
    totalTasks: tasks.length,
  }
}

export function experienceStandInFixture(
  overrides: Partial<PersonalStandInSettings> = {}
): PersonalStandInSettings {
  return {
    userId: 7,
    executionDeviceId: 'device-1',
    version: 1,
    primary: {
      enabled: true,
      prompt: 'Private default prompt',
      preferences: 'Private preferences',
    },
    roles: [],
    ...overrides,
  }
}
