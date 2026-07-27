export interface EnvironmentInfo {
  additions: string
  deletions: string
  executionTarget: 'local' | 'cloud'
  isGitRepository?: boolean
  deviceId?: string
  workspacePath?: string
  workspaceRoots?: string[]
  branchName?: string
  createPullRequestUrl?: string
  error?: string
  loading?: boolean
}
