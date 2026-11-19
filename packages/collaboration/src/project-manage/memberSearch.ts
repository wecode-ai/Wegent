// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { createAsyncResource } from '@wegent/chat-core/async-resource'

export function createMemberSearchResource<User>(
  key: string,
  query: string,
  search: (query: string) => Promise<{ users: User[] }>
) {
  return createAsyncResource(key, async () => (await search(query)).users, { delayMs: 250 })
}

export function filterMemberSearchResults<User extends { id: number }>(
  users: User[],
  members: { user_id: number }[]
): User[] {
  const existing = new Set(members.map(member => member.user_id))
  return users.filter(user => !existing.has(user.id))
}
