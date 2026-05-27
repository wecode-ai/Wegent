import type {
  CreateProjectConversationRequest,
  CreateProjectConversationResponse,
  ProjectListResponse,
  ProjectWithTasks,
} from '@/types/api'
import type { HttpClient } from './http'

export function createProjectApi(client: HttpClient) {
  return {
    listProjects(): Promise<ProjectListResponse> {
      return client.get('/projects?include_tasks=true')
    },
    getProject(projectId: number): Promise<ProjectWithTasks> {
      return client.get(`/projects/${projectId}`)
    },
    createConversation(
      projectId: number,
      data: CreateProjectConversationRequest
    ): Promise<CreateProjectConversationResponse> {
      return client.post(`/projects/${projectId}/conversations`, data)
    },
  }
}
