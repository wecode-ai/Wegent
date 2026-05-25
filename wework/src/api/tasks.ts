import type { TaskDetail, TaskListResponse } from '@/types/api'
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
      query.set('types', 'chat,code')
      return client.get(`/tasks/lite/personal?${query.toString()}`)
    },
    getTaskDetail(taskId: number): Promise<TaskDetail> {
      return client.get(`/tasks/${taskId}`)
    },
  }
}
