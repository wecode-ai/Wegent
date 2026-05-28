// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Boxes, ChevronDown, Users } from 'lucide-react'

import { listGroups } from '@/apis/groups'
import { Button } from '@/components/ui/button'
import { ModelListWithScope } from '@/features/settings/components/ModelListWithScope'
import { RetrieverListWithScope } from '@/features/settings/components/RetrieverListWithScope'
import { ShellListWithScope } from '@/features/settings/components/ShellListWithScope'
import { SkillListWithScope } from '@/features/settings/components/SkillListWithScope'
import { TeamListWithScope } from '@/features/settings/components/TeamListWithScope'
import { paths } from '@/config/paths'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { Group } from '@/types/group'
import type { ManagedResourceType } from '../types'

type ResourceScope = 'personal' | 'group'

const MANAGE_GROUPS_VALUE = '__manage_groups__'

const managedResourceTypes: ManagedResourceType[] = [
  'agent',
  'skill',
  'model',
  'shell',
  'retriever',
]

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
  const groupSelectValue = scope === 'group' ? (selectedGroup ?? '') : ''

  const handleGroupSelectChange = (value: string) => {
    if (value === MANAGE_GROUPS_VALUE) {
      router.push(paths.settings.groupManager.getHref())
      return
    }
    if (!value) {
      return
    }
    onGroupChange(value)
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
      <div
        className={cn(
          'relative inline-flex h-11 min-w-[180px] items-center rounded-lg border text-sm font-medium ring-offset-base transition-colors focus-within:ring-2 focus-within:ring-primary focus-within:ring-offset-2 lg:h-9',
          scope === 'group'
            ? 'border-primary bg-primary text-white'
            : 'border-border bg-transparent text-text-primary hover:bg-surface'
        )}
      >
        <Users className="pointer-events-none absolute left-4 h-4 w-4" aria-hidden="true" />
        <select
          value={groupSelectValue}
          className="h-full w-full cursor-pointer appearance-none rounded-lg bg-transparent pl-10 pr-10 text-sm font-medium text-inherit outline-none"
          onChange={event => handleGroupSelectChange(event.target.value)}
          data-testid="resource-group-select"
          aria-label={t('scopes.group')}
        >
          <option value="" className="text-text-primary">
            {t('scopes.group')}
          </option>
          {groups.length === 0 ? (
            <option value="__no_groups__" disabled className="text-text-primary">
              {t('states.no_groups')}
            </option>
          ) : (
            groups.map(group => (
              <option key={group.id} value={group.name} className="text-text-primary">
                {group.display_name || group.name}
              </option>
            ))
          )}
          <option value={MANAGE_GROUPS_VALUE} className="text-text-primary">
            {t('actions.manage_groups')}
          </option>
        </select>
        <ChevronDown className="pointer-events-none absolute right-4 h-4 w-4 opacity-70" />
      </div>
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
