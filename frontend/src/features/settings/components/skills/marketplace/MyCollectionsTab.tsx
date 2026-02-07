// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
import { StarIcon, TrashIcon, AlertCircleIcon, PackageIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Tag } from '@/components/ui/tag'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import LoadingState from '@/features/common/LoadingState'
import { fetchMyCollections, uncollectSkill } from '@/apis/skills'
import type { CollectionItem } from '@/types/api'

interface MyCollectionsTabProps {
  onCollectionChange?: () => void
}

export default function MyCollectionsTab({
  onCollectionChange,
}: MyCollectionsTabProps) {
  const { t } = useTranslation()
  const { toast } = useToast()

  const [collections, setCollections] = useState<CollectionItem[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [removingIds, setRemovingIds] = useState<Set<number>>(new Set())

  const loadCollections = useCallback(async () => {
    setIsLoading(true)
    try {
      const data = await fetchMyCollections()
      setCollections(data)
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('common:common.error'),
        description:
          error instanceof Error ? error.message : t('common:common.unknown_error'),
      })
    } finally {
      setIsLoading(false)
    }
  }, [toast, t])

  useEffect(() => {
    loadCollections()
  }, [loadCollections])

  const handleRemove = async (item: CollectionItem) => {
    if (!item.marketplace_skill) return

    const skillId = parseInt(
      item.marketplace_skill.metadata.labels?.id || '0',
      10
    )
    setRemovingIds((prev) => new Set(prev).add(skillId))

    try {
      await uncollectSkill(skillId)
      setCollections((prev) =>
        prev.filter((c) => c.collection_id !== item.collection_id)
      )
      toast({
        title: t('common:common.success'),
        description: t('common:skills.marketplace.uncollect_success'),
      })
      onCollectionChange?.()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('common:common.error'),
        description:
          error instanceof Error ? error.message : t('common:common.unknown_error'),
      })
    } finally {
      setRemovingIds((prev) => {
        const next = new Set(prev)
        next.delete(skillId)
        return next
      })
    }
  }

  if (isLoading) {
    return <LoadingState message={t('common:common.loading')} />
  }

  if (collections.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <StarIcon className="w-12 h-12 text-text-muted mb-4" />
        <h3 className="text-base font-medium text-text-primary mb-2">
          {t('common:skills.marketplace.no_collections')}
        </h3>
        <p className="text-sm text-text-muted">
          {t('common:skills.marketplace.no_collections_description')}
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {collections.map((item) => {
        const skill = item.marketplace_skill
        const spec = skill?.spec
        const skillId = skill
          ? parseInt(skill.metadata.labels?.id || '0', 10)
          : 0
        const isRemoving = removingIds.has(skillId)

        return (
          <Card
            key={item.collection_id}
            className={`p-4 ${!item.is_available ? 'opacity-60' : ''}`}
          >
            <div className="flex items-start justify-between">
              {/* Skill Info */}
              <div className="flex items-start gap-3 min-w-0 flex-1">
                <PackageIcon
                  className={`w-5 h-5 flex-shrink-0 mt-0.5 ${
                    item.is_available ? 'text-primary' : 'text-text-muted'
                  }`}
                />
                <div className="min-w-0 flex-1">
                  {skill && spec ? (
                    <>
                      <div className="flex items-center gap-2">
                        <h3 className="text-base font-medium text-text-primary truncate">
                          {spec.displayName || skill.metadata.name}
                        </h3>
                        {!item.is_available && (
                          <Tag variant="destructive">
                            {t('common:skills.marketplace.unavailable')}
                          </Tag>
                        )}
                      </div>
                      <p className="text-sm text-text-secondary mt-1 line-clamp-2">
                        {spec.marketDescription || spec.description}
                      </p>

                      {/* Tags */}
                      {spec.tags && spec.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2">
                          {spec.tags.slice(0, 4).map((tag) => (
                            <Tag key={tag} variant="info">
                              {tag}
                            </Tag>
                          ))}
                        </div>
                      )}

                      {/* Collected date */}
                      <div className="flex items-center gap-1 mt-2 text-xs text-text-muted">
                        <StarIcon className="w-3 h-3" />
                        <span>
                          {t('common:skills.marketplace.collected_at', {
                            date: new Date(
                              item.collected_at
                            ).toLocaleDateString(),
                          })}
                        </span>
                      </div>
                    </>
                  ) : (
                    <div className="flex items-center gap-2 text-text-muted">
                      <AlertCircleIcon className="w-4 h-4" />
                      <span>{t('common:skills.marketplace.unavailable_tip')}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex gap-1 flex-shrink-0 ml-4">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-error hover:text-error hover:bg-error/10"
                  onClick={() => handleRemove(item)}
                  disabled={isRemoving || !item.marketplace_skill}
                  title={t('common:skills.marketplace.uncollect')}
                >
                  {isRemoving ? (
                    <svg
                      className="animate-spin h-4 w-4"
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      ></circle>
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      ></path>
                    </svg>
                  ) : (
                    <TrashIcon className="w-4 h-4" />
                  )}
                </Button>
              </div>
            </div>
          </Card>
        )
      })}
    </div>
  )
}
