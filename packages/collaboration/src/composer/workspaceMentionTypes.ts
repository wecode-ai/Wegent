import type { RuntimeWorkspaceSearchItem } from '@wegent/chat-core/runtime-workspace-search'
export type { RuntimeWorkspaceSearchItem } from '@wegent/chat-core/runtime-workspace-search'
export interface ComposerMentionPresentation {
  kind: 'extension' | 'skill' | 'app' | 'cloud' | 'conversation'
  key: string
  title: string
  description?: string
  metaLabel: string
  testId: string
  enabled: boolean
  statusLabel?: string
}
export interface ComposerExternalMentionPresentation {
  id: string
  type: 'agent' | 'user'
  title: string
  metaLabel: string
  testId?: string
}
export interface WorkspaceMentionSearchApi {
  searchWorkspaceEntries?: (
    deviceId: string,
    root: string,
    query: string,
    cancellationToken?: string
  ) => Promise<{ files: RuntimeWorkspaceSearchItem[] }>
}
export interface WorkspaceMentionTarget {
  deviceId: string
  path: string
}
