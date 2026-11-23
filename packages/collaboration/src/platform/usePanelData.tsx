import { Button as ControlButton } from '../markdown/Button'
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useMemo, useSyncExternalStore, type SetStateAction } from 'react'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import type { CollaborationTranslate } from '../i18n'

// Each mounted panel owns its requests; the settings shell never awaits them.
export function usePanelData<T>(load: (() => Promise<T>) | undefined, enabled = true) {
  const resource = useMemo(
    () =>
      createAsyncResource<T>('panel', () => load!(), {
        refreshOnSubscribe: true,
      }),
    [load]
  )
  const snapshot = useSyncExternalStore(
    enabled && load ? resource.subscribe : subscribeIdleResource,
    resource.getSnapshot,
    getIdleResourceSnapshot
  )
  const setData = useCallback(
    (update: SetStateAction<T | undefined>) => {
      if (!load || !enabled) return
      resource.update(data =>
        typeof update === 'function' ? (update as (data?: T) => T | undefined)(data) : update
      )
    },
    [load, enabled, resource]
  )
  const refresh = useCallback(async () => {
    if (load && enabled) await resource.reload()
  }, [load, enabled, resource])
  return {
    data: snapshot.data,
    loading:
      enabled && Boolean(load) && (snapshot.status === 'idle' || snapshot.status === 'loading'),
    error: snapshot.status === 'loading' ? undefined : snapshot.error,
    setData,
    refresh,
  }
}

export function PanelFeedback({
  state,
  translate,
  testId,
}: {
  state: {
    data?: unknown
    loading: boolean
    error: unknown
    refresh(): Promise<void>
  }
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
        <ControlButton
          variant="unstyled"
          type="button"
          className="min-h-11 rounded-md px-3 text-text-primary hover:bg-muted md:min-h-8"
          data-testid={`${testId}-retry`}
          onClick={() => void state.refresh()}
        >
          {translate('common.retry', '重试')}
        </ControlButton>
      </div>
    )
  return state.loading && state.data === undefined ? (
    <p role="status" className="py-6 text-sm text-text-muted" data-testid={`${testId}-loading`}>
      {translate('common.loading', '加载中…')}
    </p>
  ) : null
}
