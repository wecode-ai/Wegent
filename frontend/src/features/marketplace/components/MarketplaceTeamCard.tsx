// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { CheckIcon, ArrowDownTrayIcon } from '@heroicons/react/24/outline'
import { ChatBubbleLeftEllipsisIcon, CodeBracketIcon } from '@heroicons/react/24/outline'
import { useTranslation } from '@/hooks/useTranslation'
import type { MarketplaceTeam } from '@/types/marketplace'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { TeamIconDisplay } from '@/features/settings/components/teams/TeamIconDisplay'
import { Badge } from '@/components/ui/badge'

interface MarketplaceTeamCardProps {
  team: MarketplaceTeam
  onInstall: () => void
  onUninstall: () => void
}

export function MarketplaceTeamCard({ team, onInstall, onUninstall }: MarketplaceTeamCardProps) {
  const { t } = useTranslation('marketplace')

  // Get mode badges
  const bindMode = team.bind_mode || ['chat', 'code']

  return (
    <Card className="p-4 bg-base hover:bg-hover transition-colors flex flex-col h-full">
      {/* Header */}
      <div className="flex items-start gap-3 mb-3">
        <TeamIconDisplay iconId={team.icon} size="lg" className="text-primary flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-text-primary truncate">{team.name}</h3>
          <div className="flex items-center gap-2 mt-1">
            <Badge variant="secondary" className="text-xs">
              {t(`categories.${team.category}`)}
            </Badge>
            {/* Mode badges */}
            {bindMode.includes('chat') && (
              <ChatBubbleLeftEllipsisIcon className="w-4 h-4 text-text-muted" title="Chat" />
            )}
            {bindMode.includes('code') && (
              <CodeBracketIcon className="w-4 h-4 text-text-muted" title="Code" />
            )}
          </div>
        </div>
      </div>

      {/* Description */}
      <p className="text-sm text-text-secondary line-clamp-2 flex-1 mb-3">
        {team.description || t('no_description')}
      </p>

      {/* Footer */}
      <div className="flex items-center justify-between mt-auto pt-3 border-t border-border">
        <div className="text-xs text-text-muted">
          {t('install_count', { count: team.install_count })}
        </div>

        {team.is_installed ? (
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1 text-xs text-success">
              <CheckIcon className="w-4 h-4" />
              {t('installed')}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={onUninstall}
              className="text-text-muted hover:text-error h-7 px-2"
            >
              {t('uninstall')}
            </Button>
          </div>
        ) : (
          <Button variant="primary" size="sm" onClick={onInstall} className="h-7 gap-1">
            <ArrowDownTrayIcon className="w-3.5 h-3.5" />
            {t('install')}
          </Button>
        )}
      </div>
    </Card>
  )
}
