// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { CollaborationTranslate } from '../i18n'
import type { DeviceCatalogState } from './useDeviceCatalog'

export function DeviceCatalogFeedback({
  catalog,
  translate,
}: {
  catalog: DeviceCatalogState
  translate: CollaborationTranslate
}) {
  return (
    <>
      {catalog.errors.map(({ source, error, retry }) => (
        <div
          key={source}
          className="flex items-center gap-3 py-3 text-sm text-text-secondary"
          role="alert"
          data-testid={`collaboration-devices-error-${source}`}
        >
          <span>
            {translate(
              `todo.device_catalog_${source}_failed`,
              source === 'local' ? '本地设备加载失败' : '云端设备加载失败'
            )}
            {error instanceof Error ? `：${error.message}` : ''}
          </span>
          <button
            type="button"
            className="collaboration-link-button"
            data-testid={`collaboration-devices-retry-${source}`}
            onClick={() => void retry()}
          >
            {translate('common.retry', '重试')}
          </button>
        </div>
      ))}
      {catalog.pending ? (
        <div
          role="status"
          aria-busy="true"
          aria-label={translate('common.loading', '正在加载…')}
          data-testid="collaboration-devices-loading"
          className="py-3 text-sm text-text-muted"
        >
          {catalog.items.length ? (
            translate('todo.device_catalog_loading_more', '正在加载其他设备…')
          ) : (
            <div className="space-y-5 p-4 motion-safe:animate-pulse" aria-hidden="true">
              {[0, 1].map(row => (
                <div key={row} className="flex items-center gap-4">
                  <div className="h-10 w-10 rounded-lg bg-muted" />
                  <div className="h-4 w-40 rounded bg-muted" />
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </>
  )
}
