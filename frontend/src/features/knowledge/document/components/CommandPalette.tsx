// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * CommandPalette - Global search dialog for knowledge bases.
 *
 * Provides quick search and navigation using Cmd+K shortcut.
 */

'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { Search, BookOpen, Database, Users } from 'lucide-react'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { KnowledgeBase } from '@/types/knowledge'

// Re-export KnowledgeGroup type for use in this file
export interface KnowledgeGroup {
  id: string
  type: 'personal' | 'group' | 'organization'
  name: string
  displayName: string
  kbCount: number
}

export interface SearchResult {
  type: 'kb' | 'group'
  id: string | number
  data: KnowledgeBase | KnowledgeGroup
}

export interface CommandPaletteProps {
  /** Whether the dialog is open */
  open: boolean
  /** Callback when open state changes */
  onOpenChange: (open: boolean) => void
  /** Callback when a KB is selected */
  onSelectKb: (kb: KnowledgeBase) => void
  /** Callback when a group is selected */
  onSelectGroup: (groupId: string) => void
  /** Optional: all knowledge bases for searching */
  allKnowledgeBases?: KnowledgeBase[]
  /** Optional: all groups for searching */
  allGroups?: KnowledgeGroup[]
  /** Optional: recent searches */
  recentSearches?: string[]
}

export function CommandPalette({
  open,
  onOpenChange,
  onSelectKb,
  onSelectGroup,
  allKnowledgeBases = [],
  allGroups = [],
  recentSearches: _recentSearches = [],
}: CommandPaletteProps) {
  const { t } = useTranslation('knowledge')
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (open) {
      setQuery('')
      setSelectedIndex(0)
    }
  }, [open])

  // Filter results based on query
  const results = useMemo((): SearchResult[] => {
    if (!query.trim()) {
      // Show recent items when no query
      return []
    }

    const lowerQuery = query.toLowerCase()
    const kbResults: SearchResult[] = allKnowledgeBases
      .filter(
        kb =>
          kb.name.toLowerCase().includes(lowerQuery) ||
          kb.description?.toLowerCase().includes(lowerQuery)
      )
      .slice(0, 10)
      .map(kb => ({
        type: 'kb' as const,
        id: kb.id,
        data: kb,
      }))

    const groupResults: SearchResult[] = allGroups
      .filter(g => g.displayName.toLowerCase().includes(lowerQuery))
      .slice(0, 5)
      .map(g => ({
        type: 'group' as const,
        id: g.id,
        data: g,
      }))

    return [...kbResults, ...groupResults]
  }, [query, allKnowledgeBases, allGroups])

  // Reset selectedIndex when results change to prevent out-of-bounds
  useEffect(() => {
    if (selectedIndex >= results.length && results.length > 0) {
      setSelectedIndex(results.length - 1)
    } else if (results.length === 0) {
      setSelectedIndex(0)
    }
  }, [results.length, selectedIndex])

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex(prev => Math.min(prev + 1, results.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex(prev => Math.max(prev - 1, 0))
      } else if (e.key === 'Enter' && results.length > 0) {
        e.preventDefault()
        const selected = results[selectedIndex]
        if (selected) {
          if (selected.type === 'kb') {
            onSelectKb(selected.data as KnowledgeBase)
          } else {
            onSelectGroup(selected.id as string)
          }
        }
      }
    },
    [results, selectedIndex, onSelectKb, onSelectGroup]
  )

  // Handle result click
  const handleResultClick = useCallback(
    (result: SearchResult) => {
      if (result.type === 'kb') {
        onSelectKb(result.data as KnowledgeBase)
      } else {
        onSelectGroup(result.id as string)
      }
    },
    [onSelectKb, onSelectGroup]
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg p-0 gap-0 overflow-hidden" data-testid="command-palette">
        {/* Search input */}
        <div className="flex items-center gap-2 px-3 border-b border-border">
          <Search className="w-4 h-4 text-text-muted flex-shrink-0" />
          <Input
            value={query}
            onChange={e => {
              setQuery(e.target.value)
              setSelectedIndex(0)
            }}
            onKeyDown={handleKeyDown}
            placeholder={t('document.sidebar.searchPlaceholder', '搜索知识库...')}
            className="border-0 focus-visible:ring-0 px-0 h-12"
            autoFocus
            data-testid="command-palette-input"
          />
          <kbd className="hidden sm:inline-flex text-xs bg-muted px-1.5 py-0.5 rounded font-mono text-text-muted">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div className="max-h-80 overflow-y-auto">
          {query && results.length === 0 ? (
            <div className="py-8 text-center text-sm text-text-muted">
              {t('document.sidebar.noSearchResults', '未找到相关知识库')}
            </div>
          ) : results.length > 0 ? (
            <div className="py-2">
              {/* KB results */}
              {results.filter(r => r.type === 'kb').length > 0 && (
                <div>
                  <div className="px-3 py-1.5 text-xs font-medium text-text-muted">
                    {t('document.sidebar.knowledgeBases', '知识库')}
                  </div>
                  {results
                    .filter(r => r.type === 'kb')
                    .map((result, index) => {
                      const kb = result.data as KnowledgeBase
                      const isSelected = index === selectedIndex
                      return (
                        <button
                          key={`kb-${result.id}`}
                          onClick={() => handleResultClick(result)}
                          className={cn(
                            'w-full flex items-center gap-3 px-3 py-2 text-sm transition-colors',
                            isSelected ? 'bg-primary/10 text-primary' : 'hover:bg-muted'
                          )}
                          data-testid={`search-result-kb-${kb.id}`}
                        >
                          {kb.kb_type === 'classic' ? (
                            <Database className="w-4 h-4 text-text-secondary flex-shrink-0" />
                          ) : (
                            <BookOpen className="w-4 h-4 text-primary flex-shrink-0" />
                          )}
                          <span className="flex-1 text-left truncate">{kb.name}</span>
                          <span className="text-xs text-text-muted truncate max-w-32">
                            {kb.namespace === 'default'
                              ? t('document.sidebar.personal')
                              : kb.namespace}
                          </span>
                        </button>
                      )
                    })}
                </div>
              )}

              {/* Group results */}
              {results.filter(r => r.type === 'group').length > 0 && (
                <div>
                  <div className="px-3 py-1.5 text-xs font-medium text-text-muted mt-2">
                    {t('document.sidebar.groups', '分组')}
                  </div>
                  {results
                    .filter(r => r.type === 'group')
                    .map((result, index) => {
                      const group = result.data as KnowledgeGroup
                      const kbResultsCount = results.filter(r => r.type === 'kb').length
                      const isSelected = kbResultsCount + index === selectedIndex
                      return (
                        <button
                          key={`group-${result.id}`}
                          onClick={() => handleResultClick(result)}
                          className={cn(
                            'w-full flex items-center gap-3 px-3 py-2 text-sm transition-colors',
                            isSelected ? 'bg-primary/10 text-primary' : 'hover:bg-muted'
                          )}
                          data-testid={`search-result-group-${group.id}`}
                        >
                          <Users className="w-4 h-4 text-text-secondary flex-shrink-0" />
                          <span className="flex-1 text-left truncate">{group.displayName}</span>
                          <span className="text-xs text-text-muted">
                            {group.kbCount} {t('document.sidebar.kbCount', '个知识库')}
                          </span>
                        </button>
                      )
                    })}
                </div>
              )}
            </div>
          ) : (
            <div className="py-8 text-center text-sm text-text-muted">
              {t('document.sidebar.typeToSearch', '输入关键词搜索知识库')}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default CommandPalette
