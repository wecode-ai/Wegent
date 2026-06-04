// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useMemo, useState, type ComponentType } from 'react'
import dynamic from 'next/dynamic'
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
import type { ManagedResourceSourceFilter, ManagedResourceType } from '../types'

const managedResourceTypes: ManagedResourceType[] = [
  'agent',
  'skill',
  'model',
  'shell',
  'retriever',
]

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

function getInitialSearchParam(name: string): string | null {
  if (typeof window === 'undefined') {
    return null
  }
  return new URLSearchParams(window.location.search).get(name)
}

function getInitialResourceType(): ManagedResourceType {
  const type = getInitialSearchParam('type')
  return managedResourceTypes.includes(type as ManagedResourceType)
    ? (type as ManagedResourceType)
    : 'agent'
}

function getInitialSourceFilter(): ManagedResourceSourceFilter {
  const source = getInitialSearchParam('source')
  if (source === 'all' || source === 'personal' || source === 'group' || source === 'system') {
    return source
  }

  const legacyScope = getInitialSearchParam('scope')
  if (legacyScope === 'personal' || legacyScope === 'group') {
    return legacyScope
  }

  return 'all'
}

function getInitialGroupName(): string | null {
  return getInitialSearchParam('group')
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
            className="h-11 min-w-[44px] px-4 lg:h-9"
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
  onGroupChange,
}: {
  value: ManagedResourceSourceFilter
  onValueChange: (value: ManagedResourceSourceFilter) => void
  groups: Group[]
  selectedGroup: string | null
  onGroupChange: (groupName: string | null) => void
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
                onClick={() => {
                  onGroupChange(null)
                  onValueChange('group')
                }}
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
                      onClick={() => {
                        onGroupChange(group.name)
                        onValueChange('group')
                      }}
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
  const [resourceType, setResourceType] = useState<ManagedResourceType>(getInitialResourceType)
  const [sourceFilter, setSourceFilter] =
    useState<ManagedResourceSourceFilter>(getInitialSourceFilter)
  const [groups, setGroups] = useState<Group[]>([])
  const [selectedGroup, setSelectedGroup] = useState<string | null>(getInitialGroupName)

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

  const renderManager = () => {
    const managerScope = sourceFilterToScope(sourceFilter)
    const sourceControls = (
      <ResourceSourceFilterControls
        value={sourceFilter}
        onValueChange={setSourceFilter}
        groups={groups}
        selectedGroup={selectedGroup}
        onGroupChange={setSelectedGroup}
      />
    )
    const groupName = sourceFilter === 'group' ? selectedGroup : null

    if (resourceType === 'agent') {
      return (
        <TeamListWithScope
          scope={managerScope}
          selectedGroup={groupName}
          sourceFilter={sourceFilter}
          sourceControls={sourceControls}
          groups={groups}
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
          groups={groups}
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
          groups={groups}
        />
      )
    }
    if (resourceType === 'skill') {
      return (
        <SkillListWithScope
          scope={managerScope}
          selectedGroup={groupName}
          sourceFilter={sourceFilter}
          sourceControls={sourceControls}
          groups={groups}
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
          groups={groups}
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
        <ManagedResourceTabs value={resourceType} onValueChange={setResourceType} />
      </div>

      <div>{renderManager()}</div>
    </div>
  )
}
