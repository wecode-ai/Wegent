// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useRef, useState, useMemo, useCallback } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import { User, Users, Settings, ChevronDown, Check } from 'lucide-react'
import { listGroups } from '@/apis/groups'
import type { Group } from '@/types/group'

export type SettingsTabId =
  | 'personal-models'
  | 'personal-shells'
  | 'personal-skills'
  | 'personal-team'
  | 'personal-retrievers'
  | 'group-manager'
  | 'group-models'
  | 'group-shells'
  | 'group-skills'
  | 'group-team'
  | 'group-retrievers'
  | 'general'
  | 'integrations'
  | 'api-keys'
  | 'pet'

// Scope type for resource tabs
type ResourceScope = 'personal' | 'group'

interface SettingsTabNavProps {
  activeTab: SettingsTabId
  onTabChange: (tab: SettingsTabId, groupName?: string | null) => void
  selectedGroup?: string | null
  onGroupChange?: (groupName: string | null) => void
  refreshTrigger?: number
}

interface TabItem {
  id: SettingsTabId
  label: string
  category?: 'resource' | 'other'
  scope?: ResourceScope
}

interface ResourceTabConfig {
  key: string
  personalId: SettingsTabId
  groupId: SettingsTabId
  label: string
}

export function SettingsTabNav({
  activeTab,
  onTabChange,
  selectedGroup,
  onGroupChange,
  refreshTrigger,
}: SettingsTabNavProps) {
  const { t } = useTranslation('settings')
  const isMobile = useIsMobile()
  const indicatorContainerRef = useRef<HTMLDivElement | null>(null)
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const [indicatorStyle, setIndicatorStyle] = useState({ width: 0, left: 0 })

  // Groups state
  const [groups, setGroups] = useState<Group[]>([])
  const [groupsLoading, setGroupsLoading] = useState(false)

  // Load groups on mount
  const loadGroups = useCallback(async () => {
    try {
      setGroupsLoading(true)
      const response = await listGroups({ page: 1, limit: 100 })
      setGroups(response.items || [])
    } catch (error) {
      console.error('Failed to load groups:', error)
    } finally {
      setGroupsLoading(false)
    }
  }, [])

  useEffect(() => {
    loadGroups()
  }, [loadGroups, refreshTrigger])

  // Resource tabs that have both personal and group versions
  // Team (智能体) is placed first as the default entry module
  const resourceTabs: ResourceTabConfig[] = useMemo(
    () => [
      {
        key: 'team',
        personalId: 'personal-team',
        groupId: 'group-team',
        label: t('navigation.team'),
      },
      {
        key: 'models',
        personalId: 'personal-models',
        groupId: 'group-models',
        label: t('navigation.models'),
      },
      {
        key: 'shells',
        personalId: 'personal-shells',
        groupId: 'group-shells',
        label: t('navigation.shells'),
      },
      {
        key: 'skills',
        personalId: 'personal-skills',
        groupId: 'group-skills',
        label: t('navigation.skills'),
      },
      {
        key: 'retrievers',
        personalId: 'personal-retrievers',
        groupId: 'group-retrievers',
        label: t('navigation.retrievers'),
      },
    ],
    [t]
  )

  // Other tabs (not resource-based) - order: general, integrations, api-keys, device-setup, pet
  // Note: group-manager is now accessed via the group dropdown menu
  const otherTabs: TabItem[] = useMemo(
    () => [
      { id: 'general', label: t('sections.general'), category: 'other' },
      { id: 'integrations', label: t('navigation.integrations'), category: 'other' },
      { id: 'api-keys', label: t('navigation.apiKeys'), category: 'other' },
      { id: 'pet', label: t('pet:title'), category: 'other' },
    ],
    [t]
  )

  // Handle navigation to group manager
  const handleGroupManagerClick = () => {
    onTabChange('group-manager')
  }

  // Handle group selection
  const handleGroupSelect = (groupName: string | null) => {
    // Update scope first
    setCurrentScope('group')
    // Then notify parent about group change
    onGroupChange?.(groupName)
    // Switch to group tab for current resource
    const currentKey = getCurrentResourceKey()
    if (currentKey) {
      const tab = resourceTabs.find(t => t.key === currentKey)
      if (tab) {
        // Pass groupName to onTabChange to ensure URL is updated with correct group
        onTabChange(tab.groupId, groupName)
      }
    } else {
      // If not on a resource tab, switch to the first resource tab of group scope
      const firstTab = resourceTabs[0]
      // Pass groupName to onTabChange to ensure URL is updated with correct group
      onTabChange(firstTab.groupId, groupName)
    }
  }
  // Determine current scope based on active tab
  const getCurrentScope = useCallback((): ResourceScope => {
    if (activeTab.startsWith('group-') && activeTab !== 'group-manager') {
      return 'group'
    }
    return 'personal'
  }, [activeTab])

  const [currentScope, setCurrentScope] = useState<ResourceScope>(getCurrentScope())

  // Update scope when active tab changes
  useEffect(() => {
    const newScope = getCurrentScope()
    if (newScope !== currentScope) {
      setCurrentScope(newScope)
    }
  }, [currentScope, getCurrentScope])

  // Get the current resource tab key
  const getCurrentResourceKey = (): string | null => {
    for (const tab of resourceTabs) {
      if (activeTab === tab.personalId || activeTab === tab.groupId) {
        return tab.key
      }
    }
    return null
  }

  // Handle scope change
  const handleScopeChange = (newScope: ResourceScope) => {
    setCurrentScope(newScope)

    // If switching to group scope and no group is selected, auto-select the first group
    if (newScope === 'group' && !selectedGroup && groups.length > 0) {
      onGroupChange?.(groups[0].name)
    }

    const currentKey = getCurrentResourceKey()
    if (currentKey) {
      const tab = resourceTabs.find(t => t.key === currentKey)
      if (tab) {
        onTabChange(newScope === 'personal' ? tab.personalId : tab.groupId)
      }
    } else {
      // If not on a resource tab, switch to the first resource tab of the new scope
      const firstTab = resourceTabs[0]
      onTabChange(newScope === 'personal' ? firstTab.personalId : firstTab.groupId)
    }
  }

  // Handle resource tab click
  const handleResourceTabClick = (tab: ResourceTabConfig) => {
    onTabChange(currentScope === 'personal' ? tab.personalId : tab.groupId)
  }

  // Check if a resource tab is active
  const isResourceTabActive = (tab: ResourceTabConfig): boolean => {
    return activeTab === tab.personalId || activeTab === tab.groupId
  }

  const selectedGroupLabel =
    selectedGroup &&
    (groups.find(group => group.name === selectedGroup)?.display_name || selectedGroup)

  const scopeDescription = (() => {
    if (activeTab === 'group-manager') {
      return t('navigation.groupManagerDescription')
    }

    if (currentScope === 'group') {
      return selectedGroupLabel
        ? t('navigation.groupResourcesDescriptionWithName', { groupName: selectedGroupLabel })
        : t('navigation.groupResourcesDescription')
    }

    return t('navigation.personalResourcesDescription')
  })()

  // Update the indicator position when the active tab changes
  useEffect(() => {
    const updateIndicator = () => {
      const container = indicatorContainerRef.current
      const current = itemRefs.current[activeTab]

      if (!container || !current) {
        setIndicatorStyle(prev =>
          prev.width === 0 && prev.left === 0 ? prev : { width: 0, left: 0 }
        )
        return
      }

      const containerRect = container.getBoundingClientRect()
      const currentRect = current.getBoundingClientRect()
      setIndicatorStyle({
        width: currentRect.width,
        left: currentRect.left - containerRect.left,
      })
    }

    updateIndicator()
    window.addEventListener('resize', updateIndicator)

    return () => {
      window.removeEventListener('resize', updateIndicator)
    }
  }, [activeTab])

  // Mobile: Dropdown select with groups
  if (isMobile) {
    return (
      <div className="px-4 py-2 border-t border-border bg-surface space-y-2">
        {/* Scope selector */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => handleScopeChange('personal')}
            data-testid="settings-scope-personal"
            aria-pressed={currentScope === 'personal' && activeTab !== 'group-manager'}
            className={`flex h-11 min-w-[44px] items-center gap-1.5 rounded-md px-4 text-sm font-medium transition-colors ${
              currentScope === 'personal' && activeTab !== 'group-manager'
                ? 'bg-primary text-white'
                : 'bg-muted text-text-secondary hover:text-text-primary'
            }`}
          >
            <User className="w-3.5 h-3.5" />
            {t('navigation.personalResources')}
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                data-testid="settings-scope-group"
                aria-pressed={currentScope === 'group' || activeTab === 'group-manager'}
                className={`flex h-11 min-w-[44px] items-center gap-1.5 rounded-md px-4 text-sm font-medium transition-colors ${
                  currentScope === 'group' || activeTab === 'group-manager'
                    ? 'bg-primary text-white'
                    : 'bg-muted text-text-secondary hover:text-text-primary'
                }`}
              >
                <Users className="w-3.5 h-3.5" />
                <span>{t('navigation.groupResources')}</span>
                {currentScope === 'group' && selectedGroup && (
                  <span className="max-w-[120px] truncate text-xs opacity-80">
                    {groups.find(g => g.name === selectedGroup)?.display_name || selectedGroup}
                  </span>
                )}
                <ChevronDown className="w-3.5 h-3.5 ml-1" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[160px]">
              {groupsLoading ? (
                <DropdownMenuItem disabled>{t('common:actions.loading')}</DropdownMenuItem>
              ) : groups.length === 0 ? (
                <DropdownMenuItem disabled>{t('groups:groupManager.noGroups')}</DropdownMenuItem>
              ) : (
                groups.map(group => (
                  <DropdownMenuItem
                    key={group.id}
                    onClick={() => handleGroupSelect(group.name)}
                    className="flex items-center justify-between"
                  >
                    <span className="truncate">{group.display_name || group.name}</span>
                    {selectedGroup === group.name && currentScope === 'group' && (
                      <Check className="w-4 h-4 ml-2 text-primary" />
                    )}
                  </DropdownMenuItem>
                ))
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleGroupManagerClick}>
                <Settings className="w-4 h-4 mr-2" />
                {t('navigation.groupManager')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Tab selector */}
        <Select value={activeTab} onValueChange={value => onTabChange(value as SettingsTabId)}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder={t('sections.general')} />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>
                {currentScope === 'personal'
                  ? t('navigation.personalResources')
                  : t('navigation.groupResources')}
              </SelectLabel>
              {resourceTabs.map(tab => (
                <SelectItem
                  key={tab.key}
                  value={currentScope === 'personal' ? tab.personalId : tab.groupId}
                >
                  {tab.label}
                </SelectItem>
              ))}
            </SelectGroup>
            <SelectGroup>
              <SelectLabel>{t('sections.general')}</SelectLabel>
              {otherTabs.map(tab => (
                <SelectItem key={tab.id} value={tab.id}>
                  {tab.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
    )
  }

  // Desktop: Two-level navigation with prominent scope switching
  return (
    <div className="border-t border-border bg-surface">
      <div className="flex items-center gap-2 px-4 py-3">
        <button
          type="button"
          onClick={() => handleScopeChange('personal')}
          data-testid="settings-scope-personal"
          aria-pressed={currentScope === 'personal' && activeTab !== 'group-manager'}
          className={`flex h-10 items-center gap-2 rounded-md border px-4 text-sm font-medium transition-colors duration-200 ${
            currentScope === 'personal' && activeTab !== 'group-manager'
              ? 'border-primary bg-primary text-white'
              : 'border-border bg-base text-text-secondary hover:border-primary/40 hover:text-text-primary'
          }`}
        >
          <User className="w-4 h-4" />
          {t('navigation.personalResources')}
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-testid="settings-scope-group"
              aria-pressed={currentScope === 'group' || activeTab === 'group-manager'}
              className={`flex h-10 items-center gap-2 rounded-md border px-4 text-sm font-medium transition-colors duration-200 ${
                currentScope === 'group' || activeTab === 'group-manager'
                  ? 'border-primary bg-primary text-white'
                  : 'border-border bg-base text-text-secondary hover:border-primary/40 hover:text-text-primary'
              }`}
            >
              <Users className="w-4 h-4" />
              <span>{t('navigation.groupResources')}</span>
              {currentScope === 'group' && selectedGroup && (
                <span className="max-w-[140px] truncate text-xs opacity-80">
                  {groups.find(g => g.name === selectedGroup)?.display_name || selectedGroup}
                </span>
              )}
              <ChevronDown className="w-3.5 h-3.5 ml-0.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[180px]">
            {groupsLoading ? (
              <DropdownMenuItem disabled>{t('common:actions.loading')}</DropdownMenuItem>
            ) : groups.length === 0 ? (
              <DropdownMenuItem disabled>{t('groups:groupManager.noGroups')}</DropdownMenuItem>
            ) : (
              groups.map(group => (
                <DropdownMenuItem
                  key={group.id}
                  onClick={() => handleGroupSelect(group.name)}
                  className="flex items-center justify-between"
                >
                  <span className="truncate">{group.display_name || group.name}</span>
                  {selectedGroup === group.name && currentScope === 'group' && (
                    <Check className="w-4 h-4 ml-2 text-primary" />
                  )}
                </DropdownMenuItem>
              ))
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleGroupManagerClick}>
              <Settings className="w-4 h-4 mr-2" />
              {t('navigation.groupManager')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="ml-auto min-w-0 text-right">
          <div className="text-xs font-medium text-text-muted">{t('navigation.scopeLabel')}</div>
          <div className="truncate text-sm text-text-secondary" title={scopeDescription}>
            {scopeDescription}
          </div>
        </div>
      </div>

      <div
        ref={indicatorContainerRef}
        className="relative flex items-center gap-1 overflow-x-auto border-t border-border/70 px-4 py-2"
      >
        <span
          className="pointer-events-none absolute bottom-0 left-0 h-0.5 rounded-full bg-primary transition-all duration-300 ease-out"
          style={{
            width: indicatorStyle.width,
            left: indicatorStyle.left,
            opacity: indicatorStyle.width ? 1 : 0,
          }}
          aria-hidden="true"
        />

        {resourceTabs.map(tab => (
          <button
            key={tab.key}
            type="button"
            ref={element => {
              itemRefs.current[currentScope === 'personal' ? tab.personalId : tab.groupId] = element
            }}
            onClick={() => handleResourceTabClick(tab)}
            className={`relative px-3 py-2 text-sm font-medium whitespace-nowrap rounded-md transition-colors duration-200 ${
              isResourceTabActive(tab)
                ? 'text-primary bg-primary/10'
                : 'text-text-secondary hover:text-text-primary hover:bg-muted'
            }`}
            aria-current={isResourceTabActive(tab) ? 'page' : undefined}
          >
            {tab.label}
          </button>
        ))}

        <div className="h-5 w-px bg-border mx-2" aria-hidden="true" />

        {otherTabs.map(tab => (
          <button
            key={tab.id}
            type="button"
            ref={element => {
              itemRefs.current[tab.id] = element
            }}
            onClick={() => onTabChange(tab.id)}
            className={`relative px-3 py-2 text-sm font-medium whitespace-nowrap rounded-md transition-colors duration-200 ${
              activeTab === tab.id
                ? 'text-primary bg-primary/10'
                : 'text-text-secondary hover:text-text-primary hover:bg-muted'
            }`}
            aria-current={activeTab === tab.id ? 'page' : undefined}
          >
            {tab.label}
          </button>
        ))}
      </div>
    </div>
  )
}

export default SettingsTabNav
