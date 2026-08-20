import type { HttpClient } from './http'

export interface ExternalEventType {
  provider: string
  event_type: string
  category: string
  description: string
  /** Trailing-edge window in seconds; null means the first event fires immediately. */
  window_seconds?: number | null
  /** Coalesce events arriving while a repair round runs into one follow-up round. */
  merge_while_running?: boolean
  /** Delivery fulfillment kind an upstream stage must deliver to auto-bind. */
  reference_kind?: string | null
  reference_name?: string | null
  /** Human-readable opaque reference shape the provider expects. */
  opaque_ref_format?: string | null
  opaque_ref_example?: string | null
}

export function createExternalEventApi(client: HttpClient) {
  return {
    catalog() {
      return client.get<ExternalEventType[]>('/v1/external-events/catalog')
    },
  }
}
