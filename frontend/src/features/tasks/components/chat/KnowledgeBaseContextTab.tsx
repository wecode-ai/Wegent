// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import Link from 'next/link'
import { ArrowRight, Building2, Check, Database, User, Users } from 'lucide-react'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command'
import type { KnowledgeBase } from '@/types/api'
import type { BoundKnowledgeBaseDetail } from '@/types/task-knowledge-base'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { formatDocumentCount } from '@/lib/i18n-helpers'

export interface GroupedKnowledgeBases {
  personal: KnowledgeBase[]
  group: Map<string, KnowledgeBase[]>
  organization: KnowledgeBase[]
}

interface KnowledgeBaseItemProps {
  kb: KnowledgeBase
  isSelected: boolean
  onSelect: () => void
}

function KnowledgeBaseItem({ kb, isSelected, onSelect }: KnowledgeBaseItemProps) {
  const { t } = useTranslation('knowledge')
  const documentCount = kb.document_count || 0
  const documentText = formatDocumentCount(documentCount, t)

  return (
    <CommandItem
      key={kb.id}
      value={`${kb.name} ${kb.description || ''} ${kb.id}`}
      onSelect={onSelect}
      className={cn(
        'group cursor-pointer select-none',
        'px-3 py-2 text-sm text-text-primary',
        'rounded-md mx-1 my-[2px]',
        'data-[selected=true]:bg-primary/10 data-[selected=true]:text-primary',
        'aria-selected:bg-hover',
        '!flex !flex-row !items-start !justify-between !gap-2'
      )}
    >
      <div className="flex items-start gap-2 min-w-0 flex-1">
        <Database className="w-4 h-4 text-text-muted flex-shrink-0 mt-0.5" />
        <div className="flex flex-col min-w-0 flex-1">
          <span className="font-medium text-sm text-text-primary truncate" title={kb.name}>
            {kb.name}
          </span>
          {kb.description && (
            <span className="text-xs text-text-muted truncate" title={kb.description}>
              {kb.description}
            </span>
          )}
          <span className="text-xs text-text-muted mt-0.5">{documentText}</span>
        </div>
      </div>
      <Check
        className={cn(
          'h-3.5 w-3.5 shrink-0 mt-0.5',
          isSelected ? 'opacity-100 text-primary' : 'opacity-0'
        )}
      />
    </CommandItem>
  )
}

interface KnowledgeBaseContextTabProps {
  groupedKnowledgeBases: GroupedKnowledgeBases
  boundKnowledgeBases: BoundKnowledgeBaseDetail[]
  hasKnowledgeBases: boolean
  loading: boolean
  error: string | null
  searchValue: string
  organizationNamespaceLoading: boolean
  onSearchValueChange: (value: string) => void
  onRetry: () => void
  onOpenChange: (open: boolean) => void
  onSelectKnowledgeBase: (kb: KnowledgeBase) => void
  onSelectBoundKnowledgeBase: (kb: BoundKnowledgeBaseDetail) => void
  onSelectGroup: (namespace: string, kbs: KnowledgeBase[]) => void
  isSelected: (id: number | string) => boolean
  isGroupFullySelected: (kbs: KnowledgeBase[]) => boolean
  isGroupPartiallySelected: (kbs: KnowledgeBase[]) => boolean
  onWheel: React.WheelEventHandler<HTMLElement>
}

export function KnowledgeBaseContextTab({
  groupedKnowledgeBases,
  boundKnowledgeBases,
  hasKnowledgeBases,
  loading,
  error,
  searchValue,
  organizationNamespaceLoading,
  onSearchValueChange,
  onRetry,
  onOpenChange,
  onSelectKnowledgeBase,
  onSelectBoundKnowledgeBase,
  onSelectGroup,
  isSelected,
  isGroupFullySelected,
  isGroupPartiallySelected,
  onWheel,
}: KnowledgeBaseContextTabProps) {
  const { t } = useTranslation()

  return (
    <Command className="border-0 flex flex-col">
      <CommandInput
        placeholder={t('knowledge:search_placeholder')}
        value={searchValue}
        onValueChange={onSearchValueChange}
        className={cn(
          'h-9 rounded-none border-b border-border flex-shrink-0',
          'placeholder:text-text-muted text-sm'
        )}
      />
      <CommandList className="max-h-[300px] overflow-y-auto" onWheel={onWheel}>
        {loading || organizationNamespaceLoading ? (
          <div className="py-4 px-3 text-center text-sm text-text-muted">
            {t('common:actions.loading')}
          </div>
        ) : error ? (
          <div className="py-4 px-3 text-center">
            <p className="text-sm text-red-500 mb-2">{error}</p>
            <button onClick={onRetry} className="text-xs text-primary hover:underline">
              {t('common:actions.retry')}
            </button>
          </div>
        ) : !hasKnowledgeBases && boundKnowledgeBases.length === 0 ? (
          <div className="py-6 px-4 text-center">
            <p className="text-sm text-text-muted mb-3">{t('knowledge:no_knowledge_bases')}</p>
            <Link
              href="/knowledge"
              onClick={() => onOpenChange(false)}
              className="inline-flex items-center gap-1.5 text-sm text-primary hover:text-primary/80 font-medium transition-colors"
            >
              {t('knowledge:go_to_create')}
              <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        ) : (
          <>
            <CommandEmpty className="py-4 text-center text-sm text-text-muted">
              {t('common:branches.no_match')}
            </CommandEmpty>

            {boundKnowledgeBases.length > 0 && (
              <>
                <CommandGroup
                  heading={
                    <div className="flex items-center gap-1.5 text-xs font-medium text-text-muted">
                      <Users className="w-3 h-3" />
                      {t('chat:groupChat.knowledge.groupKnowledgeBases')}
                    </div>
                  }
                >
                  {boundKnowledgeBases.map(kb => {
                    const documentCount = kb.document_count || 0
                    const documentText = formatDocumentCount(documentCount, t)
                    const selected = isSelected(kb.id)

                    return (
                      <CommandItem
                        key={`bound-${kb.id}`}
                        value={`${kb.display_name} ${kb.description || ''} ${kb.id}`}
                        onSelect={() => onSelectBoundKnowledgeBase(kb)}
                        className={cn(
                          'group cursor-pointer select-none',
                          'px-3 py-2 text-sm text-text-primary',
                          'rounded-md mx-1 my-[2px]',
                          'data-[selected=true]:bg-primary/10 data-[selected=true]:text-primary',
                          'aria-selected:bg-hover',
                          '!flex !flex-row !items-start !justify-between !gap-2'
                        )}
                      >
                        <div className="flex items-start gap-2 min-w-0 flex-1">
                          <Database className="w-4 h-4 text-primary flex-shrink-0 mt-0.5" />
                          <div className="flex flex-col min-w-0 flex-1">
                            <span
                              className="font-medium text-sm text-text-primary truncate"
                              title={kb.display_name}
                            >
                              {kb.display_name}
                            </span>
                            {kb.description && (
                              <span
                                className="text-xs text-text-muted truncate"
                                title={kb.description}
                              >
                                {kb.description}
                              </span>
                            )}
                            <span className="text-xs text-text-muted mt-0.5">{documentText}</span>
                          </div>
                        </div>
                        <Check
                          className={cn(
                            'h-3.5 w-3.5 shrink-0 mt-0.5',
                            selected ? 'opacity-100 text-primary' : 'opacity-0'
                          )}
                        />
                      </CommandItem>
                    )
                  })}
                </CommandGroup>
                {hasKnowledgeBases && <CommandSeparator />}
              </>
            )}

            {groupedKnowledgeBases.personal.length > 0 && (
              <CommandGroup
                heading={
                  <div className="flex items-center gap-1.5 text-xs font-medium text-text-muted">
                    <User className="w-3 h-3" />
                    {t('knowledge:document.tabs.personal')}
                  </div>
                }
              >
                {groupedKnowledgeBases.personal.map(kb => (
                  <KnowledgeBaseItem
                    key={kb.id}
                    kb={kb}
                    isSelected={isSelected(kb.id)}
                    onSelect={() => onSelectKnowledgeBase(kb)}
                  />
                ))}
              </CommandGroup>
            )}

            {groupedKnowledgeBases.group.size > 0 && (
              <>
                {groupedKnowledgeBases.personal.length > 0 && <CommandSeparator />}
                <CommandGroup
                  heading={
                    <div className="flex items-center gap-1.5 text-xs font-medium text-text-muted">
                      <Users className="w-3 h-3" />
                      {t('knowledge:document.tabs.group')}
                    </div>
                  }
                >
                  {Array.from(groupedKnowledgeBases.group.entries()).map(([namespace, kbs]) => {
                    const groupFullySelected = isGroupFullySelected(kbs)
                    const groupPartiallySelected = isGroupPartiallySelected(kbs)
                    return (
                      <React.Fragment key={namespace}>
                        <CommandItem
                          value={`group:${namespace}`}
                          onSelect={() => onSelectGroup(namespace, kbs)}
                          className={cn(
                            'group cursor-pointer select-none',
                            'px-3 py-1.5 text-xs font-medium text-text-secondary',
                            'bg-muted/50 rounded-md mx-1 my-1',
                            'data-[selected=true]:bg-primary/10 data-[selected=true]:text-primary',
                            'aria-selected:bg-hover',
                            '!flex !flex-row !items-center !justify-between !gap-2'
                          )}
                        >
                          <span>{namespace}</span>
                          <Check
                            className={cn(
                              'h-3.5 w-3.5 shrink-0',
                              groupFullySelected
                                ? 'opacity-100 text-primary'
                                : groupPartiallySelected
                                  ? 'opacity-100 text-primary/50'
                                  : 'opacity-0'
                            )}
                          />
                        </CommandItem>
                        {kbs.map(kb => (
                          <KnowledgeBaseItem
                            key={kb.id}
                            kb={kb}
                            isSelected={isSelected(kb.id)}
                            onSelect={() => onSelectKnowledgeBase(kb)}
                          />
                        ))}
                      </React.Fragment>
                    )
                  })}
                </CommandGroup>
              </>
            )}

            {groupedKnowledgeBases.organization.length > 0 && (
              <>
                {(groupedKnowledgeBases.personal.length > 0 ||
                  groupedKnowledgeBases.group.size > 0) && <CommandSeparator />}
                <CommandGroup
                  heading={
                    <div className="flex items-center gap-1.5 text-xs font-medium text-text-muted">
                      <Building2 className="w-3 h-3" />
                      {t('knowledge:document.tabs.organization')}
                    </div>
                  }
                >
                  {groupedKnowledgeBases.organization.map(kb => (
                    <KnowledgeBaseItem
                      key={kb.id}
                      kb={kb}
                      isSelected={isSelected(kb.id)}
                      onSelect={() => onSelectKnowledgeBase(kb)}
                    />
                  ))}
                </CommandGroup>
              </>
            )}
          </>
        )}
      </CommandList>
    </Command>
  )
}
