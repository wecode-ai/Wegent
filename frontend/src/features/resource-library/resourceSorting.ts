// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { Group } from '@/types/group'

export type ResourceLibrarySortMode = 'default' | 'latest'

export type ResourceLibrarySortSource = 'personal' | 'group' | 'system'

type ResourceTimestamp = string | number | Date | null | undefined

interface ResourceLibrarySortOptions<T> {
  sortMode: ResourceLibrarySortMode
  groupDisplayNames?: Map<string, string>
  getSource: (item: T) => ResourceLibrarySortSource
  getName: (item: T) => string | null | undefined
  getDisplayName?: (item: T) => string | null | undefined
  getNamespace?: (item: T) => string | null | undefined
  getCreatedAt?: (item: T) => ResourceTimestamp
  getUpdatedAt?: (item: T) => ResourceTimestamp
  getStableId?: (item: T) => string | number | null | undefined
}

const sourceRanks: Record<ResourceLibrarySortSource, number> = {
  personal: 0,
  group: 1,
  system: 2,
}

const nameCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
})

export function getResourceLibrarySortMode(
  value: string | null | undefined
): ResourceLibrarySortMode {
  return value === 'latest' ? 'latest' : 'default'
}

export function buildGroupDisplayNameMap(groups: Group[]): Map<string, string> {
  return new Map(groups.map(group => [group.name, group.display_name || group.name]))
}

function compareText(left: string | null | undefined, right: string | null | undefined): number {
  return nameCollator.compare(left || '', right || '')
}

function getTimestamp(value: ResourceTimestamp): number | null {
  if (!value) {
    return null
  }

  if (value instanceof Date) {
    const time = value.getTime()
    return Number.isNaN(time) ? null : time
  }

  if (typeof value === 'number') {
    return Number.isNaN(value) ? null : value
  }

  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

function getSortTimestamp<T>(item: T, options: ResourceLibrarySortOptions<T>): number | null {
  return getTimestamp(options.getUpdatedAt?.(item)) ?? getTimestamp(options.getCreatedAt?.(item))
}

function compareByDefault<T>(left: T, right: T, options: ResourceLibrarySortOptions<T>): number {
  const leftSource = options.getSource(left)
  const rightSource = options.getSource(right)
  const sourceResult = sourceRanks[leftSource] - sourceRanks[rightSource]

  if (sourceResult !== 0) {
    return sourceResult
  }

  if (leftSource === 'group') {
    const leftNamespace = options.getNamespace?.(left)
    const rightNamespace = options.getNamespace?.(right)
    const leftGroupName =
      (leftNamespace && options.groupDisplayNames?.get(leftNamespace)) || leftNamespace
    const rightGroupName =
      (rightNamespace && options.groupDisplayNames?.get(rightNamespace)) || rightNamespace
    const groupResult = compareText(leftGroupName, rightGroupName)

    if (groupResult !== 0) {
      return groupResult
    }
  }

  const nameResult = compareText(
    options.getDisplayName?.(left) || options.getName(left),
    options.getDisplayName?.(right) || options.getName(right)
  )

  if (nameResult !== 0) {
    return nameResult
  }

  const namespaceResult = compareText(options.getNamespace?.(left), options.getNamespace?.(right))

  if (namespaceResult !== 0) {
    return namespaceResult
  }

  return compareText(
    String(options.getStableId?.(left) ?? ''),
    String(options.getStableId?.(right) ?? '')
  )
}

export function sortResourceLibraryItems<T>(
  items: T[],
  options: ResourceLibrarySortOptions<T>
): T[] {
  return [...items].sort((left, right) => {
    if (options.sortMode === 'latest') {
      const leftTimestamp = getSortTimestamp(left, options)
      const rightTimestamp = getSortTimestamp(right, options)

      if (leftTimestamp !== rightTimestamp) {
        if (leftTimestamp === null) {
          return 1
        }

        if (rightTimestamp === null) {
          return -1
        }

        return rightTimestamp - leftTimestamp
      }
    }

    return compareByDefault(left, right, options)
  })
}
