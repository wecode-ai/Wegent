export interface ConnectionEventSubscription {
  match?: Record<string, unknown> | null
  subscription_key: string
  source: {
    name: string
    configurationSummary?: string
    providerId?: string
    profile?: string
    kind?: string
    monitoredObjects?: { entityKind: string; number: number }[]
  }
  status: string
  error_code?: string | null
  waiting_goal?: boolean
  observation_id?: string
  observed_events?: number
  last_collected_at?: number
  refresh_pending?: boolean
  handled_events?: {
    topicId?: string
    version?: string
    external?: {
      headSha?: string
      objectKind?: string
      eventType?: string
      conclusion?: string
      status?: string
    }
  }[]
  resource_events?: ResourceEventFact[]
  resource_states?: ResourceState[]
}

export interface ResourceState {
  kind: string
  provider: string
  topicId: string
  observedAt: string
  data: Record<string, unknown>
  errorCode?: string | null
}

export interface ResourceEventFact {
  key: string
  topicId?: string
  external?: { headSha?: string; objectKind?: string; conclusion?: string; status?: string }
}

export type ConnectionGoalWaitState = 'waiting' | 'received'

export function connectionGoalWaitState(value: unknown): ConnectionGoalWaitState | undefined {
  const items = connectionEventSubscriptions(value).filter(item => item.waiting_goal === true)
  if (items.some(item => item.status === 'pending' || item.status === 'resuming_goal'))
    return 'received'
  return items.some(item => item.status === 'armed') ? 'waiting' : undefined
}

export function connectionEventSubscriptions(
  value: unknown,
  includeDelivered = false
): ConnectionEventSubscription[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (item): item is ConnectionEventSubscription =>
      item !== null &&
      typeof item === 'object' &&
      typeof item.subscription_key === 'string' &&
      typeof item.source?.name === 'string' &&
      [
        'preparing',
        'armed',
        'pending',
        'resuming_goal',
        'needs_attention',
        'error',
        ...(includeDelivered ? ['delivered'] : []),
      ].includes(item.status)
  )
}
