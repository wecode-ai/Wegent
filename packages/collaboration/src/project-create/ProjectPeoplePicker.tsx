// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react'
import { MemberSearchPicker } from '../controls/MemberSearchPicker'
import { runActiveMemberSearch } from '../project-manage/memberSearch'
import type { CollaborationUser } from '../types'
import type { ProjectCreateLabels } from './types'

export function ProjectPeoplePicker({
  labels,
  people,
  excludedIds,
  searchUsers,
  onSelect,
}: {
  labels: ProjectCreateLabels
  people: CollaborationUser[]
  excludedIds: number[]
  searchUsers?: (query: string) => Promise<CollaborationUser[]>
  onSelect(user: CollaborationUser): void
}) {
  const [query, setQuery] = useState('')
  const [response, setResponse] = useState<{
    query: string
    searchUsers: typeof searchUsers
    users: CollaborationUser[]
    failed: boolean
  } | null>(null)
  const current = response?.query === query && response.searchUsers === searchUsers
  const results = current ? response.users : []
  const failed = current && response.failed
  const loading = Boolean(query.trim() && searchUsers && !current)
  useEffect(() => {
    if (!query.trim() || !searchUsers) return
    let active = true
    const timer = window.setTimeout(() => {
      void runActiveMemberSearch({
        query: query.trim(),
        existingUserIds: new Set<number>(),
        search: async value => ({ users: await searchUsers(value) }),
        userId: user => user.id,
        isActive: () => active,
        onResults: users => setResponse({ query, searchUsers, users, failed: false }),
        onError: () => setResponse({ query, searchUsers, users: [], failed: true }),
      })
    }, 180)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [query, searchUsers])
  const candidates = (query.trim() ? results : people).filter(
    user => !excludedIds.includes(user.id)
  )
  return (
    <div>
      <small>{labels.availablePeople}</small>
      <MemberSearchPicker
        query={query}
        onQueryChange={setQuery}
        users={candidates}
        onSelect={onSelect}
        placeholder={labels.searchPeople}
        emptyLabel={labels.noAvailableCollaborators}
        addLabel={labels.addCollaborator}
        addingLabel={labels.addCollaborator}
        inputTestId="collaboration-project-create-people-search"
        resultTestId={id => 'collaboration-project-create-member-' + id}
        loadingLabel={loading ? labels.searchingPeople : undefined}
        error={failed ? labels.peopleSearchFailed : undefined}
        searchable={Boolean(searchUsers)}
      />
    </div>
  )
}
