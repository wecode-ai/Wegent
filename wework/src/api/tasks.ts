import type { TurnFileChangesDiffResponse, TurnFileChangesRevertResponse } from '@/types/api'
import type { HttpClient } from './http'

export function createTaskApi(client: HttpClient) {
  return {
    getTurnFileChangesDiff(subtaskId: string): Promise<TurnFileChangesDiffResponse> {
      return client.get(`/subtasks/${subtaskId}/file-changes/diff`)
    },
    revertTurnFileChanges(subtaskId: string): Promise<TurnFileChangesRevertResponse> {
      return client.post(`/subtasks/${subtaskId}/file-changes/revert`)
    },
  }
}
