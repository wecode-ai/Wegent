import type {
  TurnFileChangesDiffResponse,
  TurnFileChangesRevertResponse,
} from '@/types/api'
import type { HttpClient } from './http'

export function createTaskApi(client: HttpClient) {
  return {
    getTurnFileChangesDiff(turnId: number): Promise<TurnFileChangesDiffResponse> {
      return client.get(`/subtasks/${turnId}/file-changes/diff`)
    },
    revertTurnFileChanges(turnId: number): Promise<TurnFileChangesRevertResponse> {
      return client.post(`/subtasks/${turnId}/file-changes/revert`)
    },
  }
}
