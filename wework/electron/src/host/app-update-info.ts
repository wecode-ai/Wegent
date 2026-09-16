export type WeworkUpdateChannel = 'stable' | 'beta'

export type WeworkUpdateKind =
  | 'upgrade-stable'
  | 'upgrade-beta'
  | 'return-to-stable'
  | 'downgrade-to-stable'

export interface WeworkUpdateInfo {
  currentVersion: string
  version: string
  kind: WeworkUpdateKind
  body?: string
}
