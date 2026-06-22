import type {
  TurnFileChangesDiffResponse,
  TurnFileChangesRevertResponse,
} from '@/types/api'
import type { HttpClient } from './http'

export function createTaskApi(client: HttpClient) {
  return {
    getTurnFileChangesDiff(subtaskId: number): Promise<TurnFileChangesDiffResponse> {
      return client.get(`/subtasks/${subtaskId}/file-changes/diff`)
    },
    revertTurnFileChanges(subtaskId: number): Promise<TurnFileChangesRevertResponse> {
      return client.post(`/subtasks/${subtaskId}/file-changes/revert`)
    },
  }
}
