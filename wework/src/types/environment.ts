export interface EnvironmentInfo {
  additions: string
  deletions: string
  executionTarget: 'local' | 'cloud'
  deviceId?: string
  branchName?: string
  createPullRequestUrl?: string
  error?: string
  loading?: boolean
}
