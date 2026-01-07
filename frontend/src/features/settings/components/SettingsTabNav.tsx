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

// Scope type for resource tabs
type ResourceScope = 'personal' | 'group'

interface SettingsTabNavProps {
  activeTab: SettingsTabId
  onTabChange: (tab: SettingsTabId) => void
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
  const { t } = useTranslation(['common', 'groups'])
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
        label: t('settings.team'),
      },
      {
        key: 'models',
        personalId: 'personal-models',
        groupId: 'group-models',
        label: t('settings.models'),
      },
      {
        key: 'shells',
        personalId: 'personal-shells',
        groupId: 'group-shells',
        label: t('settings.shells'),
      },
      {
        key: 'skills',
        personalId: 'personal-skills',
        groupId: 'group-skills',
        label: t('settings.skills'),
      },
      {
        key: 'retrievers',
        personalId: 'personal-retrievers',
        groupId: 'group-retrievers',
        label: t('settings.retrievers'),
      },
    ],
    [t]
  )

  // Other tabs (not resource-based) - order: general, integrations, api-keys
  // Note: group-manager is now accessed via the group dropdown menu
  const otherTabs: TabItem[] = useMemo(
    () => [
      { id: 'general', label: t('settings.sections.general'), category: 'other' },
      { id: 'integrations', label: t('settings.integrations'), category: 'other' },
      { id: 'api-keys', label: t('settings.api_keys'), category: 'other' },
    ],
    [t]
  )

  // Handle navigation to group manager
  const handleGroupManagerClick = () => {
    onTabChange('group-manager')
  }

  // Handle group selection
  const handleGroupSelect = (groupName: string | null) => {
    onGroupChange?.(groupName)
    // Switch to group scope when selecting a group
    handleScopeChange('group')
  }
  // Determine current scope based on active tab
  const getCurrentScope = (): ResourceScope => {
    if (activeTab.startsWith('group-') && activeTab !== 'group-manager') {
      return 'group'
    }
    return 'personal'
  }

  const [currentScope, setCurrentScope] = useState<ResourceScope>(getCurrentScope())

  // Update scope when active tab changes
  useEffect(() => {
    const newScope = getCurrentScope()
    if (newScope !== currentScope) {
      setCurrentScope(newScope)
    }
  }, [activeTab, currentScope, getCurrentScope])

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
            className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
              currentScope === 'personal' && activeTab !== 'group-manager'
                ? 'bg-primary text-white'
                : 'bg-muted text-text-secondary hover:text-text-primary'
            }`}
          >
            <User className="w-3.5 h-3.5" />
            {t('settings.personal')}
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  currentScope === 'group' || activeTab === 'group-manager'
                    ? 'bg-primary text-white'
                    : 'bg-muted text-text-secondary hover:text-text-primary'
                }`}
              >
                <Users className="w-3.5 h-3.5" />
                {currentScope === 'group' && selectedGroup
                  ? groups.find(g => g.name === selectedGroup)?.display_name || selectedGroup
                  : t('settings.groups')}
                <ChevronDown className="w-3.5 h-3.5 ml-1" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[160px]">
              {groupsLoading ? (
                <DropdownMenuItem disabled>{t('actions.loading')}</DropdownMenuItem>
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
                {t('settings.groupManager')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Tab selector */}
        <Select value={activeTab} onValueChange={value => onTabChange(value as SettingsTabId)}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder={t('settings.sections.general')} />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>
                {currentScope === 'personal' ? t('settings.personal') : t('settings.groups')}
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
              <SelectLabel>{t('settings.sections.general')}</SelectLabel>
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

  // Desktop: Horizontal tab navigation with scope toggle
  return (
    <div
      ref={indicatorContainerRef}
      className="relative flex items-center gap-1 px-4 py-2 border-t border-border bg-surface overflow-x-auto"
    >
      {/* Sliding indicator */}
      <span
        className="pointer-events-none absolute bottom-0 left-0 h-0.5 rounded-full bg-primary transition-all duration-300 ease-out"
        style={{
          width: indicatorStyle.width,
          left: indicatorStyle.left,
          opacity: indicatorStyle.width ? 1 : 0,
        }}
        aria-hidden="true"
      />

      {/* Scope toggle */}
      <div className="flex items-center bg-muted rounded-lg p-0.5 mr-2">
        <button
          type="button"
          onClick={() => handleScopeChange('personal')}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md transition-all duration-200 ${
            currentScope === 'personal' && activeTab !== 'group-manager'
              ? 'bg-surface text-primary shadow-sm'
              : 'text-text-muted hover:text-text-secondary'
          }`}
        >
          <User className="w-3.5 h-3.5" />
          {t('settings.personal')}
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={`flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-md transition-all duration-200 ${
                currentScope === 'group' || activeTab === 'group-manager'
                  ? 'bg-surface text-primary shadow-sm'
                  : 'text-text-muted hover:text-text-secondary'
              }`}
            >
              <Users className="w-3.5 h-3.5" />
              {currentScope === 'group' && selectedGroup
                ? groups.find(g => g.name === selectedGroup)?.display_name || selectedGroup
                : t('settings.groups')}
              <ChevronDown className="w-3 h-3 ml-0.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[160px]">
            {groupsLoading ? (
              <DropdownMenuItem disabled>{t('actions.loading')}</DropdownMenuItem>
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
              {t('settings.groupManager')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Resource tabs */}
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

      {/* Separator */}
      <div className="h-5 w-px bg-border mx-2" aria-hidden="true" />

      {/* Other tabs */}
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
  )
}

export default SettingsTabNav
