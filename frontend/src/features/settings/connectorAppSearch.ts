// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export interface ConnectorAppSearchFields {
  name: string
  slug: string
  description?: string | null
  keywords?: string[]
}

/** Match an app against a case-insensitive substring of its searchable fields. */
export function matchesConnectorAppQuery(app: ConnectorAppSearchFields, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  const haystack = [app.name, app.slug, app.description ?? '', ...(app.keywords ?? [])]
  return haystack.some(value => value.toLowerCase().includes(needle))
}
