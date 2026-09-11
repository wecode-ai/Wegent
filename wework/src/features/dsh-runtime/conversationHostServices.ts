import type { DeviceInfo } from '@/types/api'
import type { EnvironmentInfo } from '@/types/environment'

export const WEWORK_HOST_SERVICES = {
  conversationOutputs: 'wework.conversation.outputs',
  environment: 'wework.environment',
} as const

export type ConversationSummaryResource =
  | {
      readonly kind: 'file'
      readonly path: string
    }
  | {
      readonly kind: 'url'
      readonly url: string
    }

export type ConversationOutputKind = 'file' | 'image' | 'website'
export type ConversationOutputSourceKind = 'attachment' | 'memory' | 'website'

export interface ConversationOutput {
  readonly id: string
  readonly kind: ConversationOutputKind
  readonly resource: ConversationSummaryResource
  readonly title: string
}

export interface ConversationOutputSource {
  readonly id: string
  readonly kind: ConversationOutputSourceKind
  readonly resource?: ConversationSummaryResource
  readonly title: string
}

export interface ConversationOutputsSnapshot {
  readonly outputs: readonly ConversationOutput[]
  readonly sources: readonly ConversationOutputSource[]
}

export interface ConversationOutputsHostService {
  read(): ConversationOutputsSnapshot
}

export interface EnvironmentHostService {
  read(): {
    readonly devices: DeviceInfo[]
    readonly info: EnvironmentInfo
  }
}
