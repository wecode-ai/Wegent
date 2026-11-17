// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react'

import type { CollaborationTranslate } from '../i18n'

export interface ProjectSettingsReadControl {
  status: 'loading' | 'ready' | 'error'
  reload(): void
}

export function ProjectSettingsReadBoundary({
  children,
  read,
  translate,
  testId = 'collaboration-project-settings-read',
}: {
  children: ReactNode
  read?: ProjectSettingsReadControl
  translate: CollaborationTranslate
  testId?: string
}) {
  if (!read || read.status === 'ready') return children
  return read.status === 'loading' ? (
    <div className="px-8 py-7 text-sm text-text-muted" data-testid={testId} role="status">
      {translate('common.loading', '正在加载…')}
    </div>
  ) : (
    <div className="px-8 py-7 text-sm text-destructive" data-testid={testId} role="alert">
      {translate('todo.load_failed', '加载失败')}
      <button
        className="collaboration-link-button ml-2"
        data-testid={`${testId}-retry`}
        type="button"
        onClick={read.reload}
      >
        {translate('common.retry', '重试')}
      </button>
    </div>
  )
}
