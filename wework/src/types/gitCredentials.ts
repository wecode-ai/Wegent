export type GitCredentialProvider = 'github' | 'gitlab' | 'gitee' | 'gitea' | 'gerrit'

export interface GitAccountSyncSummaryItem {
  id: string | null
  domain: string
  provider: GitCredentialProvider
  login: string | null
  email: string | null
  effective: boolean
  duplicate_of: string | null
}

export interface GitAccountSyncSummary {
  accounts: GitAccountSyncSummaryItem[]
  effective_count: number
  duplicate_count: number
}

export interface GitCliSyncResult {
  provider: 'gh' | 'glab'
  domain: string
  status: 'configured' | 'not_installed' | 'failed'
  reason_code: string | null
}

export interface DeviceGitAccountSyncResult {
  device_id: string
  status: 'synced' | 'synced_with_warnings'
  synced_domains: string[]
  removed_domains: string[]
  duplicate_domains: string[]
  identity_warning_domains: string[]
  cli: GitCliSyncResult[]
  warning_codes: string[]
}
