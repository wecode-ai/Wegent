export interface MessageCenterSource {
  id: string
  conversationId?: string
  name: string
  kind: 'direct' | 'group'
  included: boolean
  paused: boolean
}

export interface MessageCenterRecord {
  id: string
  title: string
  sourceId: string
  sourceName: string
  sender: string
  message: string
  at: string
  decision: 'reply' | 'needs_user' | 'skip' | null
  progress: 'queued' | 'generating' | 'ready_to_send' | 'submitting' | 'complete'
  delivery: 'none' | 'submitted' | 'confirmed' | 'failed' | 'unknown'
  receipt?: {
    id: string
    verifiedAt?: string
    kind: 'channel_receipt' | 'recipient_verified'
  }
  reply?: string
  reason?: string
  evidence?: Array<{ label: string; excerpt?: string }>
  attempts?: Array<{ at: string; status: MessageCenterRecord['delivery']; reason?: string }>
  takenOver: boolean
  canTakeOver?: boolean
  canVerify?: boolean
  originalUrl?: string
  policyVersion?: number
  deviceName: string
}

export type MessageCenterCommand =
  | { type: 'takeOver'; recordId: string }
  | { type: 'verifyDelivery'; recordId: string }

export interface MessageCenterSnapshot {
  identity: { id: string; account: string; organization: string } | null
  deviceName: string
  updatedAt: string | null
  status:
    | 'unavailable'
    | 'disconnected'
    | 'disabled'
    | 'active'
    | 'paused'
    | 'offline'
    | 'model_unavailable'
    | 'component_unavailable'
  records: MessageCenterRecord[]
  sources: MessageCenterSource[]
  policyVersion: number | null
  syncGap?: string
  notificationUnavailable?: boolean
  capabilities: readonly (MessageCenterCommand['type'] | 'refresh')[]
}

export interface MessageCenterScope {
  userId: number
  deviceId: string
}

export interface StandInMessageCenterApi {
  /** Read records and policy for the verified DingTalk account and organization on this device. */
  read(scope: MessageCenterScope): Promise<MessageCenterSnapshot>
  apply(
    scope: MessageCenterScope,
    expected: { identityId: string; policyVersion: number },
    command: MessageCenterCommand
  ): Promise<MessageCenterSnapshot>
  /** Report a binding update before publishing new facts for that scope. */
  subscribeInvalidation(
    scope: MessageCenterScope,
    onInvalidate: (change: 'identity' | 'facts', identityId?: string) => void
  ): () => void
}
