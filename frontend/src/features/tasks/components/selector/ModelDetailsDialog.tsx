// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { getModelCapabilities } from '@/lib/model-capabilities'
import type { Model } from '@/features/tasks/hooks/useModelSelection'

interface ModelDetailsBodyProps {
  model: Model
}

function formatTokenCount(
  value: number | null | undefined,
  unavailable: string,
  tokenUnit: string
): string {
  if (value == null) return unavailable
  if (value >= 1_000_000) {
    return `${Number((value / 1_000_000).toFixed(2))}M ${tokenUnit}`
  }
  if (value >= 1_000) {
    return `${Number((value / 1_000).toFixed(1))}K ${tokenUnit}`
  }
  return `${value} ${tokenUnit}`
}

function formatCostIndex(value: number | null | undefined, unavailable: string): string {
  if (value == null) return unavailable
  return `${Number(value.toFixed(1))}x`
}

export function ModelDetailsBody({ model }: ModelDetailsBodyProps) {
  const { t } = useTranslation('common')
  const unavailable = t('models.details_unavailable')
  const tokenUnit = t('models.token_unit')
  const modalitySeparator = t('models.modality_separator')
  const capabilities = getModelCapabilities(model)
  const inputTypes = [
    t('models.modality_text'),
    capabilities.supportsImage && t('models.modality_image'),
    capabilities.supportsVideo && t('models.modality_video'),
  ].filter(Boolean)

  return (
    <div className="space-y-5 pt-1">
      <section className="rounded-lg bg-surface px-4 py-3">
        <div className="text-sm font-medium text-text-primary">{t('models.cost_index')}</div>
        <div data-testid="model-details-cost-index" className="mt-2 text-2xl font-semibold">
          {formatCostIndex(model.costIndex, unavailable)}
        </div>
        <p className="mt-1 text-xs leading-5 text-text-muted">
          {t('models.cost_index_description')}
        </p>
      </section>

      <section>
        <h3 className="text-sm font-medium text-text-primary">{t('models.input_output_types')}</h3>
        <dl className="mt-2 space-y-2 text-sm">
          <div className="flex items-start justify-between gap-4">
            <dt className="text-text-muted">{t('models.input_type')}</dt>
            <dd className="text-right text-text-primary">{inputTypes.join(modalitySeparator)}</dd>
          </div>
          <div className="flex items-start justify-between gap-4">
            <dt className="text-text-muted">{t('models.output_type')}</dt>
            <dd className="text-right text-text-primary">{t('models.modality_text')}</dd>
          </div>
        </dl>
      </section>

      <section className="border-t border-border pt-4">
        <h3 className="text-sm font-medium text-text-primary">{t('models.model_limits')}</h3>
        <dl className="mt-2 space-y-2 text-sm">
          <div className="flex items-start justify-between gap-4">
            <dt className="text-text-muted">{t('models.context_window')}</dt>
            <dd data-testid="model-details-context-window" className="text-text-primary">
              {formatTokenCount(model.contextWindow, unavailable, tokenUnit)}
            </dd>
          </div>
          <div className="flex items-start justify-between gap-4">
            <dt className="text-text-muted">{t('models.max_output_tokens')}</dt>
            <dd data-testid="model-details-max-output" className="text-text-primary">
              {formatTokenCount(model.maxOutputTokens, unavailable, tokenUnit)}
            </dd>
          </div>
        </dl>
      </section>
    </div>
  )
}
