import type {
  CreateProjectConversationRequest,
  CreateProjectConversationResponse,
  CreateProjectRequest,
  ProjectListResponse,
  ProjectWithTasks,
  TaskArchiveBatchResponse,
  UpdateProjectRequest,
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
    createProject(data: CreateProjectRequest): Promise<ProjectWithTasks> {
      return client.post('/projects', data)
    },
    updateProject(
      projectId: number,
      data: UpdateProjectRequest
    ): Promise<ProjectWithTasks> {
      return client.put(`/projects/${projectId}`, data)
    },
    deleteProject(projectId: number): Promise<void> {
      return client.delete(`/projects/${projectId}`)
    },
    archiveProjectChats(projectId: number): Promise<TaskArchiveBatchResponse> {
      return client.post(`/projects/${projectId}/archive-chats`)
    },
    createConversation(
      projectId: number,
      data: CreateProjectConversationRequest
    ): Promise<CreateProjectConversationResponse> {
      return client.post(`/projects/${projectId}/conversations`, data)
    },
  }
}
