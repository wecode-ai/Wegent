// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Image, Video } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { getModelCapabilities } from '@/lib/model-capabilities'
import type { GroupableModel } from './model-grouping'

interface ModelCapabilityIconsProps {
  model: GroupableModel
  className?: string
}

export function supportsImageUnderstanding(model: GroupableModel): boolean {
  return getModelCapabilities(model).supportsImage === true
}

export function supportsVideoUnderstanding(model: GroupableModel): boolean {
  return getModelCapabilities(model).supportsVideo === true
}

export function ModelCapabilityIcons({ model, className }: ModelCapabilityIconsProps) {
  const { t } = useTranslation()
  const capabilities = [
    supportsImageUnderstanding(model) && {
      key: 'image',
      label: t('common:models.image_understanding', '图片理解'),
      icon: Image,
      className: 'border-sky-100 bg-sky-50 text-sky-600',
    },
    supportsVideoUnderstanding(model) && {
      key: 'video',
      label: t('common:models.video_understanding', '视频理解'),
      icon: Video,
      className: 'border-emerald-100 bg-emerald-50 text-emerald-600',
    },
  ].filter(Boolean) as Array<{
    key: string
    label: string
    icon: typeof Image
    className: string
  }>

  if (capabilities.length === 0) return null

  return (
    <TooltipProvider>
      <span className={cn('inline-flex shrink-0 items-center gap-1', className)}>
        <span className="sr-only">
          {capabilities.map(capability => capability.label).join('、')}
        </span>
        {capabilities.map(capability => {
          const Icon = capability.icon

          return (
            <Tooltip key={capability.key}>
              <TooltipTrigger asChild>
                <span
                  aria-hidden="true"
                  title={capability.label}
                  className={cn(
                    'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border',
                    capability.className
                  )}
                >
                  <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                </span>
              </TooltipTrigger>
              <TooltipContent>{capability.label}</TooltipContent>
            </Tooltip>
          )
        })}
      </span>
    </TooltipProvider>
  )
}
