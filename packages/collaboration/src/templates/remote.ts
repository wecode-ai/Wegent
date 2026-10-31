// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { validateTemplate } from './document'
import type {
  CollaborationTemplateRemote,
  TemplateListing,
  TemplateRecord,
  TemplateSummary,
} from './types'

export interface TemplateHttpClient {
  get<T>(path: string): Promise<T>
  post<T>(path: string, body?: unknown): Promise<T>
  put<T>(path: string, body?: unknown): Promise<T>
}

export function createCollaborationTemplateRemote(
  client: TemplateHttpClient
): CollaborationTemplateRemote {
  return {
    async list() {
      return (await client.get<{ items: TemplateSummary[] }>('/v1/collaboration-templates')).items
    },
    async discover(input) {
      const query = new URLSearchParams({
        resource_type: 'template',
        limit: '50',
      })
      if (input?.keyword) query.set('keyword', input.keyword)
      if (input?.cursor) query.set('cursor', input.cursor)
      const response = await client.get<{
        items: TemplateListing[]
        has_more: boolean
        next_cursor: string | null
      }>(`/resource-library/listings?${query}`)
      return {
        items: response.items,
        hasMore: response.has_more,
        nextCursor: response.next_cursor,
      }
    },
    async get(id) {
      const record = await client.get<TemplateRecord>(`/v1/collaboration-templates/${id}`)
      return { ...record, document: validateTemplate(record.document) }
    },
    async save(document, revision) {
      const record = await client.put<TemplateRecord>(
        `/v1/collaboration-templates/${encodeURIComponent(document.metadata.name)}`,
        { document, expectedRevision: revision }
      )
      return { ...record, document: validateTemplate(record.document) }
    },
    async install(id) {
      await client.post(`/resource-library/listings/${id}/install`, {
        target_namespace: 'default',
      })
    },
    async publish(id, version) {
      const record = await client.get<TemplateRecord>(`/v1/collaboration-templates/${id}`)
      await client.post('/resource-library/listings', {
        resource_type: 'template',
        source_id: id,
        display_name: record.document.spec.displayName,
        description: record.document.spec.description,
        version,
        tags: [],
        status: 'published',
        allow_personal_install: true,
        allow_group_install: true,
      })
    },
  }
}
