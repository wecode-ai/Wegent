// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Image, Type, Video } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'

export type ModelModality = 'text' | 'image' | 'video'

export const MODEL_MODALITY_ICON_STYLES: Record<ModelModality, string> = {
  text: 'border-border bg-base text-text-muted',
  image: 'border-sky-100 bg-sky-50 text-sky-600',
  video: 'border-emerald-100 bg-emerald-50 text-emerald-600',
}

const modalityIcons = {
  text: Type,
  image: Image,
  video: Video,
}

interface ModelModalityIconsProps {
  modalities: ModelModality[]
  testIdPrefix: 'input' | 'output'
  className?: string
}

export function ModelModalityIcons({
  modalities,
  testIdPrefix,
  className,
}: ModelModalityIconsProps) {
  const { t } = useTranslation('common')
  const labels: Record<ModelModality, string> = {
    text: t('models.modality_text'),
    image: t('models.modality_image'),
    video: t('models.modality_video'),
  }
  const ariaLabel = modalities
    .map(modality => labels[modality])
    .join(t('models.modality_separator'))

  return (
    <span
      role="img"
      aria-label={ariaLabel}
      className={cn('inline-flex items-center justify-end gap-1', className)}
    >
      {modalities.map(modality => {
        const Icon = modalityIcons[modality]

        return (
          <span
            key={modality}
            aria-hidden="true"
            data-testid={`model-modality-${testIdPrefix}-${modality}`}
            className={cn(
              'group relative inline-flex h-5 w-5 shrink-0 cursor-help items-center justify-center rounded-full border',
              MODEL_MODALITY_ICON_STYLES[modality]
            )}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="invisible pointer-events-none absolute left-1/2 top-full z-[60] mt-1 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-tooltip px-2 py-1 text-xs font-normal text-tooltip-foreground opacity-0 shadow-md transition-opacity group-hover:visible group-hover:opacity-100">
              {labels[modality]}
            </span>
          </span>
        )
      })}
    </span>
  )
}
