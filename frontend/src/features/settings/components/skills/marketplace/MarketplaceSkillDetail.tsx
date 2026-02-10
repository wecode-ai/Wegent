// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
import { StarIcon, UserIcon, DownloadIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tag } from '@/components/ui/tag'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { fetchMarketplaceSkillDetail } from '@/apis/skills'
import type { MarketplaceSkillDetailResponse } from '@/types/api'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import LoadingState from '@/features/common/LoadingState'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface MarketplaceSkillDetailProps {
  skillId: number | null
  open: boolean
  onClose: () => void
  onCollect: (skillId: number) => Promise<void>
  onUncollect: (skillId: number) => Promise<void>
}

export default function MarketplaceSkillDetail({
  skillId,
  open,
  onClose,
  onCollect,
  onUncollect,
}: MarketplaceSkillDetailProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [detail, setDetail] = useState<MarketplaceSkillDetailResponse | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isCollecting, setIsCollecting] = useState(false)

  const loadDetail = useCallback(async () => {
    if (!skillId) return

    setIsLoading(true)
    try {
      const data = await fetchMarketplaceSkillDetail(skillId)
      setDetail(data)
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('common:common.error'),
        description: error instanceof Error ? error.message : t('common:common.unknown_error'),
      })
      onClose()
    } finally {
      setIsLoading(false)
    }
  }, [skillId, toast, t, onClose])

  useEffect(() => {
    if (open && skillId) {
      loadDetail()
    } else {
      setDetail(null)
    }
  }, [open, skillId, loadDetail])

  const handleCollectClick = async () => {
    if (!detail || !skillId) return

    setIsCollecting(true)
    try {
      if (detail.is_collected) {
        await onUncollect(skillId)
        setDetail(prev => (prev ? { ...prev, is_collected: false } : prev))
      } else {
        await onCollect(skillId)
        setDetail(prev => (prev ? { ...prev, is_collected: true } : prev))
      }
    } finally {
      setIsCollecting(false)
    }
  }

  const skill = detail?.skill
  const spec = skill?.spec

  return (
    <Sheet open={open} onOpenChange={() => onClose()}>
      <SheetContent className="w-[500px] sm:max-w-[500px] overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center justify-between pr-8">
            <span>
              {spec?.displayName || skill?.metadata.name || t('common:skills.marketplace.title')}
            </span>
          </SheetTitle>
        </SheetHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <LoadingState message={t('common:common.loading')} />
          </div>
        ) : detail && skill && spec ? (
          <div className="mt-6 space-y-6">
            {/* Header section */}
            <div className="space-y-4">
              {/* Version and Category */}
              <div className="flex flex-wrap gap-2">
                {spec.version && (
                  <Tag variant="default">
                    {t('common:skills.marketplace.version')}: {spec.version}
                  </Tag>
                )}
                <Tag variant="info">{detail.category.displayName}</Tag>
              </div>

              {/* Description */}
              <p className="text-sm text-text-secondary">
                {spec.marketDescription || spec.description}
              </p>

              {/* Tags */}
              {spec.tags && spec.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {spec.tags.map(tag => (
                    <Tag key={tag} variant="default">
                      {tag}
                    </Tag>
                  ))}
                </div>
              )}

              {/* Bind Shells */}
              {spec.bindShells && spec.bindShells.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-text-muted">
                    {t('common:skills.marketplace.bind_shells')}:
                  </span>
                  {spec.bindShells.map(shell => (
                    <Tag key={shell} variant="success">
                      {shell}
                    </Tag>
                  ))}
                </div>
              )}
            </div>

            {/* Stats section */}
            <div className="flex items-center gap-6 py-4 border-y border-border">
              {/* Publisher */}
              <div className="flex items-center gap-2">
                <UserIcon className="w-4 h-4 text-text-muted" />
                <span className="text-sm">{detail.publisher.username}</span>
              </div>

              {/* Download count */}
              <div className="flex items-center gap-2">
                <DownloadIcon className="w-4 h-4 text-text-muted" />
                <span className="text-sm">
                  {t('common:skills.marketplace.download_count', {
                    count: spec.downloadCount,
                  })}
                </span>
              </div>
            </div>

            {/* Collect button */}
            <Button
              className="w-full"
              variant={detail.is_collected ? 'outline' : 'primary'}
              onClick={handleCollectClick}
              disabled={isCollecting}
            >
              <StarIcon className={`w-4 h-4 mr-2 ${detail.is_collected ? 'fill-current' : ''}`} />
              {detail.is_collected
                ? t('common:skills.marketplace.uncollect')
                : t('common:skills.marketplace.collect')}
            </Button>

            {/* README section */}
            {spec.readme && (
              <div className="space-y-2">
                <h3 className="text-base font-medium">{t('common:skills.marketplace.readme')}</h3>
                <div className="prose prose-sm max-w-none dark:prose-invert">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{spec.readme}</ReactMarkdown>
                </div>
              </div>
            )}
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
