// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { useRouter } from 'next/navigation'
import { Boxes, Check, ChevronDown, Settings2, Users } from 'lucide-react'

import { listGroups } from '@/apis/groups'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown'
import { paths } from '@/config/paths'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { Group } from '@/types/group'
import type { ManagedResourceType } from '../types'

type ResourceScope = 'personal' | 'group'

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

function getGroupDisplayName(group: Group): string {
  return group.display_name || group.name
}

function getInitialResourceType(): ManagedResourceType {
  const type = getInitialSearchParam('type')
  return managedResourceTypes.includes(type as ManagedResourceType)
    ? (type as ManagedResourceType)
    : 'agent'
}

function getInitialScope(): ResourceScope {
  return getInitialSearchParam('scope') === 'group' ? 'group' : 'personal'
}

function ManagedResourceTabs({
  value,
  onValueChange,
}: {
  value: ManagedResourceType
  onValueChange: (value: ManagedResourceType) => void
}) {
  const { t } = useTranslation('resource-library')

  return (
    <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label={t('fields.type')}>
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

function ResourceScopeControls({
  scope,
  groups,
  selectedGroup,
  onScopeChange,
  onGroupChange,
}: {
  scope: ResourceScope
  groups: Group[]
  selectedGroup: string | null
  onScopeChange: (scope: ResourceScope) => void
  onGroupChange: (groupName: string | null) => void
}) {
  const { t } = useTranslation('resource-library')
  const router = useRouter()
  const selectedGroupInfo = groups.find(group => group.name === selectedGroup)
  const selectedGroupLabel =
    scope === 'group'
      ? selectedGroupInfo
        ? getGroupDisplayName(selectedGroupInfo)
        : selectedGroup
      : null
  const groupButtonLabel = selectedGroupLabel || t('scopes.group')

  const handleGroupSelect = (groupName: string) => {
    onGroupChange(groupName)
    onScopeChange('group')
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant={scope === 'personal' ? 'primary' : 'outline'}
        aria-pressed={scope === 'personal'}
        className="h-11 min-w-[44px] px-4 lg:h-9"
        onClick={() => onScopeChange('personal')}
        data-testid="resource-scope-personal-button"
      >
        <Boxes className="h-4 w-4" aria-hidden="true" />
        {t('scopes.personal')}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant={scope === 'group' ? 'primary' : 'outline'}
            aria-pressed={scope === 'group'}
            className={cn(
              'h-11 min-w-[180px] max-w-full justify-between px-4 lg:h-9 lg:max-w-[260px]',
              scope === 'group' ? 'text-white' : 'text-text-primary'
            )}
            data-testid="resource-group-select"
          >
            <span className="flex min-w-0 items-center gap-2">
              <Users className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
              <span className="truncate" title={groupButtonLabel}>
                {groupButtonLabel}
              </span>
            </span>
            <ChevronDown className="h-4 w-4 flex-shrink-0 opacity-70" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          sideOffset={6}
          className="max-h-[320px] w-[var(--radix-dropdown-menu-trigger-width)] min-w-[220px] max-w-[min(320px,calc(100vw-2rem))] overflow-y-auto"
        >
          {groups.length === 0 ? (
            <DropdownMenuItem
              disabled
              className="min-h-11 text-text-muted lg:min-h-9"
              data-testid="resource-group-empty-option"
            >
              {t('states.no_groups')}
            </DropdownMenuItem>
          ) : (
            groups.map(group => {
              const isSelected = scope === 'group' && selectedGroup === group.name
              const displayName = getGroupDisplayName(group)

              return (
                <DropdownMenuItem
                  key={group.id}
                  className={cn(
                    'min-h-11 gap-2 lg:min-h-9',
                    isSelected && 'bg-primary/10 text-primary focus:text-primary'
                  )}
                  data-testid={`resource-group-option-${group.id}`}
                  onClick={() => handleGroupSelect(group.name)}
                >
                  <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
                    {isSelected && <Check className="h-4 w-4" aria-hidden="true" />}
                  </span>
                  <span className="truncate" title={displayName}>
                    {displayName}
                  </span>
                </DropdownMenuItem>
              )
            })
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="min-h-11 gap-2 lg:min-h-9"
            data-testid="resource-group-manage-option"
            onClick={() => router.push(paths.settings.groupManager.getHref())}
          >
            <Settings2 className="h-4 w-4 flex-shrink-0 text-text-muted" aria-hidden="true" />
            <span className="truncate">{t('actions.manage_groups')}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export function MyResources() {
  const [resourceType, setResourceType] = useState<ManagedResourceType>(getInitialResourceType)
  const [scope, setScope] = useState<ResourceScope>(getInitialScope)
  const [groups, setGroups] = useState<Group[]>([])
  const [selectedGroup, setSelectedGroup] = useState<string | null>(() =>
    getInitialSearchParam('group')
  )

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

  useEffect(() => {
    if (scope === 'group' && !selectedGroup && groups.length > 0) {
      setSelectedGroup(groups[0].name)
    }
  }, [groups, scope, selectedGroup])

  const handleScopeChange = useCallback(
    (nextScope: ResourceScope) => {
      setScope(nextScope)
      if (nextScope === 'group' && !selectedGroup && groups.length > 0) {
        setSelectedGroup(groups[0].name)
      }
    },
    [groups, selectedGroup]
  )

  const renderManager = () => {
    const managerScope = scope
    const groupName = scope === 'group' ? selectedGroup : null

    if (resourceType === 'agent') {
      return <TeamListWithScope scope={managerScope} selectedGroup={groupName} />
    }
    if (resourceType === 'model') {
      return <ModelListWithScope scope={managerScope} selectedGroup={groupName} />
    }
    if (resourceType === 'shell') {
      return <ShellListWithScope scope={managerScope} selectedGroup={groupName} />
    }
    if (resourceType === 'skill') {
      return <SkillListWithScope scope={managerScope} selectedGroup={groupName} />
    }
    if (resourceType === 'retriever') {
      return <RetrieverListWithScope scope={managerScope} selectedGroup={groupName} />
    }

    return null
  }

  return (
    <div className="flex flex-col gap-5" data-testid="my-resources">
      <div className="flex flex-col gap-3 border-b border-border pb-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <ManagedResourceTabs value={resourceType} onValueChange={setResourceType} />
          <ResourceScopeControls
            scope={scope}
            groups={groups}
            selectedGroup={selectedGroup}
            onScopeChange={handleScopeChange}
            onGroupChange={setSelectedGroup}
          />
        </div>
      </div>

      <div>{renderManager()}</div>
    </div>
  )
}
