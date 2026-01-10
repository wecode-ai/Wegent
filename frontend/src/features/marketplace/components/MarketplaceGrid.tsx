// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { MagnifyingGlassIcon } from '@heroicons/react/24/outline'
import { useTranslation } from '@/hooks/useTranslation'
import { useToast } from '@/hooks/use-toast'
import {
  fetchMarketplaceTeams,
  fetchMarketplaceCategories,
  installMarketplaceTeam,
  uninstallMarketplaceTeam,
} from '@/apis/marketplace'
import type { MarketplaceTeam, CategoryItem, InstallMode } from '@/types/marketplace'
import { MarketplaceTeamCard } from './MarketplaceTeamCard'
import { InstallModeDialog } from './InstallModeDialog'
import LoadingState from '@/features/common/LoadingState'
import '@/features/common/scrollbar.css'

export function MarketplaceGrid() {
  const { t } = useTranslation('marketplace')
  const { toast } = useToast()

  // State
  const [teams, setTeams] = useState<MarketplaceTeam[]>([])
  const [categories, setCategories] = useState<CategoryItem[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(true)

  // Install dialog state
  const [installDialogOpen, setInstallDialogOpen] = useState(false)
  const [selectedTeam, setSelectedTeam] = useState<MarketplaceTeam | null>(null)
  const [isInstalling, setIsInstalling] = useState(false)

  const limit = 20

  // Load categories
  useEffect(() => {
    async function loadCategories() {
      try {
        const response = await fetchMarketplaceCategories()
        setCategories(response.categories)
      } catch (error) {
        console.error('Failed to load categories:', error)
      }
    }
    loadCategories()
  }, [])

  // Load teams
  const loadTeams = useCallback(
    async (reset = false) => {
      const currentPage = reset ? 1 : page
      setIsLoading(true)
      try {
        const response = await fetchMarketplaceTeams({
          page: currentPage,
          limit,
          search: searchQuery || undefined,
          category: selectedCategory || undefined,
        })

        if (reset) {
          setTeams(response.items)
          setPage(1)
        } else {
          setTeams(prev => [...prev, ...response.items])
        }
        setTotal(response.total)
        setHasMore(currentPage * limit < response.total)
      } catch (error) {
        console.error('Failed to load marketplace teams:', error)
        toast({
          variant: 'destructive',
          title: t('error_loading'),
        })
      } finally {
        setIsLoading(false)
      }
    },
    [page, searchQuery, selectedCategory, t, toast]
  )

  // Initial load and reload on filter change
  useEffect(() => {
    loadTeams(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, selectedCategory])

  // Handle search
  const handleSearch = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value)
  }, [])

  // Handle category change
  const handleCategoryChange = useCallback((category: string | null) => {
    setSelectedCategory(category)
  }, [])

  // Handle install click
  const handleInstallClick = useCallback((team: MarketplaceTeam) => {
    setSelectedTeam(team)
    // If only one mode is available, install directly
    if (team.allow_reference && !team.allow_copy) {
      handleInstall(team, 'reference')
    } else if (!team.allow_reference && team.allow_copy) {
      handleInstall(team, 'copy')
    } else {
      // Both modes available, show dialog
      setInstallDialogOpen(true)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Handle install
  const handleInstall = useCallback(
    async (team: MarketplaceTeam, mode: InstallMode) => {
      setIsInstalling(true)
      try {
        await installMarketplaceTeam(team.id, mode)
        toast({
          title: t('install_success'),
          description: team.name,
        })
        // Update team status in list
        setTeams(prev =>
          prev.map(t =>
            t.id === team.id ? { ...t, is_installed: true, installed_mode: mode, install_count: t.install_count + 1 } : t
          )
        )
        setInstallDialogOpen(false)
      } catch (error) {
        console.error('Failed to install team:', error)
        toast({
          variant: 'destructive',
          title: t('install_failed'),
        })
      } finally {
        setIsInstalling(false)
      }
    },
    [t, toast]
  )

  // Handle uninstall
  const handleUninstall = useCallback(
    async (team: MarketplaceTeam) => {
      try {
        await uninstallMarketplaceTeam(team.id)
        toast({
          title: t('uninstall_success'),
          description: team.name,
        })
        // Update team status in list
        setTeams(prev =>
          prev.map(t => (t.id === team.id ? { ...t, is_installed: false, installed_mode: null } : t))
        )
      } catch (error) {
        console.error('Failed to uninstall team:', error)
        toast({
          variant: 'destructive',
          title: t('uninstall_failed'),
        })
      }
    },
    [t, toast]
  )

  // Load more
  const handleLoadMore = useCallback(() => {
    if (!isLoading && hasMore) {
      setPage(prev => prev + 1)
      loadTeams(false)
    }
  }, [isLoading, hasMore, loadTeams])

  // Category tabs with "All" option
  const categoryTabs = useMemo(() => {
    const allCount = categories.reduce((sum, cat) => sum + cat.count, 0)
    return [{ value: null, label: t('categories.all'), count: allCount }, ...categories]
  }, [categories, t])

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden w-full max-w-full">
      {/* Header with search */}
      <div className="flex-shrink-0 mb-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
          <div>
            <h2 className="text-xl font-semibold text-text-primary">{t('title')}</h2>
            <p className="text-sm text-text-muted">{t('description')}</p>
          </div>
          {/* Search box */}
          <div className="relative w-full sm:w-64">
            <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
            <input
              type="text"
              value={searchQuery}
              onChange={handleSearch}
              placeholder={t('search_placeholder')}
              className="w-full pl-9 pr-3 py-2 text-sm border border-border rounded-md bg-surface focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>
        </div>

        {/* Category tabs */}
        <div className="flex items-center gap-1 overflow-x-auto pb-2 custom-scrollbar">
          {categoryTabs.map(cat => (
            <button
              key={cat.value ?? 'all'}
              type="button"
              onClick={() => handleCategoryChange(cat.value as string | null)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md transition-colors whitespace-nowrap ${
                selectedCategory === cat.value
                  ? 'bg-primary text-white'
                  : 'bg-muted text-text-secondary hover:text-text-primary hover:bg-hover'
              }`}
            >
              {t(`categories.${cat.value || 'all'}`)}
              <span className="text-xs opacity-75">({cat.count})</span>
            </button>
          ))}
        </div>
      </div>

      {/* Teams grid */}
      <div className="flex-1 overflow-y-auto custom-scrollbar">
        {isLoading && teams.length === 0 ? (
          <LoadingState fullScreen={false} message={t('loading')} />
        ) : teams.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-text-muted">
            <p className="text-lg">{t('no_teams')}</p>
            <p className="text-sm mt-2">{t('no_teams_hint')}</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {teams.map(team => (
                <MarketplaceTeamCard
                  key={team.id}
                  team={team}
                  onInstall={() => handleInstallClick(team)}
                  onUninstall={() => handleUninstall(team)}
                />
              ))}
            </div>

            {/* Load more */}
            {hasMore && (
              <div className="flex justify-center py-6">
                <button
                  type="button"
                  onClick={handleLoadMore}
                  disabled={isLoading}
                  className="px-6 py-2 text-sm font-medium text-primary border border-primary rounded-md hover:bg-primary/5 disabled:opacity-50"
                >
                  {isLoading ? t('loading_more') : t('load_more')}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Install mode dialog */}
      {selectedTeam && (
        <InstallModeDialog
          open={installDialogOpen}
          onClose={() => setInstallDialogOpen(false)}
          team={selectedTeam}
          onInstall={mode => handleInstall(selectedTeam, mode)}
          isInstalling={isInstalling}
        />
      )}
    </div>
  )
}
