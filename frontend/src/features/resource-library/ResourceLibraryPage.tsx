// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Bot, BrainCircuit, Database, Plus, Search, Sparkles, SquareTerminal } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown'
import { Input } from '@/components/ui/input'
import { useTranslation } from '@/hooks/useTranslation'
import { DiscoverResources } from './components/DiscoverResources'
import { MyResources } from './components/MyResources'
import { ResourceTypeFilter } from './components/ResourceTypeFilter'
import { PublishedResources } from './components/PublishedResources'
import { TeamCapabilities } from './components/TeamCapabilities'
import { ResourceLibraryManageControls } from './components/ResourceLibraryManageControls'
import type { ResourceCreateRequest } from './components/ResourceCreateButton'
import type {
  ManagedResourceType,
  ResourceLibraryModelCategoryFilter,
  ResourceLibraryTab,
  ResourceLibraryTypeFilter,
} from './types'
import { getResourceLibrarySortMode, type ResourceLibrarySortMode } from './resourceSorting'
import { useTeamCapabilityGroups } from './useTeamCapabilityGroups'
import type { TeamModeFilter } from '@/features/tasks/components/selector/team-selector-utils'

const managedTypes: ManagedResourceType[] = ['agent', 'skill', 'model', 'shell', 'retriever']
const marketplaceTabs: ResourceLibraryTab[] = ['discover', 'mine', 'team', 'published']
const foundationTabs: ResourceLibraryTab[] = ['mine', 'team', 'system']
const teamModeFilters: TeamModeFilter[] = ['all', 'chat', 'code', 'task']
const modelCategoryFilters: ResourceLibraryModelCategoryFilter[] = [
  'all',
  'llm',
  'embedding',
  'rerank',
]

function getTabsForType(resourceType: ManagedResourceType): ResourceLibraryTab[] {
  return resourceType === 'agent' || resourceType === 'skill' ? marketplaceTabs : foundationTabs
}

const createMenuGroups: Array<{
  labelKey: string
  items: Array<{
    type: ManagedResourceType
    icon: typeof Bot
  }>
}> = [
  {
    labelKey: 'new_capability.core_resources',
    items: [
      { type: 'agent', icon: Bot },
      { type: 'skill', icon: Sparkles },
    ],
  },
  {
    labelKey: 'new_capability.foundation_resources',
    items: [
      { type: 'model', icon: BrainCircuit },
      { type: 'shell', icon: SquareTerminal },
      { type: 'retriever', icon: Database },
    ],
  },
]

export function ResourceLibraryPage() {
  const { t } = useTranslation('resource-library')
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const tabParam = searchParams.get('tab') as ResourceLibraryTab | null
  const typeParam = searchParams.get('type') as ResourceLibraryTypeFilter | null
  const resourceType =
    typeParam && managedTypes.includes(typeParam as ManagedResourceType)
      ? (typeParam as ManagedResourceType)
      : 'agent'
  const availableTabs = getTabsForType(resourceType)
  const tab = tabParam && availableTabs.includes(tabParam) ? tabParam : availableTabs[0]
  const modeParam = searchParams.get('mode') as TeamModeFilter | null
  const teamModeFilter =
    resourceType === 'agent' && modeParam && teamModeFilters.includes(modeParam)
      ? modeParam
      : ('all' as TeamModeFilter)
  const modelCategoryParam = searchParams.get(
    'modelCategory'
  ) as ResourceLibraryModelCategoryFilter | null
  const modelCategoryFilter =
    resourceType === 'model' &&
    modelCategoryParam &&
    modelCategoryFilters.includes(modelCategoryParam)
      ? modelCategoryParam
      : ('all' as ResourceLibraryModelCategoryFilter)
  const sortMode = getResourceLibrarySortMode(searchParams.get('sort'))
  const [publishedRevision, setPublishedRevision] = useState(0)
  const keywordParam = searchParams.get('keyword') || ''
  const [searchInput, setSearchInput] = useState(keywordParam)
  const [createRequest, setCreateRequest] = useState<
    (ResourceCreateRequest & { type: ManagedResourceType }) | null
  >(null)
  const createRequestId = useRef(0)
  const teamGroupState = useTeamCapabilityGroups({
    enabled: tab === 'team',
  })

  const replaceParams = useCallback(
    (updates: Record<string, string | null | undefined>) => {
      const params = new URLSearchParams(searchParams.toString())
      Object.entries(updates).forEach(([key, value]) => {
        if (value === null) {
          params.delete(key)
        } else if (value !== undefined) {
          params.set(key, value)
        }
      })
      const query = params.toString()
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
    },
    [pathname, router, searchParams]
  )

  useEffect(() => {
    const updates: Record<string, string> = {}
    if (typeParam && typeParam !== resourceType) {
      updates.type = resourceType
    }
    if (tabParam && tabParam !== tab) {
      updates.tab = tab
    }
    if (Object.keys(updates).length > 0) {
      replaceParams(updates)
    }
  }, [replaceParams, resourceType, tab, tabParam, typeParam])

  useEffect(() => {
    setSearchInput(keywordParam)
  }, [keywordParam])

  const handleNewCapabilityType = (type: ManagedResourceType) => {
    createRequestId.current += 1
    setCreateRequest({
      id: createRequestId.current,
      type,
      publishAfterCreate: false,
      target: { scope: 'personal' },
    })
  }

  const handleResourceCreated = () => {
    setCreateRequest(null)
    setPublishedRevision(revision => revision + 1)
  }

  const handleCreateRequestClose = () => {
    setCreateRequest(null)
  }

  const handleMarketplaceSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    replaceParams({ keyword: searchInput.trim() || null })
  }

  const showMarketplaceSearch =
    tab === 'discover' && (resourceType === 'agent' || resourceType === 'skill')

  const renderContent = () => {
    if (tab === 'discover') {
      return <DiscoverResources resourceType={resourceType} hideSearch />
    }
    if (tab === 'team') {
      return (
        <TeamCapabilities
          resourceType={resourceType}
          teamModeFilter={teamModeFilter}
          onTeamModeFilterChange={mode => replaceParams({ mode: mode === 'all' ? null : mode })}
          modelCategoryFilter={modelCategoryFilter}
          hideGlobalControls
          groups={teamGroupState.groups}
          groupStatus={teamGroupState.status}
          teamSelection={teamGroupState.selection}
          onTeamSelectionChange={teamGroupState.setSelection}
          onReloadGroups={teamGroupState.reload}
        />
      )
    }
    if (tab === 'published') {
      return <PublishedResources key={publishedRevision} resourceType={resourceType} />
    }
    if (tab === 'system') {
      return (
        <MyResources
          allowedTypes={[resourceType]}
          fixedSource="system"
          hideSourceControls
          hideTypeControls
          hideManagerCreateActions
          hideSortControls
          teamModeFilter={teamModeFilter}
          onTeamModeFilterChange={mode => replaceParams({ mode: mode === 'all' ? null : mode })}
          hideTeamModeFilter
          modelCategoryFilter={modelCategoryFilter}
          hideModelCategoryFilter
        />
      )
    }
    return (
      <MyResources
        allowedTypes={[resourceType]}
        fixedSource="personal"
        hideSourceControls
        hideTypeControls
        hideManagerCreateActions
        hideSortControls
        teamModeFilter={teamModeFilter}
        onTeamModeFilterChange={mode => replaceParams({ mode: mode === 'all' ? null : mode })}
        hideTeamModeFilter
        modelCategoryFilter={modelCategoryFilter}
        hideModelCategoryFilter
      />
    )
  }

  return (
    <main className="h-full overflow-y-auto bg-base text-text-primary">
      <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-5 px-4 pb-8 pt-4 sm:px-6 lg:px-8">
        <section className="flex flex-col gap-4" data-testid="resource-library-header">
          <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
              <p className="mt-1 text-sm text-text-secondary">{t('description')}</p>
            </div>
            <div className="flex w-full min-w-0 flex-col gap-2 sm:flex-row lg:w-auto">
              {showMarketplaceSearch && (
                <form
                  className="relative min-w-0 flex-1 sm:w-[320px] lg:w-[360px]"
                  onSubmit={handleMarketplaceSearch}
                  data-testid="resource-library-header-search"
                >
                  <Search
                    className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted"
                    aria-hidden
                  />
                  <Input
                    value={searchInput}
                    onChange={event => setSearchInput(event.target.value)}
                    placeholder={t('search.placeholder')}
                    className="h-11 rounded-xl border-border bg-surface pl-9 pr-3 lg:h-10"
                    data-testid="resource-library-header-search-input"
                  />
                  <button
                    type="submit"
                    className="sr-only"
                    data-testid="resource-library-header-search-button"
                  >
                    {t('actions.search')}
                  </button>
                </form>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="primary"
                    className="h-11 min-w-[44px] shrink-0 rounded-xl px-5 lg:h-10"
                    data-testid="new-capability-button"
                  >
                    <Plus className="h-4 w-4" aria-hidden />
                    {t('actions.new_capability')}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  className="w-72 p-2"
                  data-testid="new-capability-menu"
                >
                  {createMenuGroups.map((group, groupIndex) => (
                    <div key={group.labelKey}>
                      {groupIndex > 0 && <DropdownMenuSeparator />}
                      <DropdownMenuLabel className="text-xs text-text-muted">
                        {t(group.labelKey)}
                      </DropdownMenuLabel>
                      {group.items.map(item => {
                        const Icon = item.icon
                        return (
                          <DropdownMenuItem
                            key={item.type}
                            className="min-h-12 gap-3 px-3"
                            onSelect={() => handleNewCapabilityType(item.type)}
                            data-testid={`new-capability-type-${item.type}`}
                          >
                            <Icon className="h-5 w-5 text-primary" aria-hidden />
                            <span className="flex flex-col">
                              <span className="font-medium">{t(`filters.${item.type}`)}</span>
                              <span className="text-xs text-text-muted">
                                {t(`new_capability.type_descriptions.${item.type}`)}
                              </span>
                            </span>
                          </DropdownMenuItem>
                        )
                      })}
                    </div>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </header>

          <ResourceTypeFilter
            value={resourceType}
            onValueChange={value => {
              const nextType = value as ManagedResourceType
              const nextTabs = getTabsForType(nextType)
              const nextTab = nextTabs.includes(tab) ? tab : nextTabs[0]
              replaceParams({
                type: nextType,
                tab: nextTab,
                sort: nextTab === 'discover' ? null : undefined,
                keyword: nextTab === 'discover' ? undefined : null,
                marketSort: null,
                mode: nextType === 'agent' && nextTab !== 'discover' ? undefined : null,
                modelCategory: nextType === 'model' ? undefined : null,
              })
            }}
            filters={managedTypes}
          />

          <div
            className="flex flex-col gap-3 border-t border-border pt-3 sm:flex-row sm:items-center sm:justify-between"
            role="group"
            aria-label={t('fields.scope')}
            data-testid="resource-library-scope-navigation"
          >
            <ResourceLibraryManageControls
              resourceType={resourceType}
              tab={tab}
              tabs={availableTabs}
              mode={teamModeFilter}
              modelCategory={modelCategoryFilter}
              sort={sortMode}
              showSort={tab !== 'discover' && tab !== 'published'}
              teamGroups={teamGroupState.groups}
              teamGroupStatus={teamGroupState.status}
              teamSelection={teamGroupState.selection}
              onTabChange={nextTab =>
                replaceParams({
                  tab: nextTab,
                  sort: nextTab === 'discover' || nextTab === 'published' ? null : undefined,
                  keyword: nextTab === 'discover' ? undefined : null,
                  marketSort: null,
                  mode: nextTab === 'discover' || nextTab === 'published' ? null : undefined,
                })
              }
              onTeamSelectionChange={teamGroupState.setSelection}
              onTeamGroupsRequest={teamGroupState.reload}
              onModeChange={mode => replaceParams({ mode: mode === 'all' ? null : mode })}
              onModelCategoryChange={category =>
                replaceParams({
                  modelCategory: category === 'all' ? null : category,
                })
              }
              onSortChange={(sort: ResourceLibrarySortMode) =>
                replaceParams({ sort: sort === 'default' ? null : sort })
              }
            />
          </div>
        </section>

        <section data-testid="resource-library-content">{renderContent()}</section>
      </div>

      {createRequest && (
        <MyResources
          allowedTypes={[createRequest.type]}
          fixedSource="personal"
          hideSourceControls
          createRequest={createRequest}
          onResourceCreated={handleResourceCreated}
          onCreateRequestClose={handleCreateRequestClose}
          creationOnly
        />
      )}
    </main>
  )
}

export default ResourceLibraryPage
