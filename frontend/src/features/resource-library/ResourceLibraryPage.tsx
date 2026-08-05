// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  ArrowLeft,
  Bot,
  BrainCircuit,
  ChevronDown,
  Database,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  SquareTerminal,
  X,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
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
import { cn } from '@/lib/utils'
import { canEditContent } from '@/types/base-role'
import type { Group } from '@/types/group'
import { DiscoverResources } from './components/DiscoverResources'
import { FeaturedScenarios } from './components/FeaturedScenarios'
import { InstalledResources } from './components/InstalledResources'
import { MyResources } from './components/MyResources'
import { PublishedResources } from './components/PublishedResources'
import type { ResourceCreateRequest } from './components/ResourceCreateButton'
import { ResourceTypeFilter } from './components/ResourceTypeFilter'
import type { ManagedResourceType } from './types'
import { getResourceSearchPlaceholderKey } from './resourceSearch'
import { useTeamCapabilityGroups } from './useTeamCapabilityGroups'
import {
  SkillListWithScope,
  type ResourceListState,
} from '@/features/settings/components/SkillListWithScope'

const discoverTypes: ManagedResourceType[] = ['agent', 'skill']
const mineTypes: ManagedResourceType[] = ['agent', 'skill', 'model', 'shell', 'retriever']
const coreCreateTypes: Array<{ type: ManagedResourceType; icon: typeof Bot }> = [
  { type: 'agent', icon: Bot },
  { type: 'skill', icon: Sparkles },
]
const advancedCreateTypes: Array<{ type: ManagedResourceType; icon: typeof Bot }> = [
  { type: 'model', icon: BrainCircuit },
  { type: 'shell', icon: SquareTerminal },
  { type: 'retriever', icon: Database },
]

type MineSource = 'all' | 'mine' | 'personal' | 'group' | 'system' | 'installed'

const mineSources: MineSource[] = ['all', 'mine', 'personal', 'group', 'system', 'installed']

function isMineSource(value: string | null): value is MineSource {
  return mineSources.includes(value as MineSource)
}

function getGroupDisplayName(group: { name: string; display_name?: string | null }) {
  return group.display_name || group.name
}

const initialResourceListState: ResourceListState = {
  loading: true,
  hasItems: false,
  hasError: false,
}

function TeamSkillResources({
  groupName,
  groups,
  keyword,
}: {
  groupName: string
  groups: Group[]
  keyword: string
}) {
  const { t } = useTranslation('resource-library')
  const { t: tCommon } = useTranslation('common')
  const [nativeState, setNativeState] = useState<ResourceListState>(initialResourceListState)
  const [installedState, setInstalledState] = useState<ResourceListState>(initialResourceListState)
  const hasItems = nativeState.hasItems || installedState.hasItems
  const isLoading = !hasItems && (nativeState.loading || installedState.loading)
  const isEmpty =
    !hasItems &&
    !nativeState.loading &&
    !installedState.loading &&
    !nativeState.hasError &&
    !installedState.hasError

  return (
    <div className="space-y-6" data-testid="team-skill-resources">
      <SkillListWithScope
        scope="group"
        selectedGroup={groupName}
        groups={groups}
        sourceFilter="group"
        showAutoEnabledSkills={false}
        hideCreateActions
        hideEmptyState
        hideLoadingState
        compact
        searchQuery={keyword}
        onListStateChange={setNativeState}
      />
      <InstalledResources
        resourceType="skill"
        keyword={keyword}
        groupNamespaces={[groupName]}
        excludeGroupOwned
        hideLoadingState
        hideEmptyState
        onListStateChange={setInstalledState}
      />
      {isLoading && (
        <div
          className="flex min-h-[260px] items-center justify-center text-text-secondary"
          data-testid="team-skill-resources-loading"
        >
          {tCommon('skills.loading')}
        </div>
      )}
      {isEmpty && (
        <div
          className="flex min-h-[260px] items-center justify-center rounded-lg border border-border bg-surface p-6 text-sm text-text-secondary"
          data-testid="team-skill-resources-empty"
        >
          {t('states.empty')}
        </div>
      )}
    </div>
  )
}

export function ResourceLibraryPage() {
  const { t } = useTranslation('resource-library')
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const tabParam = searchParams.get('tab')
  const typeParam = searchParams.get('type')
  const isLegacyTeamView = tabParam === 'team'
  const isPublishedView = tabParam === 'published'
  const isMineView = tabParam === 'mine' || isLegacyTeamView || isPublishedView
  const availableTypes = isMineView ? mineTypes : discoverTypes
  const resourceType = availableTypes.includes(typeParam as ManagedResourceType)
    ? (typeParam as ManagedResourceType)
    : 'agent'
  const sourceParam = searchParams.get('source')
  const legacyScopeParam = searchParams.get('scope')
  const legacySource =
    legacyScopeParam === 'personal' || legacyScopeParam === 'group' ? legacyScopeParam : null
  const requestedSource = isLegacyTeamView
    ? 'group'
    : sourceParam ||
      legacySource ||
      (isMineView
        ? resourceType === 'agent' || resourceType === 'skill'
          ? 'mine'
          : 'personal'
        : null)
  const source = isMineSource(requestedSource) ? requestedSource : 'all'
  const supportsInstalledSource = resourceType === 'agent' || resourceType === 'skill'
  const supportsCreatedByMeSource = resourceType === 'agent' || resourceType === 'skill'
  const supportsSystemSource =
    resourceType === 'model' || resourceType === 'shell' || resourceType === 'retriever'
  const isUnsupportedSource =
    (source === 'installed' && !supportsInstalledSource) ||
    (source === 'system' && !supportsSystemSource) ||
    (source === 'mine' && !supportsCreatedByMeSource)
  const fallbackSource: MineSource = supportsCreatedByMeSource ? 'mine' : 'personal'
  const effectiveSource = isUnsupportedSource ? fallbackSource : source
  const keywordParam = searchParams.get('keyword') || ''
  const selectedGroupName = searchParams.get('group')
  const teamGroupState = useTeamCapabilityGroups({
    enabled: isMineView && effectiveSource === 'group',
    initialGroupName: selectedGroupName || undefined,
  })
  const selectedGroup = teamGroupState.groups.find(group => group.name === selectedGroupName)
  const selectedGroupLabel = selectedGroup
    ? getGroupDisplayName(selectedGroup)
    : selectedGroupName || t('sources.all_groups')
  const canAddToSelectedTeam = Boolean(
    selectedGroupName && selectedGroup && canEditContent(selectedGroup.my_role)
  )
  const isTeamAddMode =
    isMineView &&
    supportsInstalledSource &&
    effectiveSource === 'group' &&
    canAddToSelectedTeam &&
    searchParams.get('teamAction') === 'add'
  const [searchInput, setSearchInput] = useState(keywordParam)
  const [managedRevision, setManagedRevision] = useState(0)
  const [publishedRevision, setPublishedRevision] = useState(0)
  const [isAdvancedCreateOpen, setIsAdvancedCreateOpen] = useState(false)
  const [createRequest, setCreateRequest] = useState<
    (ResourceCreateRequest & { type: ManagedResourceType }) | null
  >(null)
  const createRequestId = useRef(0)

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
    const updates: Record<string, string | null> = {}
    if (typeParam && typeParam !== resourceType) updates.type = resourceType
    if (isLegacyTeamView) {
      updates.tab = 'mine'
      updates.source = 'group'
    }
    if (legacySource) {
      if (!sourceParam) updates.source = legacySource
      updates.scope = null
    }
    if (isUnsupportedSource) updates.source = fallbackSource
    if (Object.keys(updates).length > 0) replaceParams(updates)
  }, [
    isLegacyTeamView,
    legacySource,
    replaceParams,
    resourceType,
    sourceParam,
    isUnsupportedSource,
    fallbackSource,
    typeParam,
  ])

  useEffect(() => {
    setSearchInput(keywordParam)
  }, [keywordParam])

  const handleNewCapabilityType = (type: ManagedResourceType) => {
    createRequestId.current += 1
    setCreateRequest({
      id: createRequestId.current,
      type,
      publishAfterCreate: false,
      marketplaceTags: [],
      target: { scope: 'personal' },
    })
  }

  const handleResourceCreated = () => {
    setCreateRequest(null)
    setManagedRevision(revision => revision + 1)
    setPublishedRevision(revision => revision + 1)
  }

  const handleCreateRequestClose = () => {
    setCreateRequest(null)
    setManagedRevision(revision => revision + 1)
  }

  const handleSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    replaceParams({ keyword: searchInput.trim() || null })
  }

  const handleViewToggle = () => {
    if (isMineView) {
      replaceParams({
        tab: null,
        type: discoverTypes.includes(resourceType) ? resourceType : 'agent',
        source: null,
        group: null,
        keyword: null,
        sort: null,
        mode: null,
        modelCategory: null,
        teamAction: null,
      })
      return
    }

    replaceParams({
      tab: 'mine',
      source: null,
      group: null,
      keyword: null,
      teamAction: null,
    })
  }

  const handleTypeChange = (nextType: ManagedResourceType) => {
    const nextSupportsInstalledSource = nextType === 'agent' || nextType === 'skill'
    const nextSupportsCreatedByMeSource = nextType === 'agent'
    const nextSupportsSystemSource =
      nextType === 'model' || nextType === 'shell' || nextType === 'retriever'
    const shouldResetSource =
      (effectiveSource === 'installed' && !nextSupportsInstalledSource) ||
      (effectiveSource === 'system' && !nextSupportsSystemSource) ||
      (effectiveSource === 'mine' && !nextSupportsCreatedByMeSource)

    replaceParams({
      type: nextType,
      source: shouldResetSource ? 'personal' : undefined,
      group: effectiveSource === 'group' ? undefined : null,
      keyword: null,
      sort: null,
      mode: null,
      modelCategory: null,
      teamAction: null,
    })
  }

  const handleSourceChange = (nextSource: MineSource) => {
    replaceParams({
      tab: 'mine',
      source: nextSource,
      group: nextSource === 'group' ? undefined : null,
      keyword: null,
      teamAction: null,
    })
  }

  const renderCreateItem = ({ type, icon: Icon }: (typeof coreCreateTypes)[number]) => (
    <DropdownMenuItem
      key={type}
      className="min-h-12 gap-3 px-3"
      onSelect={() => handleNewCapabilityType(type)}
      data-testid={`new-capability-type-${type}`}
    >
      <Icon className="h-5 w-5 text-primary" aria-hidden />
      <span className="flex flex-col">
        <span className="font-medium">{t(`filters.${type}`)}</span>
        <span className="text-xs text-text-muted">
          {t(`new_capability.type_descriptions.${type}`)}
        </span>
      </span>
    </DropdownMenuItem>
  )

  const renderContent = () => {
    if (!isMineView) {
      return (
        <>
          {resourceType === 'agent' && <FeaturedScenarios />}
          <DiscoverResources resourceType={resourceType} systemOnly hideSearch />
        </>
      )
    }
    if (isPublishedView) {
      return <PublishedResources key={publishedRevision} resourceType={resourceType} />
    }
    if (isTeamAddMode && selectedGroupName) {
      return (
        <DiscoverResources
          resourceType={resourceType}
          targetNamespace={selectedGroupName}
          hideSearch
        />
      )
    }
    if (effectiveSource === 'installed' && supportsInstalledSource) {
      return (
        <InstalledResources
          key={`installed:${resourceType}`}
          resourceType={resourceType}
          keyword={keywordParam}
        />
      )
    }
    if (effectiveSource === 'group' && supportsInstalledSource) {
      if (teamGroupState.status === 'error') {
        return (
          <div
            className="flex min-h-[260px] flex-col items-center justify-center gap-3 rounded-lg border border-border bg-surface p-6 text-center"
            data-testid="team-resources-error"
          >
            <p className="text-sm text-text-secondary">{t('states.error')}</p>
            <Button
              type="button"
              variant="outline"
              className="h-11 min-w-[44px]"
              onClick={() => void teamGroupState.reload()}
              data-testid="team-resources-retry-button"
            >
              <RefreshCw className="h-4 w-4" aria-hidden />
              {t('actions.retry')}
            </Button>
          </div>
        )
      }
      if (!selectedGroupName && teamGroupState.status === 'loading') {
        return (
          <div
            className="flex min-h-[260px] items-center justify-center rounded-lg border border-border bg-surface p-6 text-sm text-text-secondary"
            data-testid="team-resources-loading"
          >
            {t('states.loading')}
          </div>
        )
      }
      if (resourceType === 'agent') {
        return (
          <MyResources
            key={`${managedRevision}:agent:group:${selectedGroupName || 'all'}`}
            allowedTypes={['agent']}
            fixedSource="group"
            fixedGroup={selectedGroupName}
            hideSourceControls
            hideTypeControls
            hideManagerCreateActions
            hideSortControls
            hideTeamModeFilter
            searchQuery={keywordParam}
          />
        )
      }
      if (selectedGroupName) {
        return (
          <TeamSkillResources
            groupName={selectedGroupName}
            groups={teamGroupState.groups}
            keyword={keywordParam}
          />
        )
      }
      return (
        <InstalledResources
          resourceType="skill"
          keyword={keywordParam}
          groupNamespaces={
            selectedGroupName ? [selectedGroupName] : teamGroupState.groups.map(group => group.name)
          }
          groups={teamGroupState.groups}
        />
      )
    }

    const fixedSource = effectiveSource as Exclude<MineSource, 'installed'>
    return (
      <MyResources
        key={`${managedRevision}:${resourceType}:${effectiveSource}:${selectedGroupName || 'all'}`}
        allowedTypes={[resourceType]}
        fixedSource={fixedSource}
        fixedGroup={effectiveSource === 'group' ? selectedGroupName : undefined}
        hideSourceControls
        hideTypeControls
        hideManagerCreateActions
        hideSortControls
        hideTeamModeFilter
        hideModelCategoryFilter
        searchQuery={keywordParam}
      />
    )
  }

  const sourceOptions: MineSource[] = [
    'all',
    supportsCreatedByMeSource ? 'mine' : 'personal',
    'group',
    ...(supportsSystemSource ? (['system'] as const) : []),
    ...(supportsInstalledSource ? (['installed'] as const) : []),
  ]
  const pageTitle = isMineView ? t('mine.title') : t('title')
  const pageDescription = isMineView ? t('mine.description') : t('description')

  return (
    <main className="h-full overflow-y-auto bg-base text-text-primary">
      <div className="mx-auto flex w-full max-w-[1600px] flex-col px-4 pb-8 pt-5 sm:px-6 lg:px-8">
        <section className="flex flex-col gap-5" data-testid="resource-library-header">
          <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">{pageTitle}</h1>
              <p className="mt-1 text-sm text-text-secondary">{pageDescription}</p>
            </div>
            <div className="flex w-full min-w-0 gap-2 sm:w-auto">
              <Button
                type="button"
                variant="outline"
                className="h-11 flex-1 rounded-xl px-5 sm:flex-none lg:h-10"
                onClick={handleViewToggle}
                data-testid="resource-library-view-toggle"
              >
                {t(isMineView ? 'actions.back_to_library' : 'actions.my_capabilities')}
              </Button>
              <DropdownMenu
                onOpenChange={open => {
                  if (!open) setIsAdvancedCreateOpen(false)
                }}
              >
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="primary"
                    className="h-11 min-w-[44px] flex-1 rounded-xl px-5 sm:flex-none lg:h-10"
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
                  <DropdownMenuLabel className="text-xs text-text-muted">
                    {t('new_capability.common')}
                  </DropdownMenuLabel>
                  {coreCreateTypes.map(renderCreateItem)}
                  <DropdownMenuSeparator />
                  <Collapsible open={isAdvancedCreateOpen} onOpenChange={setIsAdvancedCreateOpen}>
                    <CollapsibleTrigger asChild>
                      <DropdownMenuItem
                        className="min-h-11 px-3"
                        onSelect={event => event.preventDefault()}
                        data-testid="new-capability-advanced"
                      >
                        <span className="flex flex-1 flex-col">
                          <span className="font-medium">{t('new_capability.advanced')}</span>
                          <span className="text-xs font-normal text-text-muted">
                            {t('new_capability.advanced_description')}
                          </span>
                        </span>
                        <ChevronDown
                          className={cn(
                            'h-4 w-4 text-text-muted transition-transform',
                            isAdvancedCreateOpen && 'rotate-180'
                          )}
                          aria-hidden
                        />
                      </DropdownMenuItem>
                    </CollapsibleTrigger>
                    <CollapsibleContent
                      className="mt-1 space-y-1 border-l border-border pl-2"
                      data-testid="new-capability-advanced-content"
                    >
                      {advancedCreateTypes.map(renderCreateItem)}
                    </CollapsibleContent>
                  </Collapsible>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </header>

          {!isPublishedView && (
            <div className="flex flex-col gap-3 border-b border-border">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <ResourceTypeFilter
                  value={resourceType}
                  onValueChange={value => handleTypeChange(value as ManagedResourceType)}
                  filters={availableTypes}
                  marketLabels={!isMineView}
                />
                {isMineView && (
                  <form
                    className="relative min-w-0 flex-1 pb-3 sm:w-[320px] sm:max-w-[360px] sm:pb-0"
                    onSubmit={handleSearch}
                    data-testid="resource-library-header-search"
                  >
                    <Search
                      className="pointer-events-none absolute left-3 top-[22px] h-4 w-4 -translate-y-1/2 text-text-muted sm:top-1/2"
                      aria-hidden
                    />
                    <Input
                      value={searchInput}
                      onChange={event => setSearchInput(event.target.value)}
                      placeholder={t(getResourceSearchPlaceholderKey(resourceType))}
                      className="h-11 rounded-xl border-border bg-surface pl-9 pr-12"
                      data-testid="resource-library-header-search-input"
                    />
                    {searchInput && (
                      <button
                        type="button"
                        className="absolute right-0 top-[22px] flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-lg text-text-muted hover:bg-muted hover:text-text-primary sm:top-1/2"
                        aria-label={t('actions.clear_search')}
                        onClick={() => {
                          setSearchInput('')
                          replaceParams({ keyword: null })
                        }}
                        data-testid="resource-library-header-search-clear"
                      >
                        <X className="h-4 w-4" aria-hidden />
                      </button>
                    )}
                    <button
                      type="submit"
                      className="sr-only"
                      data-testid="resource-library-header-search-button"
                    >
                      {t('actions.search')}
                    </button>
                  </form>
                )}
              </div>

              {isMineView && (
                <div
                  className="flex min-w-0 flex-col gap-2 pb-2 sm:flex-row sm:items-center"
                  data-testid="resource-library-source-controls"
                >
                  <Select
                    value={effectiveSource}
                    onValueChange={value => handleSourceChange(value as MineSource)}
                  >
                    <SelectTrigger
                      className="h-11 w-full bg-surface sm:hidden"
                      aria-label={t('fields.source')}
                      data-testid="resource-library-source-select"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {sourceOptions.map(item => (
                        <SelectItem
                          key={item}
                          value={item}
                          data-testid={`resource-library-source-${item}-option`}
                        >
                          {t(`sources.${item}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  <div
                    className="hidden h-11 items-center gap-1 rounded-xl border border-border bg-surface p-1 sm:flex"
                    role="group"
                    aria-label={t('fields.source')}
                    data-testid="resource-library-source-segments"
                  >
                    {sourceOptions.map(item => {
                      const isActive = effectiveSource === item
                      return (
                        <button
                          key={item}
                          type="button"
                          aria-pressed={isActive}
                          onClick={() => handleSourceChange(item)}
                          className={cn(
                            'h-9 shrink-0 rounded-lg px-3 text-sm font-medium transition-colors',
                            isActive
                              ? 'bg-primary/10 text-primary shadow-sm'
                              : 'text-text-secondary hover:bg-muted hover:text-text-primary'
                          )}
                          data-testid={`resource-library-source-${item}-button`}
                        >
                          {t(`sources.${item}`)}
                        </button>
                      )
                    })}
                  </div>

                  {effectiveSource === 'group' && (
                    <Select
                      value={selectedGroupName || 'all'}
                      onValueChange={value =>
                        replaceParams({
                          group: value === 'all' ? null : value,
                          keyword: null,
                          teamAction: null,
                        })
                      }
                    >
                      <SelectTrigger
                        className="h-11 w-full min-w-0 bg-surface sm:w-[180px] [&>svg]:shrink-0"
                        title={selectedGroupLabel}
                        aria-label={t('fields.team_scope')}
                        data-testid="resource-library-team-select"
                      >
                        <span className="min-w-0 flex-1 truncate text-left">
                          <SelectValue />
                        </span>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all" data-testid="resource-library-team-all-option">
                          {t('sources.all_groups')}
                        </SelectItem>
                        {teamGroupState.groups.map(group => (
                          <SelectItem
                            key={group.id}
                            value={group.name}
                            data-testid={`resource-library-team-${group.name}-option`}
                          >
                            {getGroupDisplayName(group)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {supportsInstalledSource &&
                    effectiveSource === 'group' &&
                    canAddToSelectedTeam && (
                      <Button
                        type="button"
                        variant="outline"
                        className="h-11 shrink-0 rounded-xl px-4"
                        onClick={() =>
                          replaceParams({
                            teamAction: isTeamAddMode ? null : 'add',
                            keyword: null,
                          })
                        }
                        data-testid={
                          isTeamAddMode
                            ? 'resource-library-team-current-button'
                            : 'resource-library-team-add-button'
                        }
                      >
                        {isTeamAddMode ? (
                          <ArrowLeft className="h-4 w-4" aria-hidden />
                        ) : (
                          <Plus className="h-4 w-4" aria-hidden />
                        )}
                        {t(isTeamAddMode ? 'actions.view_capabilities' : 'actions.add_capability')}
                      </Button>
                    )}
                </div>
              )}
            </div>
          )}
        </section>

        <section className="pt-3" data-testid="resource-library-content">
          {renderContent()}
        </section>
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
