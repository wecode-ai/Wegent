// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

interface Page<T> {
  total: number
  items: T[]
}

/** Load a complete catalog while respecting the API's page size limit. */
export async function fetchAllPages<T extends { id: number }>(
  fetchPage: (page: number, limit: number) => Promise<Page<T>>
): Promise<Page<T>> {
  const limit = 100
  const itemsById = new Map<number, T>()
  let page = 1
  let response: Page<T>

  do {
    response = await fetchPage(page, limit)
    for (const item of response.items) itemsById.set(item.id, item)
    page += 1
  } while (response.items.length === limit && (page - 1) * limit < response.total)

  return { total: response.total, items: [...itemsById.values()] }
}
