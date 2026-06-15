// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useMemo, useState, type ComponentType } from 'react'
import dynamic from 'next/dynamic'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Building2, Check, ChevronDown, Globe2, Layers3, Search, UserRound } from 'lucide-react'

import { listGroups } from '@/apis/groups'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown'
import { Input } from '@/components/ui/input'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { Group } from '@/types/group'
import { getResourceLibrarySortMode, type ResourceLibrarySortMode } from '../resourceSorting'
import type {
  ManagedResourceSourceFilter,
  ManagedResourceType,
  ResourceLibraryPublishSource,
} from '../types'
import { PublishResourceDialog } from './PublishResourceDialog'

const managedResourceTypes: ManagedResourceType[] = [
  'agent',
  'skill',
  'model',
  'shell',
  'retriever',
]

const sourceFilters: ManagedResourceSourceFilter[] = ['all', 'personal', 'group', 'system']

const resourceLibraryUrlParams = {
  type: 'type',
  source: 'source',
  legacyScope: 'scope',
  group: 'group',
  sort: 'sort',
} as const

const TeamListWithScope = dynamic(
  () =>
    import('@/features/settings/components/TeamListWithScope').then(
      module => module.TeamListWithScope
    ),
  { ssr: false }
)
const ModelListWithScope = dynamic(
  () =>
    import('@/features/settings/components/ModelListWithScope').then(
      module => module.ModelListWithScope
    ),
  { ssr: false }
)
const ShellListWithScope = dynamic(
  () =>
    import('@/features/settings/components/ShellListWithScope').then(
      module => module.ShellListWithScope
    ),
  { ssr: false }
)
const SkillListWithScope = dynamic(
  () =>
    import('@/features/settings/components/SkillListWithScope').then(
      module => module.SkillListWithScope
    ),
  { ssr: false }
)
const RetrieverListWithScope = dynamic(
  () =>
    import('@/features/settings/components/RetrieverListWithScope').then(
      module => module.RetrieverListWithScope
    ),
  { ssr: false }
)

type SearchParamReader = Pick<URLSearchParams, 'get'>

function getInitialSearchParams(): URLSearchParams {
  if (typeof window === 'undefined') {
    return new URLSearchParams()
  }

  return new URLSearchParams(window.location.search)
}

function isManagedResourceType(value: string | null): value is ManagedResourceType {
  return managedResourceTypes.includes(value as ManagedResourceType)
}

function isSourceFilter(value: string | null): value is ManagedResourceSourceFilter {
  return sourceFilters.includes(value as ManagedResourceSourceFilter)
}

function getResourceTypeFromSearchParams(params: SearchParamReader): ManagedResourceType {
  const type = params.get(resourceLibraryUrlParams.type)
  return isManagedResourceType(type) ? type : 'agent'
}

function getSourceFilterFromSearchParams(params: SearchParamReader): ManagedResourceSourceFilter {
  const source = params.get(resourceLibraryUrlParams.source)
  if (isSourceFilter(source)) {
    return source
  }

  const legacyScope = params.get(resourceLibraryUrlParams.legacyScope)
  if (legacyScope === 'personal' || legacyScope === 'group') {
    return legacyScope
  }

  return 'all'
}

function getGroupNameFromSearchParams(params: SearchParamReader): string | null {
  return params.get(resourceLibraryUrlParams.group)
}

function getSortModeFromSearchParams(params: SearchParamReader): ResourceLibrarySortMode {
  return getResourceLibrarySortMode(params.get(resourceLibraryUrlParams.sort))
}

function getInitialResourceType(): ManagedResourceType {
  return getResourceTypeFromSearchParams(getInitialSearchParams())
}

function getInitialSourceFilter(): ManagedResourceSourceFilter {
  return getSourceFilterFromSearchParams(getInitialSearchParams())
}

function getInitialGroupName(): string | null {
  return getGroupNameFromSearchParams(getInitialSearchParams())
}

function getInitialSortMode(): ResourceLibrarySortMode {
  return getSortModeFromSearchParams(getInitialSearchParams())
}

function getGroupDisplayName(group: Group): string {
  return group.display_name || group.name
}

const groupNameCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
})

function compareGroupsByDisplayName(left: Group, right: Group): number {
  const displayNameResult = groupNameCollator.compare(
    getGroupDisplayName(left),
    getGroupDisplayName(right)
  )

  if (displayNameResult !== 0) {
    return displayNameResult
  }

  return groupNameCollator.compare(left.name, right.name)
}

function getGroupSearchText(group: Group): string {
  return `${getGroupDisplayName(group)} ${group.name}`.toLowerCase()
}

function useResourceLibraryTranslation() {
  const { t: tBase } = useTranslation('resource-library')
  return (key: string, options?: Record<string, unknown>) =>
    tBase(`resource-library:${key}`, options)
}

function ManagedResourceTabs({
  value,
  onValueChange,
}: {
  value: ManagedResourceType
  onValueChange: (value: ManagedResourceType) => void
}) {
  const t = useResourceLibraryTranslation()

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      role="tablist"
      aria-label={t('fields.type')}
      data-testid="managed-resource-type-tabs"
    >
      {managedResourceTypes.map(type => {
        const isActive = value === type

        return (
          <Button
            key={type}
            type="button"
            variant={isActive ? 'primary' : 'outline'}
            aria-pressed={isActive}
            data-testid={`managed-resource-${type}-tab`}
            className="h-11 min-w-[44px] px-4 md:h-9"
            onClick={() => onValueChange(type)}
          >
            {t(`filters.${type}`)}
          </Button>
        )
      })}
    </div>
  )
}

function ResourceSourceFilterControls({
  value,
  onValueChange,
  groups,
  selectedGroup,
  onGroupSourceChange,
}: {
  value: ManagedResourceSourceFilter
  onValueChange: (value: ManagedResourceSourceFilter) => void
  groups: Group[]
  selectedGroup: string | null
  onGroupSourceChange: (groupName: string | null) => void
}) {
  const t = useResourceLibraryTranslation()
  const [isGroupMenuOpen, setIsGroupMenuOpen] = useState(false)
  const [groupSearchQuery, setGroupSearchQuery] = useState('')
  const regularOptions: Array<{
    value: ManagedResourceSourceFilter
    label: string
    icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>
  }> = [
    { value: 'all', label: t('sources.all'), icon: Layers3 },
    { value: 'personal', label: t('sources.personal'), icon: UserRound },
  ]
  const selectedGroupInfo = groups.find(group => group.name === selectedGroup)
  const selectedGroupLabel = selectedGroupInfo ? getGroupDisplayName(selectedGroupInfo) : null
  const groupButtonLabel =
    value === 'group' ? selectedGroupLabel || t('sources.all_groups') : t('sources.group')
  const sortedGroups = useMemo(() => [...groups].sort(compareGroupsByDisplayName), [groups])
  const normalizedGroupSearchQuery = groupSearchQuery.trim().toLowerCase()
  const filteredGroups = useMemo(() => {
    if (!normalizedGroupSearchQuery) {
      return sortedGroups
    }

    return sortedGroups.filter(group =>
      getGroupSearchText(group).includes(normalizedGroupSearchQuery)
    )
  }, [normalizedGroupSearchQuery, sortedGroups])

  return (
    <div
      className="flex flex-col gap-2 sm:flex-row sm:items-center"
      data-testid="managed-resource-source-filter"
    >
      <span className="text-xs font-medium text-text-muted">{t('fields.source')}</span>
      <div className="flex flex-wrap items-center gap-2">
        {regularOptions.map(option => {
          const Icon = option.icon
          const isActive = value === option.value

          return (
            <Button
              key={option.value}
              type="button"
              variant={isActive ? 'primary' : 'outline'}
              aria-pressed={isActive}
              className="h-11 min-w-[44px] px-4 lg:h-9"
              onClick={() => onValueChange(option.value)}
              data-testid={`resource-source-${option.value}-button`}
            >
              <Icon className="h-4 w-4" aria-hidden />
              {option.label}
            </Button>
          )
        })}
        <DropdownMenu
          open={isGroupMenuOpen}
          onOpenChange={open => {
            setIsGroupMenuOpen(open)
            if (!open) {
              setGroupSearchQuery('')
            }
          }}
        >
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant={value === 'group' ? 'primary' : 'outline'}
              aria-pressed={value === 'group'}
              className={cn(
                'h-11 min-w-[44px] max-w-full justify-between px-4 lg:h-9 lg:max-w-[260px]',
                value === 'group' ? 'text-white' : 'text-text-primary'
              )}
              data-testid="resource-source-group-button"
            >
              <span className="flex min-w-0 items-center gap-2">
                <Building2 className="h-4 w-4 flex-shrink-0" aria-hidden />
                <span className="truncate" title={groupButtonLabel}>
                  {groupButtonLabel}
                </span>
              </span>
              <ChevronDown className="h-4 w-4 flex-shrink-0 opacity-70" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            sideOffset={6}
            className="flex max-h-[320px] min-w-[220px] max-w-[min(320px,calc(100vw-2rem))] flex-col overflow-hidden"
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
                  value={groupSearchQuery}
                  onChange={event => setGroupSearchQuery(event.target.value)}
                  placeholder={t('search.groups_placeholder')}
                  data-testid="resource-source-group-search-input"
                  className="h-9 bg-base pl-9"
                />
              </div>
            </div>
            <div className="min-h-0 overflow-y-auto pt-1">
              <DropdownMenuItem
                className={cn(
                  'min-h-11 gap-2 lg:min-h-9',
                  value === 'group' &&
                    !selectedGroup &&
                    'bg-primary/10 text-primary focus:text-primary'
                )}
                data-testid="resource-source-all-groups-option"
                onClick={() => onGroupSourceChange(null)}
              >
                <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
                  {value === 'group' && !selectedGroup && <Check className="h-4 w-4" aria-hidden />}
                </span>
                <span className="truncate">{t('sources.all_groups')}</span>
              </DropdownMenuItem>
              {groups.length === 0 ? (
                <DropdownMenuItem
                  disabled
                  className="min-h-11 text-text-muted lg:min-h-9"
                  data-testid="resource-source-group-empty-option"
                >
                  {t('states.no_groups')}
                </DropdownMenuItem>
              ) : filteredGroups.length === 0 ? (
                <DropdownMenuItem
                  disabled
                  className="min-h-11 text-text-muted lg:min-h-9"
                  data-testid="resource-source-group-no-match-option"
                >
                  {t('search.groups_empty')}
                </DropdownMenuItem>
              ) : (
                filteredGroups.map(group => {
                  const isSelected = value === 'group' && selectedGroup === group.name
                  const displayName = getGroupDisplayName(group)

                  return (
                    <DropdownMenuItem
                      key={group.id}
                      className={cn(
                        'min-h-11 gap-2 lg:min-h-9',
                        isSelected && 'bg-primary/10 text-primary focus:text-primary'
                      )}
                      data-testid={`resource-source-group-option-${group.id}`}
                      onClick={() => onGroupSourceChange(group.name)}
                    >
                      <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
                        {isSelected && <Check className="h-4 w-4" aria-hidden />}
                      </span>
                      <span className="truncate" title={displayName}>
                        {displayName}
                      </span>
                    </DropdownMenuItem>
                  )
                })
              )}
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          type="button"
          variant={value === 'system' ? 'primary' : 'outline'}
          aria-pressed={value === 'system'}
          className="h-11 min-w-[44px] px-4 lg:h-9"
          onClick={() => onValueChange('system')}
          data-testid="resource-source-system-button"
        >
          <Globe2 className="h-4 w-4" aria-hidden />
          {t('sources.system')}
        </Button>
      </div>
    </div>
  )
}

function ResourceSortControls({
  value,
  onValueChange,
}: {
  value: ResourceLibrarySortMode
  onValueChange: (value: ResourceLibrarySortMode) => void
}) {
  const t = useResourceLibraryTranslation()
  const options: ResourceLibrarySortMode[] = ['default', 'latest']

  return (
    <div
      className="flex flex-col gap-2 sm:flex-row sm:items-center lg:flex-shrink-0 lg:justify-end"
      data-testid="managed-resource-sort-control"
    >
      <span className="text-xs font-medium text-text-muted">{t('fields.sort')}</span>
      <div className="flex flex-wrap items-center gap-2">
        {options.map(option => {
          const isActive = value === option

          return (
            <Button
              key={option}
              type="button"
              variant={isActive ? 'primary' : 'outline'}
              aria-pressed={isActive}
              className="h-11 min-w-[44px] px-4 lg:h-9"
              onClick={() => onValueChange(option)}
              data-testid={`resource-sort-${option}-button`}
            >
              {t(`sort.${option}`)}
            </Button>
          )
        })}
      </div>
    </div>
  )
}

function sourceFilterToScope(
  sourceFilter: ManagedResourceSourceFilter
): 'personal' | 'group' | 'all' {
  if (sourceFilter === 'personal' || sourceFilter === 'group') {
    return sourceFilter
  }

  return 'all'
}

interface MyResourcesProps {
  title?: string
}

export function MyResources({ title }: MyResourcesProps = {}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const searchParamsSnapshot = searchParams.toString()
  const [resourceType, setResourceType] = useState<ManagedResourceType>(getInitialResourceType)
  const [sourceFilter, setSourceFilter] =
    useState<ManagedResourceSourceFilter>(getInitialSourceFilter)
  const [groups, setGroups] = useState<Group[]>([])
  const [selectedGroup, setSelectedGroup] = useState<string | null>(getInitialGroupName)
  const [publishingSource, setPublishingSource] = useState<ResourceLibraryPublishSource | null>(
    null
  )
  const [sortMode, setSortMode] = useState<ResourceLibrarySortMode>(getInitialSortMode)

  const replaceResourceLibraryUrl = useCallback(
    ({
      type,
      source,
      group,
      sort,
    }: {
      type?: ManagedResourceType
      source?: ManagedResourceSourceFilter
      group?: string | null
      sort?: ResourceLibrarySortMode
    }) => {
      const params = new URLSearchParams(searchParamsSnapshot)

      if (type) {
        params.set(resourceLibraryUrlParams.type, type)
      }

      if (source) {
        params.set(resourceLibraryUrlParams.source, source)
        params.delete(resourceLibraryUrlParams.legacyScope)
      }

      if (group !== undefined) {
        if (group) {
          params.set(resourceLibraryUrlParams.group, group)
        } else {
          params.delete(resourceLibraryUrlParams.group)
        }
      }

      if (sort) {
        if (sort === 'latest') {
          params.set(resourceLibraryUrlParams.sort, sort)
        } else {
          params.delete(resourceLibraryUrlParams.sort)
        }
      }

      if (source && source !== 'group') {
        params.delete(resourceLibraryUrlParams.group)
      }

      const queryString = params.toString()
      const nextUrl = queryString ? `${pathname}?${queryString}` : pathname
      router.replace(nextUrl, { scroll: false })
    },
    [pathname, router, searchParamsSnapshot]
  )

  const handleResourceTypeChange = useCallback(
    (nextType: ManagedResourceType) => {
      setResourceType(nextType)
      replaceResourceLibraryUrl({ type: nextType })
    },
    [replaceResourceLibraryUrl]
  )

  const handleSourceFilterChange = useCallback(
    (nextSource: ManagedResourceSourceFilter) => {
      setSourceFilter(nextSource)
      replaceResourceLibraryUrl({
        source: nextSource,
        group: nextSource === 'group' ? selectedGroup : null,
      })
    },
    [replaceResourceLibraryUrl, selectedGroup]
  )

  const handleGroupSourceChange = useCallback(
    (groupName: string | null) => {
      setSelectedGroup(groupName)
      setSourceFilter('group')
      replaceResourceLibraryUrl({ source: 'group', group: groupName })
    },
    [replaceResourceLibraryUrl]
  )

  const handleSortModeChange = useCallback(
    (nextSortMode: ResourceLibrarySortMode) => {
      setSortMode(nextSortMode)
      replaceResourceLibraryUrl({ sort: nextSortMode })
    },
    [replaceResourceLibraryUrl]
  )

  useEffect(() => {
    const params = new URLSearchParams(searchParamsSnapshot)
    setResourceType(getResourceTypeFromSearchParams(params))
    setSourceFilter(getSourceFilterFromSearchParams(params))
    setSelectedGroup(getGroupNameFromSearchParams(params))
    setSortMode(getSortModeFromSearchParams(params))
  }, [searchParamsSnapshot])

  useEffect(() => {
    let isMounted = true

    listGroups({ page: 1, limit: 100 })
      .then(response => {
        if (!isMounted) return
        setGroups(response.items || [])
      })
      .catch(() => {
        if (!isMounted) return
        setGroups([])
      })

    return () => {
      isMounted = false
    }
  }, [])

  const handlePublishDialogOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setPublishingSource(null)
    }
  }

  const handlePublished = () => {
    setPublishingSource(null)
  }

  const renderManager = () => {
    const managerScope = sourceFilterToScope(sourceFilter)
    const sourceControls = (
      <ResourceSourceFilterControls
        value={sourceFilter}
        onValueChange={handleSourceFilterChange}
        groups={groups}
        selectedGroup={selectedGroup}
        onGroupSourceChange={handleGroupSourceChange}
      />
    )
    const sortControls = (
      <ResourceSortControls value={sortMode} onValueChange={handleSortModeChange} />
    )
    const groupName = sourceFilter === 'group' ? selectedGroup : null

    if (resourceType === 'agent') {
      return (
        <TeamListWithScope
          scope={managerScope}
          selectedGroup={groupName}
          onPublishResource={setPublishingSource}
          sourceFilter={sourceFilter}
          sourceControls={sourceControls}
          sortControls={sortControls}
          groups={groups}
          sortMode={sortMode}
        />
      )
    }
    if (resourceType === 'model') {
      return (
        <ModelListWithScope
          scope={managerScope}
          selectedGroup={groupName}
          sourceFilter={sourceFilter}
          sourceControls={sourceControls}
          sortControls={sortControls}
          groups={groups}
          sortMode={sortMode}
        />
      )
    }
    if (resourceType === 'shell') {
      return (
        <ShellListWithScope
          scope={managerScope}
          selectedGroup={groupName}
          sourceFilter={sourceFilter}
          sourceControls={sourceControls}
          sortControls={sortControls}
          groups={groups}
          sortMode={sortMode}
        />
      )
    }
    if (resourceType === 'skill') {
      return (
        <SkillListWithScope
          scope={managerScope}
          selectedGroup={groupName}
          onPublishResource={setPublishingSource}
          sourceFilter={sourceFilter}
          sourceControls={sourceControls}
          sortControls={sortControls}
          groups={groups}
          sortMode={sortMode}
        />
      )
    }
    if (resourceType === 'retriever') {
      return (
        <RetrieverListWithScope
          scope={managerScope}
          selectedGroup={groupName}
          sourceFilter={sourceFilter}
          sourceControls={sourceControls}
          sortControls={sortControls}
          groups={groups}
          sortMode={sortMode}
        />
      )
    }

    return null
  }

  return (
    <div className="flex flex-col gap-4" data-testid="my-resources">
      <div
        className="flex flex-col gap-3 border-b border-border pb-3 sm:flex-row sm:items-center sm:justify-between"
        data-testid="managed-resource-header"
      >
        {title && <h1 className="shrink-0 text-xl font-semibold text-text-primary">{title}</h1>}
        <ManagedResourceTabs value={resourceType} onValueChange={handleResourceTypeChange} />
      </div>

      <div>{renderManager()}</div>

      <PublishResourceDialog
        open={publishingSource !== null}
        resourceType={publishingSource?.resourceType ?? 'all'}
        sourceResource={publishingSource}
        onOpenChange={handlePublishDialogOpenChange}
        onPublished={handlePublished}
      />
    </div>
  )
}
