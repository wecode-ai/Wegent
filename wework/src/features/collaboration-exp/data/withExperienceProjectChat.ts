import type { ProjectChatClient } from '@wegent/chat-core'
import type { SharedWorkspaceApi } from '@wegent/collaboration'
import { createProjectChatComments } from '@/features/collaboration/projectChatComments'

export function withExperienceProjectChat(
  api: SharedWorkspaceApi,
  client: ProjectChatClient | undefined
): SharedWorkspaceApi {
  const activity = client ?? api.activity
  if (!activity) {
    const unavailable = async (): Promise<never> => {
      throw new Error('Project activity service is unavailable')
    }
    return { ...api, comments: { list: unavailable, create: unavailable } }
  }
  return {
    ...api,
    activity,
    comments: createProjectChatComments(
      activity,
      async issueId => (await api.issues.get(issueId)).cloud_project_id
    ),
  }
}
