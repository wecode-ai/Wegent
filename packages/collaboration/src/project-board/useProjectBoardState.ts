// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  defaultProjectBoardSort,
  type ProjectBoardColumnSorts,
  type ProjectBoardSort,
} from './projectBoardSorting'
import {
  createBoardSortPreferences,
  createBoardFocusPreference,
  createBoardGroupPreference,
} from './projectBoardPreferences'

export type ProjectBoardGroupBy = 'status' | 'priority' | 'assignee' | 'tag'

export interface ProjectBoardStateOptions {
  fixedGroupBy?: ProjectBoardGroupBy
  defaultGroupBy: ProjectBoardGroupBy
  defaultSort?: ProjectBoardSort
  defaultColumnSorts?: ProjectBoardColumnSorts
  viewScope?: string
  focusStorageKey: string | null
  personalGroupStorageKey: string | null
  personalSortStorageKey?: string | null
}

export function useProjectBoardState({
  fixedGroupBy,
  defaultGroupBy,
  defaultSort = defaultProjectBoardSort,
  defaultColumnSorts,
  viewScope,
  focusStorageKey,
  personalGroupStorageKey,
  personalSortStorageKey = null,
}: ProjectBoardStateOptions) {
  const groupScope = JSON.stringify([
    defaultGroupBy,
    fixedGroupBy,
    personalGroupStorageKey,
    viewScope,
  ])
  const group = useMemo(
    () =>
      createBoardGroupPreference(
        groupScope,
        fixedGroupBy ? null : personalGroupStorageKey,
        fixedGroupBy ?? defaultGroupBy
      ),
    [groupScope, fixedGroupBy, personalGroupStorageKey, defaultGroupBy]
  )
  const selectedGroupBy = useSyncExternalStore(
    group.subscribe,
    group.getSnapshot,
    group.getServerSnapshot
  )
  const groupBy = fixedGroupBy ?? selectedGroupBy
  const [previousScope, setPreviousScope] = useState(group.scope)
  const [groupFilter, setGroupFilter] = useState('')
  const [query, setQuery] = useState('')
  const sorts = useMemo(
    () => createBoardSortPreferences(personalSortStorageKey),
    [personalSortStorageKey]
  )
  const columnSorts = useSyncExternalStore(
    sorts.subscribe,
    sorts.getSnapshot,
    sorts.getServerSnapshot
  )
  const focus = useMemo(() => createBoardFocusPreference(focusStorageKey), [focusStorageKey])
  const focusExecutionColumns = useSyncExternalStore(
    focus.subscribe,
    focus.getSnapshot,
    focus.getServerSnapshot
  )
  const [quickCreateStatus, setQuickCreateStatus] = useState<string | null>(null)
  const [externalGroupFilter, setExternalGroupFilter] = useState('')
  const [externalQuery, setExternalQuery] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  if (previousScope !== group.scope) {
    setPreviousScope(group.scope)
    setGroupFilter('')
    setQuery('')
    setQuickCreateStatus(null)
  }

  const getColumnSort = useCallback(
    (columnKey: string): ProjectBoardSort =>
      columnSorts[JSON.stringify([groupBy, columnKey])] ??
      defaultColumnSorts?.[columnKey] ??
      defaultSort,
    [columnSorts, defaultColumnSorts, defaultSort, groupBy]
  )

  const selectColumnSort = useCallback(
    (columnKey: string, value: ProjectBoardSort) =>
      sorts.select(JSON.stringify([groupBy, columnKey]), value),
    [groupBy, sorts]
  )

  const selectGroupBy = useCallback(
    (nextGroupBy: ProjectBoardGroupBy) => {
      if (fixedGroupBy) return
      if (groupBy !== nextGroupBy && scrollRef.current) {
        scrollRef.current.scrollLeft = 0
      }
      group.select(nextGroupBy)
      setGroupFilter('')
    },
    [fixedGroupBy, groupBy, group]
  )

  return {
    externalGroupFilter,
    externalQuery,
    focusExecutionColumns,
    groupBy,
    groupFilter,
    query,
    getColumnSort,
    quickCreateStatus,
    scrollRef,
    selectGroupBy,
    selectColumnSort,
    setExternalGroupFilter,
    setExternalQuery,
    setGroupFilter,
    setQuery,
    setQuickCreateStatus,
    toggleFocusExecutionColumns: focus.toggle,
  }
}
