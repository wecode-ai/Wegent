// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { AlertCircle, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { loadAsyncCardComponent } from '../registry'
import type { AsyncCardComponent, AsyncCardComponentProps } from '../types'

export function AsyncCardRenderer(props: AsyncCardComponentProps) {
  const { card } = props
  const { t } = useTranslation('chat')
  const [Component, setComponent] = useState<AsyncCardComponent | null>(null)

  useEffect(() => {
    let active = true
    void loadAsyncCardComponent(card.card_type).then(component => {
      if (active) setComponent(() => component)
    })
    return () => {
      active = false
    }
  }, [card.card_type])

  if (card.card_status === 'error') {
    return (
      <div
        className="max-w-xl rounded-xl border border-red-200 bg-red-50 p-4 text-red-700"
        data-testid={`async-card-error-${card.card_id}`}
      >
        <div className="flex items-center gap-2 font-medium">
          <AlertCircle className="h-4 w-4" />
          {t('asyncCards.failed')}
        </div>
        {card.card_error ? <p className="mt-2 text-sm">{card.card_error}</p> : null}
      </div>
    )
  }

  if (!Component) {
    const preview = card.card_preview_data || {}
    return (
      <div
        className="max-w-xl rounded-xl border border-border bg-surface p-4"
        data-testid={`async-card-loading-${card.card_id}`}
      >
        <div className="flex items-center gap-3">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
          <div>
            <div className="text-sm font-medium text-text-primary">
              {String(preview.title || t('asyncCards.loading'))}
            </div>
            <div className="mt-1 text-xs text-text-secondary">
              {String(preview.progress_text || t('asyncCards.pleaseWait'))}
            </div>
          </div>
        </div>
      </div>
    )
  }

  return <Component {...props} />
}
