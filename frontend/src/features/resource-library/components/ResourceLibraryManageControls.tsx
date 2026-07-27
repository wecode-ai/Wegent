// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useMemo, useState } from 'react'
import { ArrowUpDown, Building2, ChevronDown, Search } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useTranslation } from '@/hooks/useTranslation'
import type { ResourceLibrarySortMode } from '../resourceSorting'
import type {
  ManagedResourceType,
  ResourceLibraryModelCategoryFilter,
  ResourceLibraryTab,
} from '../types'
import type { TeamGroupSelection, TeamGroupStatus } from '../useTeamCapabilityGroups'
import type { TeamModeFilter } from '@/features/tasks/components/selector/team-selector-utils'
import type { Group } from '@/types/group'

interface ResourceLibraryManageControlsProps {
  resourceType: ManagedResourceType
  tab: ResourceLibraryTab
  tabs: ResourceLibraryTab[]
  mode: TeamModeFilter
  modelCategory: ResourceLibraryModelCategoryFilter
  sort: ResourceLibrarySortMode
  showSort?: boolean
  teamGroups?: Group[]
  teamGroupStatus?: TeamGroupStatus
  teamSelection?: TeamGroupSelection
  onTabChange: (tab: ResourceLibraryTab) => void
  onTeamSelectionChange?: (selection: TeamGroupSelection) => void
  onTeamGroupsRequest?: () => void
  onModeChange: (mode: TeamModeFilter) => void
  onModelCategoryChange: (category: ResourceLibraryModelCategoryFilter) => void
  onSortChange: (sort: ResourceLibrarySortMode) => void
}

const modeOptions: TeamModeFilter[] = ['all', 'chat', 'code', 'task']
const modelCategoryOptions: ResourceLibraryModelCategoryFilter[] = [
  'all',
  'llm',
  'embedding',
  'rerank',
]

function getGroupDisplayName(group: Group): string {
  return group.display_name || group.name
}

export function ResourceLibraryManageControls({
  resourceType,
  tab,
  tabs,
  mode,
  modelCategory,
  sort,
  showSort = true,
  teamGroups = [],
  teamGroupStatus,
  teamSelection,
  onTabChange,
  onTeamSelectionChange,
  onTeamGroupsRequest,
  onModeChange,
  onModelCategoryChange,
  onSortChange,
}: ResourceLibraryManageControlsProps) {
  const { t } = useTranslation('resource-library')
  const { t: tCommon } = useTranslation('common')
  const [teamSearchQuery, setTeamSearchQuery] = useState('')
  const showModeFilter = tab !== 'discover' && tab !== 'published' && resourceType === 'agent'
  const showModelCategoryFilter =
    tab !== 'discover' && tab !== 'published' && resourceType === 'model'
  const showTeamFilter = tab === 'team' && Boolean(teamSelection && onTeamSelectionChange)
  const selectedTeamGroupSet = useMemo(
    () => new Set(teamSelection?.groupNames || []),
    [teamSelection]
  )
  const filteredTeamGroups = useMemo(() => {
    const normalizedQuery = teamSearchQuery.trim().toLowerCase()

    if (!normalizedQuery) return teamGroups

    return teamGroups.filter(group =>
      `${getGroupDisplayName(group)} ${group.name}`.toLowerCase().includes(normalizedQuery)
    )
  }, [teamGroups, teamSearchQuery])
  const teamFilterLabel = useMemo(() => {
    if (!teamSelection || teamSelection.all) return t('sources.all_groups')
    if (teamSelection.groupNames.length === 1) {
      const selectedGroup = teamGroups.find(group => group.name === teamSelection.groupNames[0])
      return selectedGroup ? getGroupDisplayName(selectedGroup) : teamSelection.groupNames[0]
    }
    return t('sources.selected_groups', { count: teamSelection.groupNames.length })
  }, [teamGroups, teamSelection, t])

  return (
    <div
      className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
      data-testid="resource-library-manage-controls"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-4">
        <div
          className="flex min-w-0 items-center gap-4 overflow-x-auto"
          role="tablist"
          aria-label={t('fields.source')}
          data-testid="resource-library-source-tabs"
        >
          {tabs.map(item => {
            const isActive = item === tab

            return (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={isActive}
                className={`h-9 shrink-0 border-b-2 px-0 text-sm font-medium transition-colors ${
                  isActive
                    ? 'border-text-primary text-text-primary'
                    : 'border-transparent text-text-secondary hover:text-text-primary'
                }`}
                data-testid={`resource-library-${item}-tab`}
                onClick={() => onTabChange(item)}
              >
                {t(`tabs.${item}`)}
              </button>
            )
          })}
        </div>

        {showTeamFilter && (
          <>
            <span className="h-5 w-px shrink-0 bg-border" aria-hidden />
            <label className="flex items-center gap-2 text-sm font-medium text-text-secondary">
              <span>{t('tabs.team')}</span>
              <DropdownMenu
                modal={false}
                onOpenChange={open => {
                  if (open && teamGroupStatus === 'loading' && teamGroups.length === 0) {
                    onTeamGroupsRequest?.()
                  }
                  if (!open) setTeamSearchQuery('')
                }}
              >
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-10 w-[180px] justify-between gap-2 bg-base px-3 lg:h-9"
                    data-testid="resource-library-team-filter"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <Building2 className="h-4 w-4 shrink-0" aria-hidden />
                      <span className="truncate">{teamFilterLabel}</span>
                    </span>
                    <ChevronDown className="h-4 w-4 shrink-0 opacity-70" aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  className="flex max-h-[360px] w-64 flex-col overflow-hidden"
                  data-testid="resource-library-team-scope-menu"
                >
                  <div
                    className="border-b border-border p-1 pb-2"
                    onKeyDown={event => event.stopPropagation()}
                  >
                    <div className="relative">
                      <Search
                        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted"
                        aria-hidden
                      />
                      <Input
                        value={teamSearchQuery}
                        onChange={event => setTeamSearchQuery(event.target.value)}
                        placeholder={t('search.groups_placeholder')}
                        className="h-9 bg-base pl-9"
                        data-testid="resource-library-team-search"
                      />
                    </div>
                  </div>
                  <div className="min-h-0 overflow-y-auto pt-1">
                    {teamGroupStatus === 'loading' ? (
                      <div className="px-2 py-3 text-sm text-text-muted">{t('states.loading')}</div>
                    ) : teamGroupStatus === 'error' ? (
                      <div className="px-2 py-3 text-sm text-text-muted">{t('states.error')}</div>
                    ) : (
                      <>
                        <DropdownMenuCheckboxItem
                          checked={teamSelection?.all}
                          onSelect={event => {
                            event.preventDefault()
                            onTeamSelectionChange?.({ all: true, groupNames: [] })
                          }}
                          className="min-h-11 lg:min-h-9"
                          data-testid="resource-library-team-all"
                        >
                          {t('sources.all_groups')}
                        </DropdownMenuCheckboxItem>
                        {filteredTeamGroups.map(group => (
                          <DropdownMenuCheckboxItem
                            key={group.id}
                            checked={!teamSelection?.all && selectedTeamGroupSet.has(group.name)}
                            onSelect={event => {
                              event.preventDefault()
                              const currentGroups = teamSelection?.all
                                ? []
                                : teamSelection?.groupNames || []
                              const nextGroups = selectedTeamGroupSet.has(group.name)
                                ? currentGroups.filter(groupName => groupName !== group.name)
                                : [...currentGroups, group.name]
                              onTeamSelectionChange?.({
                                all: false,
                                groupNames: Array.from(new Set(nextGroups)),
                              })
                            }}
                            className="min-h-11 lg:min-h-9"
                            data-testid={`resource-library-team-${group.name}`}
                          >
                            <span className="truncate" title={getGroupDisplayName(group)}>
                              {getGroupDisplayName(group)}
                            </span>
                          </DropdownMenuCheckboxItem>
                        ))}
                        {filteredTeamGroups.length === 0 && (
                          <div className="px-2 py-3 text-sm text-text-muted">
                            {teamGroups.length === 0
                              ? t('states.no_groups')
                              : t('search.groups_empty')}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </DropdownMenuContent>
              </DropdownMenu>
            </label>
          </>
        )}
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-3 sm:justify-end">
        {showModeFilter && (
          <label className="flex items-center gap-2 text-sm font-medium text-text-secondary">
            <span>{t('fields.mode')}</span>
            <Select value={mode} onValueChange={value => onModeChange(value as TeamModeFilter)}>
              <SelectTrigger
                className="h-10 w-[118px] bg-base lg:h-9"
                aria-label={t('fields.mode')}
                data-testid="resource-library-mode-select"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {modeOptions.map(item => (
                  <SelectItem key={item} value={item} data-testid={`resource-library-mode-${item}`}>
                    {t(`modes.${item}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        )}

        {showModelCategoryFilter && (
          <label className="flex items-center gap-2 text-sm font-medium text-text-secondary">
            <span>{tCommon('models.filter_by_category_type')}</span>
            <Select
              value={modelCategory}
              onValueChange={value =>
                onModelCategoryChange(value as ResourceLibraryModelCategoryFilter)
              }
            >
              <SelectTrigger
                className="h-10 w-[160px] bg-base lg:h-9"
                aria-label={tCommon('models.filter_by_category_type')}
                data-testid="resource-library-model-category-select"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {modelCategoryOptions.map(item => (
                  <SelectItem
                    key={item}
                    value={item}
                    data-testid={`resource-library-model-category-${item}`}
                  >
                    {item === 'all'
                      ? tCommon('models.all_category_types')
                      : tCommon(`models.model_category_type_${item}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        )}

        {showSort && (
          <label className="flex items-center gap-2 text-sm font-medium text-text-secondary">
            <span>{t('fields.sort')}</span>
            <Select
              value={sort}
              onValueChange={value => onSortChange(value as ResourceLibrarySortMode)}
            >
              <SelectTrigger
                className="h-10 w-[118px] bg-base lg:h-9"
                aria-label={t('fields.sort')}
                data-testid="resource-library-manage-sort"
              >
                <ArrowUpDown className="h-4 w-4" aria-hidden />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">{t('sort.default')}</SelectItem>
                <SelectItem value="latest">{t('sort.latest')}</SelectItem>
              </SelectContent>
            </Select>
          </label>
        )}
      </div>
    </div>
  )
}
