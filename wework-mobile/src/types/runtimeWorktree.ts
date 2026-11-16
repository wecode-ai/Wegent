/** Cloud worktree protocol, matching wework/src/types/api.ts. */
export interface RuntimeWorktreeDeleteRequest {
  deviceId: string
  path: string
  preserveSnapshot?: boolean
}

export interface RuntimeManagedWorktreePayload {
  worktreeId: string
  path: string
  repositoryName: string
  sourcePath?: string | null
  permanent: boolean
  createdAt: number
  updatedAt: number
  snapshotRef?: string | null
  snapshotCommit?: string | null
  state: 'active' | 'restorable' | 'missing' | 'deleted' | (string & Record<never, never>)
  snapshotAt?: number | null
  gitCommonDir?: string | null
  lastError?: string | null
}

export interface RuntimeWorktreeMutationResponse {
  success: boolean
  deviceId: string
  worktree: RuntimeManagedWorktreePayload
  path?: string
  archivedTaskCount?: number
}
