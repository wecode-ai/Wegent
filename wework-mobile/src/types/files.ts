import type { Attachment, TurnFileChangesSummary } from '../../../packages/chat-core/src/runtime'
import type { MobileWorkspaceFileTarget } from '@/domain/mobileFileTarget'

export type MobileFileRequest =
  | {
      kind: 'workspace'
      target: MobileWorkspaceFileTarget
      path: string
      lineStart?: number
      lineEnd?: number
    }
  | { kind: 'attachment'; attachment: Attachment }
  | { kind: 'local'; uri: string; name: string; mimeType: string }
  | { kind: 'image'; dataUri: string; name: string }
  | { kind: 'diff'; summary: TurnFileChangesSummary; path?: string }

export interface LoadedMobileFile {
  name: string
  path: string
  mimeType: string
  size: number
  uri: string
  text?: string
  truncated?: boolean
  kind: 'text' | 'binary' | 'diff'
  lineStart?: number
  lineEnd?: number
}

export interface RecentMobileFile {
  key: string
  request: MobileFileRequest
  name: string
  path: string
  position: number
}
