import type {
  CreateGitWorkspaceProjectRequest,
  CreateGitWorkspaceProjectResponse,
  CreateProjectRequest,
  DeleteProjectWorktreeRequest,
  DeleteProjectWorktreeResponse,
  ProjectListResponse,
  ProjectDeviceSessionResponse,
  ProjectWorktreeListResponse,
  ProjectWithTasks,
  UpdateProjectRequest,
} from '@/types/api'
import type { HttpClient } from './http'

const WEWORK_CLIENT_ORIGIN = 'wework'

function withClientOrigin(path: string): string {
  const separator = path.includes('?') ? '&' : '?'
  return `${path}${separator}client_origin=${WEWORK_CLIENT_ORIGIN}`
}

export function createProjectApi(client: HttpClient) {
  function projectSessionPayload(options?: { taskId?: number }) {
    return options?.taskId ? { task_id: options.taskId } : undefined
  }

  function startProjectSession(
    path: string,
    options?: { taskId?: number }
  ): Promise<ProjectDeviceSessionResponse> {
    const payload = projectSessionPayload(options)
    return payload ? client.post(path, payload) : client.post(path)
  }

  return {
    listProjects(): Promise<ProjectListResponse> {
      return client.get(withClientOrigin('/projects'))
    },
    getProject(projectId: number): Promise<ProjectWithTasks> {
      return client.get(withClientOrigin(`/projects/${projectId}`))
    },
    createProject(data: CreateProjectRequest): Promise<ProjectWithTasks> {
      return client.post('/projects', {
        ...data,
        client_origin: WEWORK_CLIENT_ORIGIN,
      })
    },
    createGitWorkspaceProject(
      data: CreateGitWorkspaceProjectRequest
    ): Promise<CreateGitWorkspaceProjectResponse> {
      return client.post('/projects/git-workspace', {
        ...data,
        client_origin: WEWORK_CLIENT_ORIGIN,
      })
    },
    listWorktrees(): Promise<ProjectWorktreeListResponse> {
      return client.get(withClientOrigin('/projects/worktrees'))
    },
    deleteWorktree(data: DeleteProjectWorktreeRequest): Promise<DeleteProjectWorktreeResponse> {
      return client.delete(
        withClientOrigin(
          `/projects/worktrees/${encodeURIComponent(data.device_id)}/${encodeURIComponent(data.worktree_id)}?project_id=${encodeURIComponent(String(data.project_id))}`
        )
      )
    },
    updateProject(projectId: number, data: UpdateProjectRequest): Promise<ProjectWithTasks> {
      return client.put(withClientOrigin(`/projects/${projectId}`), data)
    },
    deleteProject(projectId: number): Promise<void> {
      return client.delete(withClientOrigin(`/projects/${projectId}`))
    },
    startTerminalSession(
      projectId: number,
      options?: { taskId?: number }
    ): Promise<ProjectDeviceSessionResponse> {
      return startProjectSession(withClientOrigin(`/projects/${projectId}/terminal`), options)
    },
    startCodeServerSession(
      projectId: number,
      options?: { taskId?: number }
    ): Promise<ProjectDeviceSessionResponse> {
      return startProjectSession(withClientOrigin(`/projects/${projectId}/code-server`), options)
    },
  }
}
