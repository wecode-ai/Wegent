import type {
  ArchivedTaskListResponse,
  Task,
  TaskArchiveBatchResponse,
  TaskArchiveResponse,
  TaskDetail,
  TaskForkRequest,
  TaskForkResponse,
  TaskListResponse,
  TurnFileChangesDiffResponse,
  TurnFileChangesRevertResponse,
} from '@/types/api'
import type { HttpClient } from './http'

const WEWORK_CLIENT_ORIGIN = 'wework'

interface RecentTaskParams {
  limit: number
  page?: number
}

interface SearchTaskParams {
  limit?: number
  page?: number
}

export function createTaskApi(client: HttpClient) {
  return {
    listRecentTasks(params: RecentTaskParams): Promise<TaskListResponse> {
      const query = new URLSearchParams()
      query.set('limit', String(params.limit))
      query.set('page', String(params.page ?? 1))
      query.set('types', 'online,offline')
      query.set('client_origin', WEWORK_CLIENT_ORIGIN)
      return client.get(`/tasks/lite/personal?${query.toString()}`)
    },
    searchTasks(keyword: string, params: SearchTaskParams = {}): Promise<TaskListResponse> {
      const query = new URLSearchParams()
      query.set('keyword', keyword)
      query.set('page', String(params.page ?? 1))
      query.set('limit', String(params.limit ?? 20))
      return client.get(`/tasks/wework/conversation-search?${query.toString()}`)
    },
    getTaskDetail(taskId: number): Promise<TaskDetail> {
      return client.get(`/tasks/${taskId}?client_origin=${WEWORK_CLIENT_ORIGIN}`)
    },
    forkTask(taskId: number, request: TaskForkRequest): Promise<TaskForkResponse> {
      return client.post(`/tasks/${taskId}/fork?client_origin=${WEWORK_CLIENT_ORIGIN}`, request)
    },
    getTurnFileChangesDiff(subtaskId: number): Promise<TurnFileChangesDiffResponse> {
      return client.get(`/subtasks/${subtaskId}/file-changes/diff`)
    },
    revertTurnFileChanges(subtaskId: number): Promise<TurnFileChangesRevertResponse> {
      return client.post(`/subtasks/${subtaskId}/file-changes/revert`)
    },
    renameTask(taskId: number, title: string): Promise<Task> {
      return client.put(`/tasks/${taskId}?client_origin=${WEWORK_CLIENT_ORIGIN}`, {
        title,
      })
    },
    archiveTask(taskId: number): Promise<TaskArchiveResponse> {
      return client.post(`/tasks/${taskId}/archive?client_origin=${WEWORK_CLIENT_ORIGIN}`)
    },
    archiveAllChats(): Promise<TaskArchiveBatchResponse> {
      return client.post(`/tasks/archive?scope=standalone&client_origin=${WEWORK_CLIENT_ORIGIN}`)
    },
    listArchivedTasks(): Promise<ArchivedTaskListResponse> {
      return client.get(`/tasks/archived?limit=200&page=1&client_origin=${WEWORK_CLIENT_ORIGIN}`)
    },
    unarchiveTask(taskId: number): Promise<TaskArchiveResponse> {
      return client.post(`/tasks/${taskId}/unarchive?client_origin=${WEWORK_CLIENT_ORIGIN}`)
    },
    deleteTask(taskId: number): Promise<{ message: string }> {
      return client.delete(`/tasks/${taskId}?client_origin=${WEWORK_CLIENT_ORIGIN}`)
    },
    deleteArchivedTasks(): Promise<TaskArchiveBatchResponse> {
      return client.delete(`/tasks/archived?client_origin=${WEWORK_CLIENT_ORIGIN}`)
    },
  }
}
