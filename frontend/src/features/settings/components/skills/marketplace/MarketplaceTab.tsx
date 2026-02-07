// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
import { SearchIcon, SortAscIcon, PackageIcon } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import LoadingState from '@/features/common/LoadingState'
import MarketplaceSidebar from './MarketplaceSidebar'
import MarketplaceSkillCard from './MarketplaceSkillCard'
import MarketplaceSkillDetail from './MarketplaceSkillDetail'
import {
  fetchSkillCategories,
  fetchMarketplaceSkills,
  collectSkill,
  uncollectSkill,
} from '@/apis/skills'
import type {
  SkillCategory,
  MarketplaceSkill,
  MarketplaceSkillListResponse,
} from '@/types/api'

interface MarketplaceTabProps {
  onSkillCollected?: () => void
}

type SortOption = 'downloadCount' | 'createdAt' | 'name'

export default function MarketplaceTab({ onSkillCollected }: MarketplaceTabProps) {
  const { t } = useTranslation()
  const { toast } = useToast()

  // State
  const [categories, setCategories] = useState<SkillCategory[]>([])
  const [skills, setSkills] = useState<MarketplaceSkill[]>([])
  const [total, setTotal] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState<SortOption>('downloadCount')
  const [page, setPage] = useState(0)
  const [selectedSkillId, setSelectedSkillId] = useState<number | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [collectingIds, setCollectingIds] = useState<Set<number>>(new Set())
  const [collectedIds, setCollectedIds] = useState<Set<number>>(new Set())

  const LIMIT = 20

  // Load categories
  const loadCategories = useCallback(async () => {
    try {
      const data = await fetchSkillCategories()
      setCategories(data)
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('common:common.error'),
        description: error instanceof Error ? error.message : t('common:common.unknown_error'),
      })
    }
  }, [toast, t])

  // Load skills
  const loadSkills = useCallback(async () => {
    setIsLoading(true)
    try {
      const data = await fetchMarketplaceSkills({
        skip: page * LIMIT,
        limit: LIMIT,
        search: search || undefined,
        category: selectedCategory || undefined,
        sort_by: sortBy,
        sort_order: 'desc',
      })
      setSkills(data.items)
      setTotal(data.total)
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('common:common.error'),
        description: error instanceof Error ? error.message : t('common:common.unknown_error'),
      })
    } finally {
      setIsLoading(false)
    }
  }, [page, search, selectedCategory, sortBy, toast, t])

  // Initial load
  useEffect(() => {
    loadCategories()
  }, [loadCategories])

  useEffect(() => {
    loadSkills()
  }, [loadSkills])

  // Handlers
  const handleCategoryChange = (category: string | null) => {
    setSelectedCategory(category)
    setPage(0)
  }

  const handleSearchChange = (value: string) => {
    setSearch(value)
    setPage(0)
  }

  const handleSortChange = (value: SortOption) => {
    setSortBy(value)
    setPage(0)
  }

  const handleSkillClick = (skill: MarketplaceSkill) => {
    const skillId = parseInt(skill.metadata.labels?.id || '0', 10)
    setSelectedSkillId(skillId)
    setDetailOpen(true)
  }

  const handleCollect = async (skillId: number) => {
    setCollectingIds((prev) => new Set(prev).add(skillId))
    try {
      await collectSkill(skillId)
      setCollectedIds((prev) => new Set(prev).add(skillId))
      toast({
        title: t('common:common.success'),
        description: t('common:skills.marketplace.collect_success'),
      })
      onSkillCollected?.()
      loadSkills() // Refresh to update download count
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('common:common.error'),
        description: error instanceof Error ? error.message : t('common:common.unknown_error'),
      })
    } finally {
      setCollectingIds((prev) => {
        const next = new Set(prev)
        next.delete(skillId)
        return next
      })
    }
  }

  const handleUncollect = async (skillId: number) => {
    setCollectingIds((prev) => new Set(prev).add(skillId))
    try {
      await uncollectSkill(skillId)
      setCollectedIds((prev) => {
        const next = new Set(prev)
        next.delete(skillId)
        return next
      })
      toast({
        title: t('common:common.success'),
        description: t('common:skills.marketplace.uncollect_success'),
      })
      onSkillCollected?.()
      loadSkills() // Refresh to update download count
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('common:common.error'),
        description: error instanceof Error ? error.message : t('common:common.unknown_error'),
      })
    } finally {
      setCollectingIds((prev) => {
        const next = new Set(prev)
        next.delete(skillId)
        return next
      })
    }
  }

  const totalSkillCount = categories.reduce((sum, cat) => sum + (cat.skillCount || 0), 0)
  const totalPages = Math.ceil(total / LIMIT)

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <MarketplaceSidebar
        categories={categories}
        selectedCategory={selectedCategory}
        onSelectCategory={handleCategoryChange}
        totalSkillCount={totalSkillCount}
      />

      {/* Main content */}
      <div className="flex-1 pl-6 flex flex-col min-w-0">
        {/* Search and sort */}
        <div className="flex items-center gap-4 mb-4">
          <div className="relative flex-1">
            <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
            <Input
              placeholder={t('common:skills.marketplace.search_placeholder')}
              value={search}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={sortBy} onValueChange={(v) => handleSortChange(v as SortOption)}>
            <SelectTrigger className="w-[180px]">
              <SortAscIcon className="w-4 h-4 mr-2" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="downloadCount">
                {t('common:skills.marketplace.sort_downloads')}
              </SelectItem>
              <SelectItem value="createdAt">
                {t('common:skills.marketplace.sort_newest')}
              </SelectItem>
              <SelectItem value="name">
                {t('common:skills.marketplace.sort_name')}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Skills grid */}
        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <LoadingState message={t('common:common.loading')} />
          ) : skills.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <PackageIcon className="w-12 h-12 text-text-muted mb-4" />
              <h3 className="text-base font-medium text-text-primary mb-2">
                {t('common:skills.marketplace.no_skills')}
              </h3>
              <p className="text-sm text-text-muted">
                {search
                  ? t('common:skills.marketplace.no_search_results')
                  : t('common:skills.marketplace.no_skills_in_category')}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {skills.map((skill) => {
                const skillId = parseInt(skill.metadata.labels?.id || '0', 10)
                return (
                  <MarketplaceSkillCard
                    key={skillId}
                    skill={skill}
                    isCollected={collectedIds.has(skillId)}
                    isCollecting={collectingIds.has(skillId)}
                    onCollect={() => handleCollect(skillId)}
                    onUncollect={() => handleUncollect(skillId)}
                    onClick={() => handleSkillClick(skill)}
                  />
                )
              })}
            </div>
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-2 mt-4 pt-4 border-t border-border">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
            >
              {t('common:actions.previous')}
            </Button>
            <span className="text-sm text-text-muted">
              {page + 1} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
            >
              {t('common:actions.next')}
            </Button>
          </div>
        )}
      </div>

      {/* Skill detail sheet */}
      <MarketplaceSkillDetail
        skillId={selectedSkillId}
        open={detailOpen}
        onClose={() => {
          setDetailOpen(false)
          setSelectedSkillId(null)
        }}
        onCollect={handleCollect}
        onUncollect={handleUncollect}
      />
    </div>
  )
}
