// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useMemo, useSyncExternalStore } from 'react'

import type { CollaborationProject } from '../types'
import {
  defaultScheduleViewOptions,
  sameScheduleViewOptions,
  scheduleViewOptionsFromConfig,
  type ScheduleViewOptions,
} from './model'

const STORAGE_PREFIX = 'collaboration-schedule-view'

function isScheduleViewOptions(value: unknown): value is ScheduleViewOptions {
  if (!value || typeof value !== 'object') return false
  const options = value as Partial<ScheduleViewOptions>
  return (
    typeof options.status === 'string' &&
    typeof options.assignee === 'string' &&
    typeof options.tag === 'string' &&
    ['none', 'status', 'priority', 'assignee', 'tag'].includes(options.groupBy ?? '') &&
    ['start_asc', 'due_asc', 'updated_desc', 'priority_desc'].includes(options.sortBy ?? '')
  )
}

export function readPersonalScheduleViewOptions(
  storage: Pick<Storage, 'getItem'>,
  key: string | null
): ScheduleViewOptions | null {
  if (!key) return null
  try {
    const raw = storage.getItem(key)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return isScheduleViewOptions(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function writePersonalScheduleViewOptions(
  storage: Pick<Storage, 'setItem' | 'removeItem'>,
  key: string | null,
  options: ScheduleViewOptions | null
) {
  if (!key) return
  try {
    if (options) {
      storage.setItem(key, JSON.stringify(options))
    } else {
      storage.removeItem(key)
    }
  } catch {
    // Keep the current in-memory options when browser storage is unavailable.
  }
}

const getServerOptions = () => null

function createScheduleViewStore(key: string | null) {
  let snapshot =
    typeof window === 'undefined' ? null : readPersonalScheduleViewOptions(window.localStorage, key)
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set(options: ScheduleViewOptions | null) {
      snapshot = options
      if (typeof window !== 'undefined')
        writePersonalScheduleViewOptions(window.localStorage, key, options)
      listeners.forEach(listener => listener())
    },
  }
}

export function useProjectScheduleViewOptions(project: CollaborationProject | null) {
  const projectOptions = useMemo(
    () =>
      project
        ? scheduleViewOptionsFromConfig(project.board_config?.schedule_view)
        : defaultScheduleViewOptions,
    [project?.board_config?.schedule_view]
  )
  const storageKey = project
    ? `${STORAGE_PREFIX}:${project.project_store}:${project.id}:${project.current_user_id ?? 'local'}`
    : null
  const store = useMemo(() => createScheduleViewStore(storageKey), [storageKey])
  const personalOptions = useSyncExternalStore(store.subscribe, store.getSnapshot, getServerOptions)

  const options = personalOptions ?? projectOptions
  const hasPersonalOverride =
    personalOptions !== null && !sameScheduleViewOptions(personalOptions, projectOptions)

  const changeOptions = useCallback(
    (next: ScheduleViewOptions) => {
      const personal = sameScheduleViewOptions(next, projectOptions) ? null : next
      store.set(personal)
    },
    [projectOptions, store]
  )

  const resetOptions = useCallback(() => {
    store.set(null)
  }, [store])

  return {
    acceptProjectOptions: resetOptions,
    changeOptions,
    hasPersonalOverride,
    options,
    resetOptions,
  }
}
