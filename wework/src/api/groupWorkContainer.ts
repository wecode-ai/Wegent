import {
  collaborationMessages,
  threadStatuses,
  type CollaborationProject,
} from '@wegent/collaboration'
import type { ChatGroup } from './chatGroups'
import type { CloudProject } from './deliveries'

/** Project classification never replaces a group's actual work-container identity. */
export function groupWorkContainer(
  group: ChatGroup,
  store: 'local' | 'cloud'
): CollaborationProject & CloudProject {
  return {
    id: group.id,
    resource_type: 'chat_group',
    public_id: group.id,
    project_key: group.project_key,
    name: group.name,
    description: group.description,
    project_store: store === 'local' ? 'local' : 'backend',
    task_provider: 'local',
    provider_config: {},
    created_by_user_id: group.created_by_user_id,
    access_role: group.role,
    status: group.status,
    tags: group.configuration?.tags ?? [],
    board_config: {
      ...group.configuration?.board_config,
      group_by: group.configuration?.board_config?.group_by ?? 'status',
      statuses: threadStatuses(collaborationMessages['zh-CN']),
      processing_start_status_id: 'pending',
    },
    board_views: group.configuration?.board_views ?? undefined,
    card_display: group.configuration?.card_display ?? undefined,
    collaboration_groups: group.configuration?.collaboration_groups ?? [],
    automatic_processing_rules: group.configuration?.automatic_processing_rules ?? [],
    execution_environment: group.configuration?.execution_environment,
    version: group.version,
    created_at: group.created_at,
    updated_at: group.updated_at,
  }
}
