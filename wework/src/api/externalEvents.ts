import type { HttpClient } from './http'

export interface ExternalEventType {
  provider: string
  event_type: string
  category: string
  description: string
}

export function createExternalEventApi(client: HttpClient) {
  return {
    catalog() {
      return client.get<ExternalEventType[]>('/v1/external-events/catalog')
    },
  }
}
