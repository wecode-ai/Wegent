// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Building2, Clock3, Database, Loader2, Plus, User, Users, XIcon } from 'lucide-react'
import type { TFunction } from 'i18next'

import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useTranslation } from '@/hooks/useTranslation'
import { formatDocumentCount } from '@/lib/i18n-helpers'
import { cn } from '@/lib/utils'
import type { KnowledgeBaseDefaultRef } from '@/types/api'
import {
  KnowledgeBaseOption,
  KnowledgeBaseOptionSource,
  useKnowledgeBaseOptions,
} from '../../hooks/useKnowledgeBaseOptions'

interface KnowledgeBaseMultiSelectorProps {
  value: KnowledgeBaseDefaultRef[]
  onChange: (value: KnowledgeBaseDefaultRef[]) => void
  disabled?: boolean
}

interface GroupedKnowledgeBaseOption {
  option: KnowledgeBaseOption
  group: KnowledgeBaseOptionSource
  headerKey: string
  headerLabel: string
}

function formatUpdatedAt(value: string): string {
  if (!value) {
    return ''
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }

  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')

  return `${year}-${month}-${day} ${hours}:${minutes}`
}

function matchesSearch(option: KnowledgeBaseOption, search: string): boolean {
  const normalizedSearch = search.trim().toLowerCase()
  if (!normalizedSearch) {
    return true
  }

  return [option.name, option.description || '', option.groupName, option.namespace]
    .join(' ')
    .toLowerCase()
    .includes(normalizedSearch)
}

function getSourceIcon(source: KnowledgeBaseOptionSource) {
  switch (source) {
    case 'personal':
      return User
    case 'group':
      return Users
    case 'organization':
      return Building2
  }
}

function getSourceLabel(source: KnowledgeBaseOptionSource, t: TFunction) {
  switch (source) {
    case 'personal':
      return t('common:bot.default_knowledge_bases_source_personal', '个人')
    case 'group':
      return t('common:bot.default_knowledge_bases_source_group', '群组')
    case 'organization':
      return t('common:bot.default_knowledge_bases_source_organization', '组织')
  }
}

function getGroupTitle(source: KnowledgeBaseOptionSource, t: TFunction) {
  switch (source) {
    case 'personal':
      return t('common:bot.default_knowledge_bases_group_personal', '个人知识库')
    case 'group':
      return t('common:bot.default_knowledge_bases_group_group', '群组知识库')
    case 'organization':
      return t('common:bot.default_knowledge_bases_group_organization', '组织知识库')
  }
}

function buildFallbackOption(item: KnowledgeBaseDefaultRef): KnowledgeBaseOption {
  return {
    id: item.id,
    name: item.name,
    description: null,
    namespace: 'default',
    documentCount: 0,
    updatedAt: '',
    groupName: 'Personal',
    source: 'personal',
    isShared: false,
  }
}

function groupAvailableKnowledgeBases(
  availableItems: KnowledgeBaseOption[],
  t: TFunction
): GroupedKnowledgeBaseOption[] {
  const grouped: GroupedKnowledgeBaseOption[] = []
  const groupItemsByName = new Map<string, KnowledgeBaseOption[]>()

  for (const item of availableItems) {
    if (item.source !== 'group') {
      continue
    }

    const groupName = item.groupName || item.namespace
    if (!groupItemsByName.has(groupName)) {
      groupItemsByName.set(groupName, [])
    }
    groupItemsByName.get(groupName)?.push(item)
  }

  grouped.push(
    ...availableItems
      .filter(item => item.source === 'personal')
      .map(item => ({
        option: item,
        group: 'personal' as const,
        headerKey: 'personal',
        headerLabel: getGroupTitle('personal', t),
      }))
  )

  for (const groupName of Array.from(groupItemsByName.keys()).sort()) {
    const items = groupItemsByName.get(groupName) ?? []
    grouped.push(
      ...items.map(item => ({
        option: item,
        group: 'group' as const,
        headerKey: `group-${groupName}`,
        headerLabel: `${getGroupTitle('group', t)} - ${groupName}`,
      }))
    )
  }

  grouped.push(
    ...availableItems
      .filter(item => item.source === 'organization')
      .map(item => ({
        option: item,
        group: 'organization' as const,
        headerKey: 'organization',
        headerLabel: getGroupTitle('organization', t),
      }))
  )

  return grouped
}

interface KnowledgeBaseOptionRowProps {
  item: KnowledgeBaseOption
  disabled: boolean
  onSelect: (item: KnowledgeBaseOption) => void
  t: TFunction
}

function KnowledgeBaseOptionRow({ item, disabled, onSelect, t }: KnowledgeBaseOptionRowProps) {
  const SourceIcon = getSourceIcon(item.source)
  const updatedAt = formatUpdatedAt(item.updatedAt)
  const documentText = formatDocumentCount(item.documentCount || 0, t)

  return (
    <div
      className={cn(
        'cursor-pointer border-b border-border px-4 py-3 transition-colors last:border-b-0',
        disabled ? 'cursor-not-allowed opacity-70' : 'hover:bg-muted'
      )}
      onClick={() => {
        if (!disabled) {
          onSelect(item)
        }
      }}
      role="button"
      tabIndex={0}
      onKeyDown={event => {
        if (disabled) {
          return
        }

        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect(item)
        }
      }}
      data-testid={`default-knowledge-base-option-${item.id}`}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <Database className="h-4 w-4 flex-shrink-0 text-primary" />
          <span className="text-sm font-medium text-text-primary">{item.name}</span>
          <Badge variant="info" size="sm" className="gap-1">
            <SourceIcon className="h-3 w-3" />
            {getSourceLabel(item.source, t)}
          </Badge>
          {item.source === 'group' && item.groupName ? (
            <Badge variant="secondary" size="sm">
              {item.groupName}
            </Badge>
          ) : null}
          {item.isShared ? (
            <Badge variant="secondary" size="sm">
              {t('common:bot.default_knowledge_bases_source_shared', '共享')}
            </Badge>
          ) : null}
          <Badge variant="secondary" size="sm">
            {documentText}
          </Badge>
        </div>

        {item.description ? (
          <div className="pl-6 text-xs text-text-secondary line-clamp-2">{item.description}</div>
        ) : null}

        {updatedAt ? (
          <div className="flex items-center gap-1 pl-6 text-xs text-text-muted">
            <Clock3 className="h-3 w-3" />
            <span>
              {`${t('common:bot.default_knowledge_bases_updated_at', '最近更新')} ${updatedAt}`}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  )
}

interface SelectedKnowledgeBaseChipProps {
  item: KnowledgeBaseOption
  disabled: boolean
  onRemove: (knowledgeBaseId: number) => void
}

function SelectedKnowledgeBaseChip({ item, disabled, onRemove }: SelectedKnowledgeBaseChipProps) {
  return (
    <div
      className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-sm"
      data-testid={`default-knowledge-base-chip-${item.id}`}
    >
      <span>{item.name}</span>
      <button
        type="button"
        onClick={() => onRemove(item.id)}
        disabled={disabled}
        className={cn(
          'text-text-muted hover:text-text-primary',
          disabled ? 'cursor-not-allowed opacity-50' : ''
        )}
        data-testid={`default-knowledge-base-remove-${item.id}`}
      >
        <XIcon className="h-3 w-3" />
      </button>
    </div>
  )
}

export function KnowledgeBaseMultiSelector({
  value,
  onChange,
  disabled = false,
}: KnowledgeBaseMultiSelectorProps) {
  const { t } = useTranslation()
  const { options, loading, error } = useKnowledgeBaseOptions()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [triggerWidth, setTriggerWidth] = useState<number>(0)
  const listRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (open && triggerRef.current) {
      setTriggerWidth(triggerRef.current.offsetWidth)
    }
  }, [open])

  const selectedIds = useMemo(() => new Set(value.map(item => item.id)), [value])
  const optionsById = useMemo(() => new Map(options.map(option => [option.id, option])), [options])

  const selectedItems = useMemo(
    () => value.map(item => optionsById.get(item.id) ?? buildFallbackOption(item)),
    [optionsById, value]
  )

  const groupedAvailableItems = useMemo(
    () =>
      groupAvailableKnowledgeBases(
        options.filter(option => !selectedIds.has(option.id) && matchesSearch(option, search)),
        t
      ),
    [options, search, selectedIds, t]
  )

  const handleSelect = (option: KnowledgeBaseOption) => {
    onChange([...value, { id: option.id, name: option.name }])
    setOpen(false)
    setSearch('')
  }

  const handleRemove = (knowledgeBaseId: number) => {
    onChange(value.filter(item => item.id !== knowledgeBaseId))
  }

  const handleWheel = (event: React.WheelEvent) => {
    const list = listRef.current
    if (!list) {
      return
    }

    const isScrollingUp = event.deltaY < 0
    const isScrollingDown = event.deltaY > 0
    const isAtTop = list.scrollTop <= 0
    const isAtBottom = list.scrollTop + list.clientHeight >= list.scrollHeight

    if ((isScrollingUp && isAtTop) || (isScrollingDown && isAtBottom)) {
      return
    }

    event.stopPropagation()
  }

  const renderListContent = () => {
    if (loading) {
      return (
        <div className="flex items-center justify-center gap-2 py-8 text-sm text-text-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>{t('common:bot.default_knowledge_bases_loading', '知识库加载中...')}</span>
        </div>
      )
    }

    if (error) {
      return (
        <div className="py-8 text-center text-sm text-text-muted">
          {t('common:bot.default_knowledge_bases_load_failed', '知识库加载失败')}
        </div>
      )
    }

    if (groupedAvailableItems.length === 0) {
      return (
        <div className="py-8 text-center text-sm text-text-muted">
          {search
            ? t('common:bot.default_knowledge_bases_no_match', '没有匹配的知识库')
            : t('common:bot.default_knowledge_bases_no_options', '暂无可用知识库')}
        </div>
      )
    }

    let currentHeaderKey: string | null = null
    const elements: React.ReactNode[] = []

    for (const { option, group, headerKey, headerLabel } of groupedAvailableItems) {
      if (currentHeaderKey !== headerKey) {
        currentHeaderKey = headerKey
        const HeaderIcon = getSourceIcon(group)
        elements.push(
          <div
            key={`header-${headerKey}`}
            className="flex items-center gap-1.5 border-b border-border bg-muted/50 px-3 py-2 text-xs font-medium text-text-muted"
            data-testid={`default-knowledge-base-group-${group}`}
          >
            <HeaderIcon className="h-3 w-3" />
            {headerLabel}
          </div>
        )
      }

      elements.push(
        <KnowledgeBaseOptionRow
          key={`${option.id}-${option.namespace}`}
          item={option}
          disabled={disabled}
          onSelect={handleSelect}
          t={t}
        />
      )
    }

    return elements
  }

  return (
    <div className="space-y-2" data-testid="default-knowledge-base-selector">
      <Popover open={open && !disabled} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            ref={triggerRef}
            type="button"
            className="flex h-9 w-full items-center justify-between rounded-md border border-border/50 bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={disabled}
            data-testid="default-knowledge-base-trigger"
          >
            <div className="flex items-center gap-2 text-text-muted">
              <Database className="h-4 w-4 text-primary" />
              <span>
                {t('common:bot.default_knowledge_bases_select_to_add', '选择要添加的知识库...')}
              </span>
            </div>
            <Plus className="h-4 w-4 opacity-50" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          className="flex flex-col overflow-hidden border border-border p-0"
          style={{ width: triggerWidth > 0 ? triggerWidth : '100%' }}
          align="start"
          side="bottom"
          sideOffset={4}
          data-testid="default-knowledge-base-popover"
        >
          <div className="shrink-0 border-b p-3">
            <Input
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder={t('common:bot.default_knowledge_bases_search_placeholder', '搜索知识库')}
              disabled={disabled || loading}
              data-testid="default-knowledge-base-search-input"
            />
          </div>

          <div ref={listRef} className="max-h-[320px] overflow-y-auto" onWheel={handleWheel}>
            {renderListContent()}
          </div>
        </PopoverContent>
      </Popover>

      <div className="flex flex-wrap gap-1.5">
        {selectedItems.map(item => (
          <SelectedKnowledgeBaseChip
            key={item.id}
            item={item}
            disabled={disabled}
            onRemove={handleRemove}
          />
        ))}
      </div>

      <p className="text-xs text-text-muted">
        {t(
          'common:bot.default_knowledge_bases_used_for_new_chats',
          '用于初始化新聊天的默认知识库。'
        )}
      </p>
      <p className="text-xs text-text-muted">
        {t(
          'common:bot.default_knowledge_bases_append_hint',
          '聊天时手动选择的知识库会在后续追加，不会覆盖这里的默认配置。'
        )}
      </p>
    </div>
  )
}
