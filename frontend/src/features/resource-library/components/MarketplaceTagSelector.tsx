// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { useMarketplaceTags, getMarketplaceTagLabel } from '../useMarketplaceTags'

interface MarketplaceTagSelectorProps {
  value: string[]
  onChange: (value: string[]) => void
  disabled?: boolean
  maxTags?: number
}

export function MarketplaceTagSelector({
  value,
  onChange,
  disabled = false,
  maxTags = 3,
}: MarketplaceTagSelectorProps) {
  const { t, i18n } = useTranslation('resource-library')
  const { items, loading, error } = useMarketplaceTags()
  const itemMap = new Map(items.map(item => [item.id, item]))
  const selectedSet = new Set(value)
  const unknownSelected = value.filter(tagId => !itemMap.has(tagId))
  const visibleItems = items.filter(item => item.enabled || selectedSet.has(item.id))

  const toggle = (tagId: string) => {
    if (selectedSet.has(tagId)) {
      onChange(value.filter(item => item !== tagId))
      return
    }
    const item = itemMap.get(tagId)
    if (!item?.enabled) return
    if (value.length < maxTags) {
      onChange([...value, tagId])
    }
  }

  if (loading) {
    return (
      <p className="text-sm text-text-muted" data-testid="marketplace-tags-loading">
        {t('marketplace_tags.loading')}
      </p>
    )
  }

  if (error) {
    return (
      <p className="text-sm text-red-500" data-testid="marketplace-tags-error">
        {t('marketplace_tags.load_failed')}
      </p>
    )
  }

  return (
    <div className="space-y-2" data-testid="marketplace-tag-selector">
      <div className="flex flex-wrap gap-2">
        {visibleItems.map(item => {
          const selected = selectedSet.has(item.id)
          return (
            <Button
              key={item.id}
              type="button"
              variant={selected ? 'primary' : 'outline'}
              size="sm"
              className={cn(
                'min-h-11 min-w-11 md:min-h-10 md:min-w-0',
                !item.enabled && 'opacity-60'
              )}
              disabled={disabled || (!selected && (!item.enabled || value.length >= maxTags))}
              onClick={() => toggle(item.id)}
              aria-pressed={selected}
              data-testid={`marketplace-tag-option-${item.id}`}
            >
              {getMarketplaceTagLabel(item, i18n.language)}
              {!item.enabled && ` (${t('marketplace_tags.disabled')})`}
            </Button>
          )
        })}
        {unknownSelected.map(tagId => (
          <Button
            key={tagId}
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11 min-w-11 opacity-60 md:min-h-10 md:min-w-0"
            disabled={disabled}
            onClick={() => toggle(tagId)}
            aria-pressed
            data-testid={`marketplace-tag-unknown-${tagId}`}
          >
            {tagId}
          </Button>
        ))}
      </div>
      <p className="text-xs text-text-muted">
        {t('marketplace_tags.selection_hint', { max: maxTags })}
      </p>
    </div>
  )
}
