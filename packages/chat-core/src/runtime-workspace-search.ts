export interface RuntimeWorkspaceSearchItem {
  root: string
  path: string
  fileName: string
  matchType: 'file' | 'directory'
  score: number
  indices?: number[] | null
}

export interface RuntimeWorkspaceSearchResponse {
  files: RuntimeWorkspaceSearchItem[]
}
