// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ExternalLink, Loader2, Package, Search } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import {
  downloadSkill,
  searchSkills,
  type MarketSkill,
  type SkillMarketProvider,
} from '@/apis/skillMarketplace'
import { uploadSkill } from '@/apis/skills'
import { useTranslation } from '@/hooks/useTranslation'
import { SkillMarketplaceCard } from './SkillMarketplaceCard'

interface SkillMarketplaceSearchProps {
  provider: SkillMarketProvider
  onSkillsChange?: () => void
  namespace?: string
  /** Keyword supplied by the URL so deep links can open a marketplace pre-searched. */
  initialKeyword?: string
  /** Reports user-initiated searches so the page can keep the URL shareable. */
  onKeywordChange?: (keyword: string) => void
}

interface InstallingSkill {
  skillKey: string
  status: 'downloading' | 'installing' | 'success' | 'error'
  error?: string
}

/** Search UI for one external skill marketplace provider. */
export function SkillMarketplaceSearch({
  provider,
  onSkillsChange,
  namespace = 'default',
  initialKeyword = '',
  onKeywordChange,
}: SkillMarketplaceSearchProps) {
  const { t } = useTranslation('resource-library')
  const { toast } = useToast()
  const normalizedInitialKeyword = initialKeyword.trim()

  // Search state
  const [keyword, setKeyword] = useState(normalizedInitialKeyword)
  const [searching, setSearching] = useState(false)
  const [skills, setSkills] = useState<MarketSkill[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize] = useState(20)
  const [hasSearched, setHasSearched] = useState(false)
  const initiallyLoadedProviderRef = useRef<string | null>(null)
  const lastInitialKeywordRef = useRef(normalizedInitialKeyword)
  const committedKeywordRef = useRef(normalizedInitialKeyword)
  const submittedKeywordRef = useRef<string | null>(null)
  const searchRequestIdRef = useRef(0)
  const onKeywordChangeRef = useRef(onKeywordChange)
  onKeywordChangeRef.current = onKeywordChange

  // Installation state
  const [installingSkills, setInstallingSkills] = useState<Map<string, InstallingSkill>>(new Map())

  /** Loads one result page, ignoring responses superseded by a newer search. */
  const handleSearch = useCallback(
    async (searchKeyword: string, searchPage = 1) => {
      const requestId = ++searchRequestIdRef.current
      setSearching(true)
      setHasSearched(true)

      try {
        const result = await searchSkills(provider.key, {
          keyword: searchKeyword || undefined,
          page: searchPage,
          pageSize,
        })

        if (requestId !== searchRequestIdRef.current) return
        setSkills(result.skills)
        setTotal(result.total)
        setPage(result.page)
      } catch (error) {
        if (requestId !== searchRequestIdRef.current) return
        // Clear stale results on error to avoid showing outdated data
        setSkills([])
        setTotal(0)
        setPage(1)
        toast({
          variant: 'destructive',
          title: t('external_skill_market.search_failed'),
          description:
            error instanceof Error ? error.message : t('external_skill_market.unknown_error'),
        })
      } finally {
        if (requestId === searchRequestIdRef.current) setSearching(false)
      }
    },
    [pageSize, provider.key, toast, t]
  )

  // Handle page change
  const handlePageChange = (newPage: number) => {
    void handleSearch(committedKeywordRef.current, newPage)
  }

  /** Runs a user-initiated search and reports the keyword back to the page. */
  const submitSearch = () => {
    const nextKeyword = keyword.trim()
    committedKeywordRef.current = nextKeyword
    // Remember the local submission so the page writing it back to the URL does
    // not trigger a duplicate request. Re-submitting the current URL keyword
    // cannot change the prop, so there is nothing to suppress.
    submittedKeywordRef.current = nextKeyword === lastInitialKeywordRef.current ? null : nextKeyword
    void handleSearch(nextKeyword, 1)
    onKeywordChangeRef.current?.(nextKeyword)
  }

  useEffect(() => {
    const providerChanged = initiallyLoadedProviderRef.current !== provider.key
    const initialKeywordChanged = lastInitialKeywordRef.current !== normalizedInitialKeyword
    lastInitialKeywordRef.current = normalizedInitialKeyword
    if (!providerChanged && !initialKeywordChanged) return
    if (!providerChanged && submittedKeywordRef.current === normalizedInitialKeyword) {
      submittedKeywordRef.current = null
      return
    }
    submittedKeywordRef.current = null
    initiallyLoadedProviderRef.current = provider.key
    committedKeywordRef.current = normalizedInitialKeyword
    setKeyword(normalizedInitialKeyword)
    void handleSearch(normalizedInitialKeyword, 1)
  }, [handleSearch, normalizedInitialKeyword, provider.key])

  // Install skill
  const handleInstallSkill = async (skill: MarketSkill) => {
    const existingStatus = installingSkills.get(skill.skillKey)
    // Allow retry if status is error, block if downloading/installing/success
    if (existingStatus && existingStatus.status !== 'error') return

    setInstallingSkills(prev => {
      const newMap = new Map(prev)
      newMap.set(skill.skillKey, { skillKey: skill.skillKey, status: 'downloading' })
      return newMap
    })

    try {
      // Download skill from market
      const blob = await downloadSkill(provider.key, skill.skillKey)

      setInstallingSkills(prev => {
        const newMap = new Map(prev)
        newMap.set(skill.skillKey, { skillKey: skill.skillKey, status: 'installing' })
        return newMap
      })

      // Use originalSkillKey provided by the API/provider for installation
      const installKey = skill.originalSkillKey

      // Convert blob to file
      const file = new File([blob], `${installKey}.zip`, { type: 'application/zip' })

      // Upload to local system
      await uploadSkill(file, installKey, namespace)

      setInstallingSkills(prev => {
        const newMap = new Map(prev)
        newMap.set(skill.skillKey, { skillKey: skill.skillKey, status: 'success' })
        return newMap
      })

      toast({
        title: t('external_skill_market.install_success'),
        description: t('external_skill_market.install_success_message', {
          skillName: skill.name,
        }),
      })

      onSkillsChange?.()
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)

      setInstallingSkills(prev => {
        const newMap = new Map(prev)
        newMap.set(skill.skillKey, {
          skillKey: skill.skillKey,
          status: 'error',
          error: errorMessage,
        })
        return newMap
      })

      toast({
        variant: 'destructive',
        title: t('external_skill_market.install_failed'),
        description: errorMessage,
      })
    }
  }

  // Handle key down in search input
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      submitSearch()
    }
  }

  // Calculate total pages
  const totalPages = Math.ceil(total / pageSize)

  // Get installation status for a skill
  const getInstallStatus = (skillKey: string): InstallingSkill | undefined => {
    return installingSkills.get(skillKey)
  }

  const content = (
    <div
      className="flex flex-1 flex-col gap-4 overflow-hidden"
      data-testid={`skill-marketplace-${provider.key}`}
    >
      {/* Search Input */}
      <div className="flex gap-2 rounded-xl border border-border bg-surface p-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-text-muted" />
          <Input
            data-testid={`skill-marketplace-search-input-${provider.key}`}
            placeholder={t('external_skill_market.search_placeholder', {
              marketName: provider.name,
            })}
            value={keyword}
            onChange={e => setKeyword(e.target.value)}
            onKeyDown={handleKeyDown}
            className="h-11 bg-base pl-9 sm:h-10"
          />
        </div>
        <Button
          data-testid={`skill-marketplace-search-button-${provider.key}`}
          variant="primary"
          className="h-11 min-w-[44px] px-4 sm:h-10"
          onClick={submitSearch}
          disabled={searching}
        >
          {searching ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              {t('external_skill_market.searching')}
            </>
          ) : (
            <>
              <Search className="w-4 h-4 mr-2" />
              {t('external_skill_market.search')}
            </>
          )}
        </Button>
        {provider.marketUrl && (
          <Button
            asChild
            variant="outline"
            className="h-11 shrink-0 px-4 sm:h-10"
            data-testid={`skill-marketplace-open-${provider.key}`}
          >
            <a href={provider.marketUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-4 w-4" aria-hidden />
              {t('external_skill_market.open_market', { marketName: provider.name })}
            </a>
          </Button>
        )}
      </div>
      {/* Results Area */}
      <div className="flex-1 overflow-y-auto min-h-[300px]">
        {!hasSearched ? (
          <div className="flex flex-col items-center justify-center h-full text-text-muted">
            <Package className="w-12 h-12 mb-4 opacity-50" />
            <p>
              {t('external_skill_market.search_hint', {
                marketName: provider.name,
              })}
            </p>
          </div>
        ) : searching ? (
          <div className="flex flex-col items-center justify-center h-full text-text-muted">
            <Loader2 className="w-8 h-8 animate-spin mb-2" />
            <p>{t('external_skill_market.searching')}</p>
          </div>
        ) : skills.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-text-muted">
            <Package className="w-12 h-12 mb-4 opacity-50" />
            <p>{t('external_skill_market.no_results')}</p>
          </div>
        ) : (
          <div
            className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
            data-testid="skill-marketplace-grid"
          >
            {skills.map(skill => {
              const installStatus = getInstallStatus(skill.skillKey)
              return (
                <SkillMarketplaceCard
                  key={skill.skillKey}
                  skill={skill}
                  installStatus={installStatus}
                  onInstall={handleInstallSkill}
                />
              )
            })}
          </div>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div
          className="flex items-center justify-center gap-3 py-2"
          data-testid="skill-marketplace-pagination"
        >
          <Button
            data-testid={`skill-marketplace-previous-${provider.key}`}
            variant="outline"
            size="sm"
            onClick={() => handlePageChange(page - 1)}
            disabled={page <= 1 || searching}
            className="h-10 min-w-[76px]"
          >
            {t('external_skill_market.previous')}
          </Button>
          <span className="min-w-24 text-center text-sm text-text-muted">
            {t('external_skill_market.page_info', { current: page, total: totalPages })}
          </span>
          <Button
            data-testid={`skill-marketplace-next-${provider.key}`}
            variant="outline"
            size="sm"
            onClick={() => handlePageChange(page + 1)}
            disabled={page >= totalPages || searching}
            className="h-10 min-w-[76px]"
          >
            {t('external_skill_market.next')}
          </Button>
        </div>
      )}
    </div>
  )

  return (
    <section className="flex min-h-[420px] flex-col gap-4" data-testid="skill-marketplace-search">
      {content}
    </section>
  )
}
