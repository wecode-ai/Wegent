import type {
  Task,
  TaskDetail,
  TurnFileChangesDiffResponse,
  TurnFileChangesRevertResponse,
} from '@/types/api'
import type { HttpClient } from './http'

const WEWORK_CLIENT_ORIGIN = 'wework'

export function createTaskApi(client: HttpClient) {
  return {
    getTaskDetail(taskId: number): Promise<TaskDetail> {
      return client.get(`/tasks/${taskId}?client_origin=${WEWORK_CLIENT_ORIGIN}`)
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
  }
}
