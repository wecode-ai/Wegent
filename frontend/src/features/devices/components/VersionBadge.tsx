// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { ArrowUpCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Badge } from '@/components/ui/badge'
import { useTranslation } from '@/hooks/useTranslation'

interface VersionBadgeProps {
  executorVersion: string | null
  latestVersion: string | null
  updateAvailable: boolean
  className?: string
  onUpgrade?: () => void
  isUpgrading?: boolean
  isOpenClaw?: boolean
}

export function VersionBadge({
  executorVersion,
  latestVersion,
  updateAvailable,
  className,
  onUpgrade,
  isUpgrading,
  isOpenClaw,
}: VersionBadgeProps) {
  const { t } = useTranslation('devices')

  if (!executorVersion) return null

  return (
    <div className={cn('flex items-center gap-1.5', className)}>
      <span className="text-xs text-text-muted">v{executorVersion}</span>
      {updateAvailable && !isUpgrading && !isOpenClaw && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge
                variant="info"
                onClick={onUpgrade}
                className={cn(
                  'border-amber-400 text-amber-600 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-600 dark:text-amber-400 px-1.5 py-0',
                  onUpgrade && 'cursor-pointer hover:bg-amber-100 dark:hover:bg-amber-900/30'
                )}
              >
                <ArrowUpCircle className="h-3 w-3" />
              </Badge>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-xs">
              <div className="space-y-1.5 text-sm">
                <p className="font-medium">{t('version.updateAvailable')}</p>
                <p className="text-text-muted">
                  {t('version.current')}: {executorVersion}
                </p>
                <p className="text-text-muted">
                  {t('version.latest')}: {latestVersion}
                </p>
                {onUpgrade && <p className="text-xs text-primary">{t('version.clickToUpgrade')}</p>}
              </div>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  )
}
