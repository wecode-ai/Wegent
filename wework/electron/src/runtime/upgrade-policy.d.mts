export interface UpgradeRelease {
  version: string
  minSourceVersion: string
  url: string
  sha256: string
  sourceSha: string
  bytes: number
  dataSchema: number
  readableDataSchemas: number[]
  revoked: boolean
  notes?: string
}
export interface UpgradeEdge {
  from: string
  to: string
  fromSha256: string
  toSha256: string
  fromSourceSha: string
  toSourceSha: string
  runId: string
  evidenceSha256: string
  upgrade: 'passed'
  rollback: 'passed'
  revoked: boolean
}
export interface UpgradeCatalog {
  schemaVersion: 1
  channel: 'stable' | 'beta'
  platform: 'macos' | 'windows' | 'linux'
  arch: 'arm64' | 'x64'
  releases: UpgradeRelease[]
  edges: UpgradeEdge[]
}
export function compareVersions(left: string, right: string): number
export function validateUpgradeCatalog(input: unknown): UpgradeCatalog
export function planUpgrade(
  catalog: UpgradeCatalog,
  currentVersion: string
): {
  targetVersion: string
  path: string[]
  next: UpgradeRelease
} | null
