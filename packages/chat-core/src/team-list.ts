// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

interface TeamPage<T> {
  total: number
  items: T[]
}

/** Load the complete agent catalog while respecting the API's page size limit. */
export async function fetchAllTeams<T extends { id: number }>(
  fetchPage: (page: number, limit: number) => Promise<TeamPage<T>>
): Promise<TeamPage<T>> {
  const limit = 100
  const teams = new Map<number, T>()
  let page = 1
  let response: TeamPage<T>

  do {
    response = await fetchPage(page, limit)
    for (const team of response.items) teams.set(team.id, team)
    page += 1
  } while (response.items.length === limit && (page - 1) * limit < response.total)

  return { total: response.total, items: [...teams.values()] }
}
