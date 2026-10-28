// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react'
import type { CollaborationTranslate } from '../i18n'

// Each mounted panel owns its requests; the settings shell never awaits them.
export function usePanelData<T>(load: (() => Promise<T>) | undefined, enabled = true) {
  const [snapshot, setSnapshot] = useState<{
    load: typeof load
    data?: T
    loading: boolean
    error?: unknown
  }>({ load, loading: true })
  const revision = useRef(0)
  const currentLoad = useRef(load)
  currentLoad.current = load
  const setData = useCallback(
    (update: SetStateAction<T | undefined>) => {
      if (!load || !enabled || currentLoad.current !== load) return
      revision.current++
      setSnapshot(current =>
        current.load !== load
          ? current
          : {
              ...current,
              loading: false,
              error: undefined,
              data:
                typeof update === 'function'
                  ? (update as (data?: T) => T | undefined)(current.data)
                  : update,
            }
      )
    },
    [load, enabled]
  )
  const refresh = useCallback(async () => {
    if (!load || !enabled || currentLoad.current !== load) return
    const request = ++revision.current
    setSnapshot(current => ({
      load,
      data: current.load === load ? current.data : undefined,
      loading: true,
    }))
    try {
      const next = await load()
      if (request === revision.current && currentLoad.current === load)
        setSnapshot({ load, data: next, loading: false })
    } catch (cause) {
      if (request === revision.current && currentLoad.current === load)
        setSnapshot(current => ({ ...current, error: cause, loading: false }))
    }
  }, [load, enabled])
  const invalidate = useCallback(() => {
    revision.current++
    currentLoad.current = undefined
  }, [])
  useEffect(() => {
    currentLoad.current = load
    if (enabled) void refresh()
    return invalidate
  }, [refresh, enabled, load, invalidate])
  const current =
    snapshot.load === load ? snapshot : { data: undefined, loading: enabled, error: undefined }
  return { data: current.data, loading: current.loading, error: current.error, setData, refresh }
}

export function PanelFeedback({
  state,
  translate,
  testId,
}: {
  state: { data?: unknown; loading: boolean; error: unknown; refresh(): Promise<void> }
  translate: CollaborationTranslate
  testId: string
}) {
  if (state.error !== undefined)
    return (
      <div
        role="alert"
        className="mb-4 flex items-center gap-3 text-sm text-destructive"
        data-testid={`${testId}-error`}
      >
        <span>{translate('todo.load_collaboration_data_failed', '加载协作数据失败')}</span>
        <button
          type="button"
          className="min-h-11 rounded-md px-3 text-text-primary hover:bg-muted md:min-h-8"
          data-testid={`${testId}-retry`}
          onClick={() => void state.refresh()}
        >
          {translate('common.retry', '重试')}
        </button>
      </div>
    )
  return state.loading && state.data === undefined ? (
    <p role="status" className="py-6 text-sm text-text-muted" data-testid={`${testId}-loading`}>
      {translate('common.loading', '加载中…')}
    </p>
  ) : null
}
