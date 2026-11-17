// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useState, type ReactNode } from 'react'

import type { CollaborationTranslate } from '../i18n'

export interface ProjectSettingsReadControl {
  status: 'loading' | 'ready' | 'error'
  reload(): void
}

export function ProjectSettingsReadBoundary({
  children,
  scope,
  disabled = false,
  read,
  translate,
  testId = 'collaboration-project-settings-read',
}: {
  children: ReactNode
  scope: object
  disabled?: boolean
  read?: ProjectSettingsReadControl
  translate: CollaborationTranslate
  testId?: string
}) {
  const ready = !read || read.status === 'ready'
  const [content, setContent] = useState({ scope, accepted: ready, generation: 0 })
  if (content.scope !== scope) {
    setContent({ scope, accepted: ready, generation: content.generation + 1 })
  } else if (ready && !content.accepted) {
    setContent({ ...content, accepted: true })
  }
  const hasContent = content.scope === scope && (ready || content.accepted)
  return (
    <>
      {read &&
        !ready &&
        (read.status === 'loading' ? (
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
        ))}
      {hasContent && (
        <fieldset
          key={content.generation}
          className="contents"
          disabled={!ready || disabled}
          inert={!ready || disabled}
          aria-busy={!ready}
        >
          {children}
        </fieldset>
      )}
    </>
  )
}
