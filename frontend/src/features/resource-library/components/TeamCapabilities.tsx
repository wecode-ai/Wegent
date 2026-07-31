// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Building2, ChevronDown, Plus, RefreshCw, Search } from 'lucide-react'

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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslation } from '@/hooks/useTranslation'
import { canEditContent } from '@/types/base-role'
import type { Group } from '@/types/group'
import type {
  ManagedResourceType,
  ResourceLibraryModelCategoryFilter,
  ResourceLibraryTypeFilter,
} from '../types'
import {
  type TeamGroupSelection,
  type TeamGroupStatus,
  useTeamCapabilityGroups,
} from '../useTeamCapabilityGroups'
import type { ResourceCreateRequest } from './ResourceCreateButton'
import { DiscoverResources } from './DiscoverResources'
import { GroupInstalledSkills } from './GroupInstalledSkills'
import { MyResources } from './MyResources'
import type { TeamModeFilter } from '@/features/tasks/components/selector/team-selector-utils'

interface TeamCapabilitiesProps {
  resourceType: ResourceLibraryTypeFilter
  createRequest?: ResourceCreateRequest & { type: 'agent' | 'skill' }
  teamModeFilter?: TeamModeFilter
  onTeamModeFilterChange?: (mode: TeamModeFilter) => void
  modelCategoryFilter?: ResourceLibraryModelCategoryFilter
  hideGlobalControls?: boolean
  groups?: Group[]
  groupStatus?: TeamGroupStatus
  teamSelection?: TeamGroupSelection
  onTeamSelectionChange?: (selection: TeamGroupSelection) => void
  onReloadGroups?: () => void
}

function getGroupDisplayName(group: Group): string {
  return group.display_name || group.name
}

function TeamGroupMultiSelect({
  groups,
  selection,
  onChange,
}: {
  groups: Group[]
  selection: TeamGroupSelection
  onChange: (selection: TeamGroupSelection) => void
}) {
  const { t } = useTranslation('resource-library')
  const [searchQuery, setSearchQuery] = useState('')
  const [isOpen, setIsOpen] = useState(false)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isPointerInsideRef = useRef(false)
  const selectedGroupSet = useMemo(() => new Set(selection.groupNames), [selection.groupNames])
  const normalizedQuery = searchQuery.trim().toLowerCase()
  const filteredGroups = useMemo(
    () =>
      normalizedQuery
        ? groups.filter(group =>
            `${getGroupDisplayName(group)} ${group.name}`.toLowerCase().includes(normalizedQuery)
          )
        : groups,
    [groups, normalizedQuery]
  )

  const buttonLabel = useMemo(() => {
    if (selection.all) return t('sources.all_groups')
    if (selection.groupNames.length === 0) return t('states.select_groups')
    if (selection.groupNames.length === 1) {
      const selectedGroup = groups.find(group => group.name === selection.groupNames[0])
      return selectedGroup ? getGroupDisplayName(selectedGroup) : selection.groupNames[0]
    }
    return t('sources.selected_groups', { count: selection.groupNames.length })
  }, [groups, selection, t])

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [])

  const scheduleClose = useCallback(() => {
    cancelClose()
    closeTimerRef.current = setTimeout(() => {
      setIsOpen(false)
      closeTimerRef.current = null
    }, 150)
  }, [cancelClose])

  const handlePointerEnter = useCallback(() => {
    isPointerInsideRef.current = true
    cancelClose()
    setIsOpen(true)
  }, [cancelClose])

  const handlePointerLeave = useCallback(() => {
    isPointerInsideRef.current = false
    scheduleClose()
  }, [scheduleClose])

  useEffect(() => cancelClose, [cancelClose])

  return (
    <DropdownMenu
      modal={false}
      open={isOpen}
      onOpenChange={open => {
        if (!open && isPointerInsideRef.current) return
        setIsOpen(open)
        if (!open) setSearchQuery('')
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className="h-11 w-full justify-between sm:w-[280px] lg:h-9"
          data-testid="team-capability-group-filter"
          onMouseEnter={handlePointerEnter}
          onMouseLeave={handlePointerLeave}
        >
          <span className="flex min-w-0 items-center gap-2">
            <Building2 className="h-4 w-4 flex-shrink-0" aria-hidden />
            <span className="truncate">{buttonLabel}</span>
          </span>
          <ChevronDown className="h-4 w-4 flex-shrink-0 opacity-70" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={6}
        className="flex max-h-[360px] min-w-[260px] max-w-[min(360px,calc(100vw-2rem))] flex-col overflow-hidden"
        onMouseEnter={handlePointerEnter}
        onMouseLeave={handlePointerLeave}
        onEscapeKeyDown={() => {
          isPointerInsideRef.current = false
          cancelClose()
          setIsOpen(false)
        }}
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
              value={searchQuery}
              onChange={event => setSearchQuery(event.target.value)}
              placeholder={t('search.groups_placeholder')}
              className="h-9 bg-base pl-9"
              data-testid="team-capability-group-search"
            />
          </div>
        </div>
        <div className="min-h-0 overflow-y-auto pt-1">
          <DropdownMenuCheckboxItem
            checked={selection.all}
            onCheckedChange={checked => onChange({ all: Boolean(checked), groupNames: [] })}
            onSelect={event => event.preventDefault()}
            className="min-h-11 lg:min-h-9"
            data-testid="team-capability-group-all"
          >
            {t('sources.all_groups')}
          </DropdownMenuCheckboxItem>
          {filteredGroups.map(group => (
            <DropdownMenuCheckboxItem
              key={group.id}
              checked={!selection.all && selectedGroupSet.has(group.name)}
              onCheckedChange={checked => {
                const currentGroups = selection.all ? [] : selection.groupNames
                const nextGroups = checked
                  ? [...currentGroups, group.name]
                  : currentGroups.filter(groupName => groupName !== group.name)
                onChange({ all: false, groupNames: Array.from(new Set(nextGroups)) })
              }}
              onSelect={event => event.preventDefault()}
              className="min-h-11 lg:min-h-9"
              data-testid={`team-capability-group-${group.name}`}
            >
              <span className="truncate" title={getGroupDisplayName(group)}>
                {getGroupDisplayName(group)}
              </span>
            </DropdownMenuCheckboxItem>
          ))}
          {filteredGroups.length === 0 && (
            <div className="px-2 py-3 text-sm text-text-muted">{t('search.groups_empty')}</div>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function TeamCapabilities({
  resourceType,
  createRequest,
  teamModeFilter,
  onTeamModeFilterChange,
  modelCategoryFilter,
  hideGlobalControls = false,
  groups: controlledGroups,
  groupStatus: controlledGroupStatus,
  teamSelection: controlledTeamSelection,
  onTeamSelectionChange,
  onReloadGroups,
}: TeamCapabilitiesProps) {
  const { t } = useTranslation('resource-library')
  const internalGroupState = useTeamCapabilityGroups({
    enabled: controlledGroups === undefined,
    initialGroupName: createRequest?.target.groupName,
  })
  const groups = controlledGroups ?? internalGroupState.groups
  const groupStatus = controlledGroupStatus ?? internalGroupState.status
  const teamSelection = controlledTeamSelection ?? internalGroupState.selection
  const setTeamSelection = onTeamSelectionChange ?? internalGroupState.setSelection
  const reloadGroups = onReloadGroups ?? internalGroupState.reload
  const [addTargetGroup, setAddTargetGroup] = useState<string | null>(
    createRequest?.target.groupName || null
  )
  const [mode, setMode] = useState<'current' | 'add'>('current')

  useEffect(() => {
    if (createRequest?.target.groupName) {
      setTeamSelection({ all: false, groupNames: [createRequest.target.groupName] })
      setAddTargetGroup(createRequest.target.groupName)
      setMode('current')
    }
  }, [createRequest, setTeamSelection])

  const writableGroups = useMemo(
    () => groups.filter(group => canEditContent(group.my_role)),
    [groups]
  )
  const addTarget = useMemo(
    () => writableGroups.find(group => group.name === addTargetGroup) || null,
    [addTargetGroup, writableGroups]
  )
  const canAdd = writableGroups.length > 0
  const canAddMarketplaceCapability = resourceType !== 'all'
  const effectiveGroupNames = teamSelection.all
    ? groups.map(group => group.name)
    : teamSelection.groupNames

  useEffect(() => {
    setAddTargetGroup(current => {
      const currentGroup = groups.find(group => group.name === current)
      if (currentGroup && canEditContent(currentGroup.my_role)) return currentGroup.name
      return groups.find(group => canEditContent(group.my_role))?.name || null
    })
  }, [groups])

  useEffect(() => {
    if (!canAddMarketplaceCapability) {
      setMode('current')
    }
  }, [canAddMarketplaceCapability])

  const handleModeChange = (nextMode: string) => {
    if (nextMode !== 'current' && nextMode !== 'add') return
    if (nextMode === 'add') {
      if (!canAdd) return
      const selectedWritableGroup = writableGroups.find(group =>
        effectiveGroupNames.includes(group.name)
      )
      setAddTargetGroup(selectedWritableGroup?.name || writableGroups[0]?.name || null)
    }
    setMode(nextMode)
  }

  const currentTeamScopeControl = (
    <div
      className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-center sm:gap-3"
      data-testid="team-capability-scope-control"
    >
      <span className="text-xs font-medium text-text-muted">{t('fields.team_scope')}</span>
      <TeamGroupMultiSelect groups={groups} selection={teamSelection} onChange={setTeamSelection} />
    </div>
  )

  const addTargetControl = (
    <div
      className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-center sm:gap-3"
      data-testid="team-capability-add-target-control"
    >
      <span className="text-xs font-medium text-text-muted">{t('fields.team_scope')}</span>
      {writableGroups.length === 1 ? (
        <div className="flex h-11 items-center gap-2 rounded-lg border border-border bg-base px-3 text-sm font-medium text-text-primary lg:h-10">
          <Building2 className="h-4 w-4" aria-hidden />
          {getGroupDisplayName(writableGroups[0])}
        </div>
      ) : (
        <Select value={addTarget?.name || ''} onValueChange={setAddTargetGroup}>
          <SelectTrigger
            className="h-11 w-full gap-2 rounded-lg bg-base text-left font-medium shadow-sm sm:w-[280px] lg:h-10"
            aria-label={t('fields.team_scope')}
            data-testid="team-capability-add-target"
          >
            <span className="flex min-w-0 items-center gap-2">
              <Building2 className="h-4 w-4 flex-shrink-0 text-text-secondary" aria-hidden />
              <SelectValue />
            </span>
          </SelectTrigger>
          <SelectContent align="start">
            {writableGroups.map(group => (
              <SelectItem
                key={group.id}
                value={group.name}
                data-testid={`team-capability-add-target-${group.name}`}
              >
                {getGroupDisplayName(group)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  )

  if (groupStatus === 'loading') {
    return (
      <div
        className="flex min-h-64 items-center justify-center rounded-lg border border-border text-sm text-text-muted"
        data-testid="team-capabilities-loading"
      >
        {t('states.loading')}
      </div>
    )
  }

  if (groupStatus === 'error') {
    return (
      <div
        className="flex min-h-64 flex-col items-center justify-center gap-3 rounded-lg border border-border text-sm text-text-muted"
        data-testid="team-capabilities-error"
      >
        <span>{t('states.error')}</span>
        <Button type="button" variant="outline" onClick={() => void reloadGroups()}>
          <RefreshCw className="h-4 w-4" aria-hidden />
          {t('actions.retry')}
        </Button>
      </div>
    )
  }

  if (groups.length === 0) {
    return (
      <div
        className="flex min-h-64 items-center justify-center rounded-lg border border-border text-sm text-text-muted"
        data-testid="team-capabilities-empty"
      >
        {t('states.no_groups')}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3" data-testid="team-capabilities">
      {(!hideGlobalControls || canAddMarketplaceCapability) && (
        <div
          className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
          data-testid="team-capability-toolbar"
        >
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <div
              className="flex min-h-9 items-center justify-between gap-3"
              data-testid="team-capability-mode-switch"
            >
              {mode === 'current' ? (
                <h2
                  className="text-base font-semibold text-text-primary"
                  data-state="active"
                  data-testid="team-capability-current-button"
                >
                  {t('actions.view_capabilities')}
                </h2>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  className="h-9 gap-2 px-2 text-text-secondary"
                  data-state="inactive"
                  data-testid="team-capability-current-button"
                  onClick={() => handleModeChange('current')}
                >
                  <ArrowLeft className="h-4 w-4" aria-hidden />
                  {t('actions.view_capabilities')}
                </Button>
              )}
              {canAddMarketplaceCapability && mode === 'current' && (
                <TooltipProvider delayDuration={0}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex" tabIndex={canAdd ? undefined : 0}>
                        <Button
                          type="button"
                          variant="ghost"
                          className="h-9 gap-1.5 px-2 text-text-secondary"
                          disabled={!canAdd}
                          data-state="inactive"
                          data-testid="team-capability-add-button"
                          onClick={() => handleModeChange('add')}
                        >
                          <Plus className="h-4 w-4" aria-hidden />
                          {t('actions.add_capability')}
                        </Button>
                      </span>
                    </TooltipTrigger>
                    {!canAdd && (
                      <TooltipContent side="bottom">
                        {t('messages.group_manage_required')}
                      </TooltipContent>
                    )}
                  </Tooltip>
                </TooltipProvider>
              )}
              {canAddMarketplaceCapability && mode === 'add' && (
                <h2
                  className="text-base font-semibold text-text-primary"
                  data-state="active"
                  data-testid="team-capability-add-button"
                >
                  {t('actions.add_capability')}
                </h2>
              )}
            </div>
            {mode === 'current' ? !hideGlobalControls && currentTeamScopeControl : addTargetControl}
          </div>
        </div>
      )}

      {mode === 'current' ? (
        !teamSelection.all && teamSelection.groupNames.length === 0 ? (
          <div
            className="flex min-h-48 items-center justify-center rounded-lg border border-border text-sm text-text-muted"
            data-testid="team-capabilities-no-selection"
          >
            {t('states.select_groups')}
          </div>
        ) : (
          <div className="space-y-5">
            {resourceType === 'skill' && (
              <GroupInstalledSkills groupNamespaces={effectiveGroupNames} groups={groups} />
            )}
            {resourceType !== 'skill' && (
              <MyResources
                key={`${resourceType}:team-current`}
                allowedTypes={[resourceType as ManagedResourceType]}
                fixedSource="group"
                fixedGroup={null}
                groupFilter={teamSelection.all ? undefined : teamSelection.groupNames}
                hideSourceControls
                hideTypeControls
                hideManagerCreateActions
                createRequest={createRequest}
                teamModeFilter={teamModeFilter}
                onTeamModeFilterChange={onTeamModeFilterChange}
                hideTeamModeFilter={hideGlobalControls}
                hideSortControls={hideGlobalControls}
                modelCategoryFilter={modelCategoryFilter}
                hideModelCategoryFilter={hideGlobalControls}
              />
            )}
          </div>
        )
      ) : (
        addTarget && (
          <DiscoverResources resourceType={resourceType} targetNamespace={addTarget.name} />
        )
      )}
    </div>
  )
}
