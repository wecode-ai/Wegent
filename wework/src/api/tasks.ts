import type {
  ArchivedTaskListResponse,
  Task,
  TaskArchiveBatchResponse,
  TaskArchiveResponse,
  TaskDetail,
  TaskListResponse,
} from '@/types/api'
import type { HttpClient } from './http'

interface RecentTaskParams {
  limit: number
  page?: number
}

export function createTaskApi(client: HttpClient) {
  return {
    listRecentTasks(params: RecentTaskParams): Promise<TaskListResponse> {
      const query = new URLSearchParams()
      query.set('limit', String(params.limit))
      query.set('page', String(params.page ?? 1))
      query.set('types', 'online,offline')
      return client.get(`/tasks/lite/personal?${query.toString()}`)
    },
    getTaskDetail(taskId: number): Promise<TaskDetail> {
      return client.get(`/tasks/${taskId}`)
    },
    renameTask(taskId: number, title: string): Promise<Task> {
      return client.put(`/tasks/${taskId}`, { title })
    },
    archiveTask(taskId: number): Promise<TaskArchiveResponse> {
      return client.post(`/tasks/${taskId}/archive`)
    },
    archiveAllChats(): Promise<TaskArchiveBatchResponse> {
      return client.post('/tasks/archive')
    },
    listArchivedTasks(): Promise<ArchivedTaskListResponse> {
      return client.get('/tasks/archived?limit=200&page=1')
    },
    unarchiveTask(taskId: number): Promise<TaskArchiveResponse> {
      return client.post(`/tasks/${taskId}/unarchive`)
    },
    deleteTask(taskId: number): Promise<{ message: string }> {
      return client.delete(`/tasks/${taskId}`)
    },
    deleteArchivedTasks(): Promise<TaskArchiveBatchResponse> {
      return client.delete('/tasks/archived')
    },
  }
}
