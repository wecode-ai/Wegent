// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { StarIcon, DownloadIcon, UserIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Tag } from '@/components/ui/tag'
import type { MarketplaceSkill } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'

interface MarketplaceSkillCardProps {
  skill: MarketplaceSkill
  isCollected: boolean
  isCollecting?: boolean
  onCollect: () => void
  onUncollect: () => void
  onClick: () => void
}

export default function MarketplaceSkillCard({
  skill,
  isCollected,
  isCollecting = false,
  onCollect,
  onUncollect,
  onClick,
}: MarketplaceSkillCardProps) {
  const { t } = useTranslation()
  const spec = skill.spec

  const handleCollectClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (isCollected) {
      onUncollect()
    } else {
      onCollect()
    }
  }

  return (
    <Card className="p-4 hover:shadow-md transition-shadow cursor-pointer" onClick={onClick}>
      <div className="flex flex-col h-full">
        {/* Header with name and version */}
        <div className="flex items-start justify-between mb-2">
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-medium text-text-primary truncate">
              {spec.displayName || skill.metadata.name}
            </h3>
            {spec.version && <span className="text-xs text-text-muted">v{spec.version}</span>}
          </div>
          <Button
            variant={isCollected ? 'default' : 'outline'}
            size="sm"
            className="flex-shrink-0 ml-2"
            onClick={handleCollectClick}
            disabled={isCollecting}
          >
            <StarIcon className={`w-4 h-4 mr-1 ${isCollected ? 'fill-current' : ''}`} />
            {isCollected
              ? t('common:skills.marketplace.collected')
              : t('common:skills.marketplace.collect')}
          </Button>
        </div>

        {/* Description */}
        <p className="text-sm text-text-secondary mb-3 line-clamp-2 flex-1">
          {spec.marketDescription || spec.description}
        </p>

        {/* Tags */}
        {spec.tags && spec.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-3">
            {spec.tags.slice(0, 3).map(tag => (
              <Tag key={tag} variant="info">
                {tag}
              </Tag>
            ))}
            {spec.tags.length > 3 && <Tag variant="default">+{spec.tags.length - 3}</Tag>}
          </div>
        )}

        {/* Footer with author and download count */}
        <div className="flex items-center justify-between text-xs text-text-muted mt-auto pt-2 border-t border-border">
          {spec.author && (
            <div className="flex items-center gap-1">
              <UserIcon className="w-3 h-3" />
              <span>{spec.author}</span>
            </div>
          )}
          <div className="flex items-center gap-1">
            <DownloadIcon className="w-3 h-3" />
            <span>
              {t('common:skills.marketplace.download_count', {
                count: spec.downloadCount,
              })}
            </span>
          </div>
        </div>
      </div>
    </Card>
  )
}
