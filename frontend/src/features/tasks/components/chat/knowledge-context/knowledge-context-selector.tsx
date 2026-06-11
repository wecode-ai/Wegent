// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  Check,
  Database,
  Search,
  User,
  Users,
} from 'lucide-react'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import { formatDocumentCount } from '@/lib/i18n-helpers'
import { cn } from '@/lib/utils'
import type { KnowledgeBase } from '@/types/api'
import type { ContextItem, KnowledgeBaseContext } from '@/types/context'
import type { BoundKnowledgeBaseDetail } from '@/types/task-knowledge-base'
import { useTranslation } from '@/hooks/useTranslation'
import {
  buildKnowledgeContextGroups,
  type KnowledgeOption,
  type KnowledgeScopeItem,
  type KnowledgeScopeKey,
} from './knowledgeContextGrouping'

interface KnowledgeContextSelectorProps {
  knowledgeBases: KnowledgeBase[]
  boundKnowledgeBases: BoundKnowledgeBaseDetail[]
  selectedContexts: ContextItem[]
  onSelect: (context: ContextItem) => void
  onDeselect: (id: number | string) => void
  onOpenChange: (open: boolean) => void
  excludeKnowledgeBaseId?: number
  organizationNamespace?: string | null
  isLoading: boolean
  error: string | null
  onRetry: () => void
}

function sanitizeTestId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-')
}

function getScopeIcon(scope: KnowledgeScopeItem) {
  switch (scope.type) {
    case 'bound':
      return Users
    case 'personal':
      return User
    case 'group':
      return Users
    case 'organization':
      return Building2
  }
}

function optionToContext(option: KnowledgeOption): KnowledgeBaseContext {
  return {
    id: option.id,
    name: option.name,
    type: 'knowledge_base',
    description: option.description ?? undefined,
    retriever_name: option.retrievalConfig?.retriever_name,
    retriever_namespace: option.retrievalConfig?.retriever_namespace,
    document_count: option.documentCount,
  }
}

interface ScopeRowProps {
  scope: KnowledgeScopeItem
  active: boolean
  onSelect: () => void
}

function ScopeRow({ scope, active, onSelect }: ScopeRowProps) {
  const Icon = getScopeIcon(scope)

  return (
    <button
      type="button"
      data-testid={`knowledge-scope-${sanitizeTestId(scope.key)}`}
      onClick={onSelect}
      className={cn(
        'flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left',
        'hover:bg-hover focus:bg-hover focus:outline-none',
        active && 'bg-primary/10 text-primary',
        'min-h-[44px]'
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <Icon className="h-4 w-4 shrink-0 text-text-muted" />
        <span className="truncate text-sm font-medium">{scope.label}</span>
      </span>
      <span className="shrink-0 rounded-full bg-surface px-2 py-0.5 text-xs text-text-muted">
        {scope.count}
      </span>
    </button>
  )
}

interface ScopeListProps {
  scopes: KnowledgeScopeItem[]
  activeScopeKey: KnowledgeScopeKey | null
  onSelectScope: (scopeKey: KnowledgeScopeKey) => void
}

function ScopeList({ scopes, activeScopeKey, onSelectScope }: ScopeListProps) {
  const { t } = useTranslation('knowledge')
  const boundScopes = scopes.filter(scope => scope.type === 'bound')
  const personalScopes = scopes.filter(scope => scope.type === 'personal')
  const groupScopes = scopes.filter(scope => scope.type === 'group')
  const organizationScopes = scopes.filter(scope => scope.type === 'organization')

  return (
    <div className="px-2 py-2">
      {boundScopes.map(scope => (
        <ScopeRow
          key={scope.key}
          scope={scope}
          active={scope.key === activeScopeKey}
          onSelect={() => onSelectScope(scope.key)}
        />
      ))}

      {personalScopes.map(scope => (
        <ScopeRow
          key={scope.key}
          scope={scope}
          active={scope.key === activeScopeKey}
          onSelect={() => onSelectScope(scope.key)}
        />
      ))}

      <div className="px-2 pb-1 pt-2 text-xs font-medium text-text-muted">
        {t('contextSelector.groupKnowledge')}
      </div>
      {groupScopes.length > 0 ? (
        groupScopes.map(scope => (
          <ScopeRow
            key={scope.key}
            scope={scope}
            active={scope.key === activeScopeKey}
            onSelect={() => onSelectScope(scope.key)}
          />
        ))
      ) : (
        <div className="px-2 py-2 text-xs text-text-muted">
          {t('contextSelector.noGroupKnowledge')}
        </div>
      )}

      {organizationScopes.map(scope => (
        <ScopeRow
          key={scope.key}
          scope={scope}
          active={scope.key === activeScopeKey}
          onSelect={() => onSelectScope(scope.key)}
        />
      ))}
    </div>
  )
}

interface OptionRowProps {
  option: KnowledgeOption
  selected: boolean
  showPath: boolean
  onToggle: () => void
}

function OptionRow({ option, selected, showPath, onToggle }: OptionRowProps) {
  const { t } = useTranslation('knowledge')
  const documentText = formatDocumentCount(option.documentCount, t)
  const metaText = showPath ? `${option.pathLabel} · ${documentText}` : documentText

  return (
    <button
      type="button"
      data-testid={`knowledge-option-${option.id}`}
      onClick={onToggle}
      className={cn(
        'flex w-full items-start justify-between gap-3 px-3 py-2.5 text-left',
        'hover:bg-hover focus:bg-hover focus:outline-none',
        selected && 'bg-primary/10 text-primary',
        'min-h-[56px]'
      )}
    >
      <span className="flex min-w-0 flex-1 items-start gap-2">
        <Database className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" />
        <span className="min-w-0 flex-1">
          <span
            className="block truncate text-sm font-medium text-text-primary"
            title={option.name}
          >
            {option.name}
          </span>
          {option.description && !showPath && (
            <span className="block truncate text-xs text-text-muted" title={option.description}>
              {option.description}
            </span>
          )}
          <span className="block truncate text-xs text-text-muted" title={metaText}>
            {metaText}
          </span>
        </span>
      </span>
      <Check className={cn('mt-0.5 h-4 w-4 shrink-0', selected ? 'opacity-100' : 'opacity-0')} />
    </button>
  )
}

interface OptionListProps {
  options: KnowledgeOption[]
  emptyText: string
  selectedIds: Set<number | string>
  showPath: boolean
  onToggleOption: (option: KnowledgeOption) => void
}

function OptionList({
  options,
  emptyText,
  selectedIds,
  showPath,
  onToggleOption,
}: OptionListProps) {
  if (options.length === 0) {
    return <div className="px-4 py-8 text-center text-sm text-text-muted">{emptyText}</div>
  }

  return (
    <div className="px-2 py-2">
      {options.map(option => (
        <OptionRow
          key={`${option.source}-${option.id}`}
          option={option}
          selected={selectedIds.has(option.id)}
          showPath={showPath}
          onToggle={() => onToggleOption(option)}
        />
      ))}
    </div>
  )
}

function getEmptyText(scope: KnowledgeScopeItem | undefined, t: (key: string) => string): string {
  switch (scope?.type) {
    case 'bound':
      return t('contextSelector.noBoundKnowledge')
    case 'personal':
      return t('contextSelector.noPersonalKnowledge')
    case 'group':
      return t('contextSelector.noGroupKnowledge')
    case 'organization':
      return t('contextSelector.noOrganizationKnowledge')
    default:
      return t('no_knowledge_bases')
  }
}

export function KnowledgeContextSelector({
  knowledgeBases,
  boundKnowledgeBases,
  selectedContexts,
  onSelect,
  onDeselect,
  onOpenChange,
  excludeKnowledgeBaseId,
  organizationNamespace,
  isLoading,
  error,
  onRetry,
}: KnowledgeContextSelectorProps) {
  const { t } = useTranslation('knowledge')
  const isMobile = useIsMobile()
  const [searchValue, setSearchValue] = useState('')
  const [activeScopeKey, setActiveScopeKey] = useState<KnowledgeScopeKey | null>(null)
  const [mobileDrillIn, setMobileDrillIn] = useState(false)

  const { scopes, optionsByScope, options } = useMemo(
    () =>
      buildKnowledgeContextGroups({
        knowledgeBases,
        boundKnowledgeBases,
        excludeKnowledgeBaseId,
        organizationNamespace,
        labels: {
          bound: t('contextSelector.boundKnowledge'),
          personal: t('contextSelector.personalKnowledge'),
          groupSection: t('contextSelector.groupKnowledge'),
          organization: t('contextSelector.organizationKnowledge'),
          createdByMe: t('contextSelector.createdByMe'),
          groupFallback: t('contextSelector.groupFallback'),
        },
      }),
    [boundKnowledgeBases, excludeKnowledgeBaseId, knowledgeBases, organizationNamespace, t]
  )

  const selectedIds = useMemo(
    () => new Set(selectedContexts.map(context => context.id)),
    [selectedContexts]
  )

  useEffect(() => {
    if (scopes.length === 0) {
      setActiveScopeKey(null)
      return
    }

    const currentScopeStillExists = activeScopeKey
      ? scopes.some(scope => scope.key === activeScopeKey)
      : false
    const nextScopeKey =
      (currentScopeStillExists ? activeScopeKey : null) ||
      scopes.find(scope => scope.key === 'personal')?.key ||
      scopes.find(scope => scope.type === 'group')?.key ||
      scopes.find(scope => scope.key === 'organization')?.key ||
      scopes[0].key

    setActiveScopeKey(nextScopeKey)
  }, [activeScopeKey, scopes])

  const normalizedSearchValue = searchValue.trim().toLowerCase()
  const isSearching = normalizedSearchValue.length > 0
  const searchResults = useMemo(() => {
    if (!normalizedSearchValue) return []
    return options.filter(option => option.searchText.includes(normalizedSearchValue))
  }, [normalizedSearchValue, options])

  const activeScope = scopes.find(scope => scope.key === activeScopeKey)
  const activeOptions = activeScopeKey ? optionsByScope.get(activeScopeKey) || [] : []

  const handleToggleOption = (option: KnowledgeOption) => {
    if (selectedIds.has(option.id)) {
      onDeselect(option.id)
      return
    }

    onSelect(optionToContext(option))
  }

  const handleSelectScope = (scopeKey: KnowledgeScopeKey) => {
    setActiveScopeKey(scopeKey)
    if (isMobile) {
      setMobileDrillIn(true)
    }
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center px-3 py-4 text-center text-sm text-text-muted">
        {t('common:actions.loading')}
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-3 py-4 text-center">
        <p className="text-sm text-red-500 mb-2">{error}</p>
        <button onClick={onRetry} className="text-xs text-primary hover:underline">
          {t('common:actions.retry')}
        </button>
      </div>
    )
  }

  if (options.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-4 py-6 text-center">
        <p className="text-sm text-text-muted mb-3">{t('no_knowledge_bases')}</p>
        <Link
          href="/knowledge"
          onClick={() => onOpenChange(false)}
          className="inline-flex items-center gap-1.5 text-sm text-primary hover:text-primary/80 font-medium transition-colors"
        >
          {t('go_to_create')}
          <ArrowRight className="w-3.5 h-3.5" />
        </Link>
      </div>
    )
  }

  const searchInput = (
    <div className="border-b border-border p-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
        <Input
          value={searchValue}
          onChange={event => setSearchValue(event.target.value)}
          placeholder={t('contextSelector.searchPlaceholder')}
          data-testid="knowledge-context-search-input"
          className="h-9 bg-surface pl-9"
        />
      </div>
    </div>
  )

  if (isSearching) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-base">
        {searchInput}
        <ScrollArea className="min-h-0 flex-1">
          <div className="px-2 py-2">
            <div className="px-2 pb-1 text-xs font-medium text-text-muted">
              {t('contextSelector.searchResults')}
            </div>
            <OptionList
              options={searchResults}
              emptyText={t('contextSelector.noSearchResults')}
              selectedIds={selectedIds}
              showPath
              onToggleOption={handleToggleOption}
            />
          </div>
        </ScrollArea>
      </div>
    )
  }

  if (isMobile) {
    const mobileTitle = activeScope?.label || t('contextSelector.selectScope')

    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-base">
        {mobileDrillIn ? (
          <>
            <div className="flex min-h-[44px] items-center gap-2 border-b border-border px-2">
              <button
                type="button"
                data-testid="knowledge-mobile-back-button"
                onClick={() => setMobileDrillIn(false)}
                className="flex h-11 min-w-[44px] items-center justify-center rounded-md hover:bg-hover"
                aria-label={t('contextSelector.backToScopes')}
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
              <span className="min-w-0 truncate text-sm font-medium">{mobileTitle}</span>
            </div>
            {searchInput}
            <ScrollArea className="min-h-0 flex-1">
              <OptionList
                options={activeOptions}
                emptyText={getEmptyText(activeScope, t)}
                selectedIds={selectedIds}
                showPath={false}
                onToggleOption={handleToggleOption}
              />
            </ScrollArea>
          </>
        ) : (
          <>
            {searchInput}
            <ScrollArea className="min-h-0 flex-1">
              <ScopeList
                scopes={scopes}
                activeScopeKey={activeScopeKey}
                onSelectScope={handleSelectScope}
              />
            </ScrollArea>
          </>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-base">
      {searchInput}
      <div className="grid min-h-0 flex-1 grid-cols-[180px_minmax(300px,1fr)] overflow-hidden">
        <ScrollArea className="min-h-0 border-r border-border">
          <ScopeList
            scopes={scopes}
            activeScopeKey={activeScopeKey}
            onSelectScope={handleSelectScope}
          />
        </ScrollArea>
        <ScrollArea className="min-h-0">
          <OptionList
            options={activeOptions}
            emptyText={getEmptyText(activeScope, t)}
            selectedIds={selectedIds}
            showPath={false}
            onToggleOption={handleToggleOption}
          />
        </ScrollArea>
      </div>
    </div>
  )
}
