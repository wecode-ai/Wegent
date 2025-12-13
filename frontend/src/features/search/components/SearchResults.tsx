// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslation } from 'react-i18next'
import { MessageSquare, Code, BookOpen, Users } from 'lucide-react'
import { cn } from '@/lib/utils'
import { SearchResultItem, SearchType } from '../types'
import { Badge } from '@/components/ui/badge'

interface SearchResultItemProps {
  item: SearchResultItem
  keyword: string
}

const TYPE_ICONS: Record<SearchType, React.ComponentType<{ className?: string }>> = {
  chat: MessageSquare,
  code: Code,
  knowledge: BookOpen,
  teams: Users,
}

const TYPE_COLORS: Record<SearchType, string> = {
  chat: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  code: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  knowledge: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  teams: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
}

function highlightText(text: string, keyword: string): React.ReactNode {
  if (!keyword) return text

  const regex = new RegExp(`(${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
  const parts = text.split(regex)

  return parts.map((part, index) =>
    regex.test(part) ? (
      <mark key={index} className="bg-yellow-200 dark:bg-yellow-800 rounded px-0.5">
        {part}
      </mark>
    ) : (
      part
    )
  )
}

function formatDate(dateString: string | null): string {
  if (!dateString) return ''
  const date = new Date(dateString)
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function SearchResultItemComponent({ item, keyword }: SearchResultItemProps) {
  const { t } = useTranslation()
  const router = useRouter()
  const Icon = TYPE_ICONS[item.type]

  const handleClick = () => {
    switch (item.type) {
      case 'chat':
        router.push(`/chat?task=${item.id}`)
        break
      case 'code':
        router.push(`/code?task=${item.id}`)
        break
      case 'knowledge':
        // knowledge items have id format: "project_123" or "content_456"
        const [itemType, itemId] = item.id.split('_')
        if (itemType === 'project') {
          router.push(`/knowledge?project=${itemId}`)
        } else {
          const generationId = item.metadata?.generation_id
          router.push(`/knowledge?generation=${generationId}&content=${itemId}`)
        }
        break
      case 'teams':
        router.push(`/settings/teams?id=${item.id}`)
        break
    }
  }

  return (
    <div
      onClick={handleClick}
      className="p-4 bg-surface border border-border rounded-lg hover:border-primary/50 hover:shadow-sm cursor-pointer transition-all"
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          handleClick()
        }
      }}
    >
      <div className="flex items-start gap-3">
        {/* Type badge */}
        <div
          className={cn(
            'flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium shrink-0',
            TYPE_COLORS[item.type]
          )}
        >
          <Icon className="h-3 w-3" />
          <span>{t(`search.types.${item.type}`)}</span>
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          {/* Title */}
          <h3 className="text-base font-medium text-text-primary truncate">
            {highlightText(item.title, keyword)}
          </h3>

          {/* Snippet */}
          {item.snippet && (
            <p className="mt-1 text-sm text-text-secondary line-clamp-2">
              {highlightText(item.snippet, keyword)}
            </p>
          )}

          {/* Metadata */}
          <div className="mt-2 flex items-center gap-3 text-xs text-text-muted">
            {item.created_at && <span>{formatDate(item.created_at)}</span>}
            {item.type === 'code' && item.metadata?.git_repo && (
              <span className="truncate max-w-[200px]">{String(item.metadata.git_repo)}</span>
            )}
            {item.type === 'teams' && item.metadata?.collaboration_model && (
              <Badge variant="secondary" className="text-xs">
                {String(item.metadata.collaboration_model)}
              </Badge>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

interface SearchResultsProps {
  items: SearchResultItem[]
  keyword: string
  isLoading?: boolean
  total?: number
}

export function SearchResults({ items, keyword, isLoading, total }: SearchResultsProps) {
  const { t } = useTranslation()

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="p-4 bg-surface border border-border rounded-lg animate-pulse">
            <div className="flex gap-3">
              <div className="w-16 h-6 bg-muted rounded" />
              <div className="flex-1 space-y-2">
                <div className="h-5 bg-muted rounded w-3/4" />
                <div className="h-4 bg-muted rounded w-full" />
                <div className="h-3 bg-muted rounded w-1/4" />
              </div>
            </div>
          </div>
        ))}
      </div>
    )
  }

  if (items.length === 0) {
    return null
  }

  return (
    <div className="space-y-3">
      {total !== undefined && (
        <p className="text-sm text-text-secondary">
          {t('search.results', { count: total })}
        </p>
      )}
      {items.map((item) => (
        <SearchResultItemComponent key={`${item.type}-${item.id}`} item={item} keyword={keyword} />
      ))}
    </div>
  )
}
