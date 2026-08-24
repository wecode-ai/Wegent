// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { ChevronLeft, ChevronRight, ImageOff, Loader2, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { getAigcVideoImageUrl } from '../aigc_video/mediaUrls'
import { entityApis } from './api'
import type { EntityItem, EntityListResponse } from './types'

interface EntityPanelProps {
  taskId: number
  onContinue?: (buttonName?: string) => void
}

interface DisplayEntity extends EntityItem {
  typeLabel: string
}

const EMPTY_ENTITIES: EntityListResponse = {
  characters: [],
  scenes: [],
  props: [],
}

export function EntityPanel({ taskId, onContinue }: EntityPanelProps) {
  const { t } = useTranslation('video')
  const [entities, setEntities] = useState<EntityListResponse>(EMPTY_ENTITIES)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [currentIndex, setCurrentIndex] = useState(0)

  const displayEntities = useMemo<DisplayEntity[]>(() => {
    const addType = (items: EntityItem[], typeLabel: string) =>
      items
        .filter(item => {
          const name = item.entity_name.toLowerCase()
          return name !== 'narrator' && item.entity_name !== '旁白'
        })
        .map(item => ({ ...item, typeLabel }))

    return [
      ...addType(entities.characters, t('entity.character')),
      ...addType(entities.scenes, t('entity.scene')),
      ...addType(entities.props, t('entity.prop')),
    ]
  }, [entities, t])

  const fetchEntities = useCallback(
    async (silent = false) => {
      if (silent) {
        setRefreshing(true)
      } else {
        setLoading(true)
      }
      try {
        const response = await entityApis.listEntities(taskId)
        setEntities(response)
        setLoadFailed(false)
      } catch (error) {
        console.error('Failed to load entity preview:', error)
        if (!silent) setLoadFailed(true)
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    },
    [taskId]
  )

  useEffect(() => {
    void fetchEntities()
  }, [fetchEntities])

  const hasGeneratingEntity = displayEntities.some(entity => entity.generation_status === 1)
  useEffect(() => {
    if (!hasGeneratingEntity) return
    const timer = window.setInterval(() => void fetchEntities(true), 2000)
    return () => window.clearInterval(timer)
  }, [fetchEntities, hasGeneratingEntity])

  useEffect(() => {
    if (displayEntities.length === 0) {
      setCurrentIndex(0)
    } else if (currentIndex >= displayEntities.length) {
      setCurrentIndex(displayEntities.length - 1)
    }
  }, [currentIndex, displayEntities.length])

  if (loading) {
    return (
      <div
        className="flex h-full items-center justify-center gap-2 text-sm text-text-secondary"
        data-testid="entity-panel-loading"
      >
        <Loader2 className="h-5 w-5 animate-spin text-primary" />
        {t('entity.loading')}
      </div>
    )
  }

  if (loadFailed) {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center"
        data-testid="entity-panel-error"
      >
        <ImageOff className="h-9 w-9 text-text-muted" />
        <p className="text-sm text-text-secondary">{t('entity.loadFailed')}</p>
        <Button variant="primary" onClick={() => void fetchEntities()} data-testid="entity-retry">
          {t('entity.retry')}
        </Button>
      </div>
    )
  }

  if (displayEntities.length === 0) {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center"
        data-testid="entity-panel-empty"
      >
        <ImageOff className="h-9 w-9 text-text-muted" />
        <p className="text-sm text-text-secondary">{t('entity.empty')}</p>
      </div>
    )
  }

  const currentEntity = displayEntities[currentIndex]
  const imageUrl = getAigcVideoImageUrl(currentEntity.image_url)
  const description =
    currentEntity.ext?.visual_description ||
    [currentEntity.description, currentEntity.dynamic_features].filter(Boolean).join('\n')

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="entity-panel">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-3">
        <div>
          <h3 className="text-sm font-medium text-text-primary">{t('entity.title')}</h3>
          <p className="mt-0.5 text-xs text-text-secondary">
            {t('entity.count', { count: displayEntities.length })}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void fetchEntities(true)}
          disabled={refreshing}
          data-testid="entity-refresh"
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          {t('entity.refresh')}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setCurrentIndex(index => Math.max(0, index - 1))}
            disabled={currentIndex === 0}
            aria-label={t('entity.previous')}
            data-testid="entity-previous"
          >
            <ChevronLeft className="h-5 w-5" />
          </Button>
          <div className="min-w-0 text-center">
            <p className="truncate text-sm font-medium text-text-primary">
              {currentEntity.entity_name}
            </p>
            <p className="text-xs text-text-secondary">
              {currentEntity.typeLabel} · {currentIndex + 1}/{displayEntities.length}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() =>
              setCurrentIndex(index => Math.min(displayEntities.length - 1, index + 1))
            }
            disabled={currentIndex === displayEntities.length - 1}
            aria-label={t('entity.next')}
            data-testid="entity-next"
          >
            <ChevronRight className="h-5 w-5" />
          </Button>
        </div>

        <div className="relative mt-4 aspect-video overflow-hidden rounded-xl border border-border bg-surface">
          {imageUrl ? (
            // This authenticated proxy URL contains a query string, which Next Image rejects.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imageUrl}
              alt={currentEntity.entity_name}
              className="h-full w-full object-contain"
              data-testid={`entity-image-${currentEntity.id}`}
            />
          ) : currentEntity.generation_status === 1 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-text-secondary">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
              {t('entity.generating')}
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-text-secondary">
              <ImageOff className="h-7 w-7" />
              {t('entity.noImage')}
            </div>
          )}
        </div>

        <div className="mt-4 flex gap-2 overflow-x-auto pb-2" data-testid="entity-thumbnails">
          {displayEntities.map((entity, index) => {
            const thumbnailUrl = getAigcVideoImageUrl(entity.image_url)
            return (
              <button
                key={entity.id}
                type="button"
                className={`relative h-16 w-24 shrink-0 overflow-hidden rounded-lg border-2 bg-surface transition-colors ${
                  currentIndex === index ? 'border-primary' : 'border-transparent'
                }`}
                onClick={() => setCurrentIndex(index)}
                aria-label={entity.entity_name}
                data-testid={`entity-thumbnail-${entity.id}`}
              >
                {thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={thumbnailUrl} alt="" className="h-full w-full object-cover" />
                ) : entity.generation_status === 1 ? (
                  <Loader2 className="absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 animate-spin text-primary" />
                ) : (
                  <ImageOff className="absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 text-text-muted" />
                )}
                <span className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-1 py-0.5 text-[10px] text-white">
                  {entity.entity_name}
                </span>
              </button>
            )
          })}
        </div>

        {description ? (
          <div className="mt-3 rounded-lg border border-border bg-surface p-4">
            <p className="mb-1 text-xs font-medium text-text-secondary">
              {t('entity.description')}
            </p>
            <p className="whitespace-pre-wrap text-sm leading-6 text-text-primary">{description}</p>
          </div>
        ) : null}
      </div>

      {onContinue ? (
        <div className="shrink-0 border-t border-border px-5 py-4">
          <Button
            variant="primary"
            className="w-full"
            onClick={() => onContinue(t('entity.continue'))}
            data-testid="entity-continue"
          >
            {t('entity.continue')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
