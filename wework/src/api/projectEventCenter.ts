import type { HttpClient } from './http'
import type { ProjectChatWorkspaceBindingInput } from './projectChatAgents'

export interface EventCenterConfig {
  enabled: boolean
  runtime_profile_id: string | null
  workspace_binding: ProjectChatWorkspaceBindingInput
  instruction: string
  version: number
}

export interface BoardIncomingEvent {
  id: string
  title: string
  content: string
  status: string
  provider: string
  issue_id: string | null
  version: number
  history: { role: string; content: string; at: string }[]
  question: string | null
  error: string | null
  automation_id: string | null
  execution_id: number | null
  reference: { provider: string; external_id: string; url?: string } | null
  created_at: string
}

export function createProjectEventCenterApi(client: HttpClient) {
  const base = (projectId: string) => `/v1/cloud-projects/${projectId}`
  return {
    config: (projectId: string) => client.get<EventCenterConfig>(`${base(projectId)}/event-center`),
    configure: (projectId: string, config: EventCenterConfig) =>
      client.put<EventCenterConfig>(`${base(projectId)}/event-center`, config),
    list: (projectId: string) => client.get<BoardIncomingEvent[]>(`${base(projectId)}/events`),
    submit: (projectId: string, input: { title: string; content: string; request_id: string }) =>
      client.post<BoardIncomingEvent>(`${base(projectId)}/events`, input),
    reply: (projectId: string, event: BoardIncomingEvent, content: string) =>
      client.post<BoardIncomingEvent>(`${base(projectId)}/events/${event.id}/reply`, {
        content,
        version: event.version,
      }),
    retry: (projectId: string, eventId: string) =>
      client.post<BoardIncomingEvent>(`${base(projectId)}/events/${eventId}/retry`),
  }
}
