// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useState, useMemo } from 'react'
import { SearchableSelect, SearchableSelectItem } from '@/components/ui/searchable-select'
import { RocketLaunchIcon } from '@heroicons/react/24/outline'
import { Team, DifyApp } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import { apiClient } from '@/apis/client'

interface DifyAppSelectorProps {
  selectedTeam: Team | null
  selectedAppId: string | null
  onAppChange: (appId: string | null) => void
  disabled?: boolean
}

export default function DifyAppSelector({
  selectedTeam,
  selectedAppId,
  onAppChange,
  disabled = false,
}: DifyAppSelectorProps) {
  const _t = useTranslation()
  const [apps, setApps] = useState<DifyApp[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Check if selected team is using Dify runtime
  const isDifyTeam = useMemo(() => {
    if (!selectedTeam || !selectedTeam.bots || selectedTeam.bots.length === 0) {
      return false
    }
    // In a real implementation, we would check the bot's shell runtime
    // For now, we assume it's a Dify team if bot_prompt contains difyAppId
    const firstBot = selectedTeam.bots[0]
    try {
      if (firstBot.bot_prompt) {
        const promptData = JSON.parse(firstBot.bot_prompt)
        return 'difyAppId' in promptData || 'params' in promptData
      }
    } catch {
      // Not a JSON, not a Dify team
    }
    return false
  }, [selectedTeam])

  // Fetch Dify apps
  useEffect(() => {
    if (!isDifyTeam) {
      setApps([])
      setError(null)
      return
    }

    const fetchApps = async () => {
      setIsLoading(true)
      setError(null)
      try {
        const response = await apiClient.get<DifyApp[]>('/dify/apps')
        setApps(response)

        // Auto-select first app if none selected
        if (!selectedAppId && response.length > 0) {
          onAppChange(response[0].id)
        }
      } catch (err: unknown) {
        const error = err as Error
        console.error('Failed to fetch Dify apps:', error)
        setError(error.message || 'Failed to load Dify applications')
        setApps([])
      } finally {
        setIsLoading(false)
      }
    }

    fetchApps()
  }, [isDifyTeam]) // eslint-disable-line react-hooks/exhaustive-deps

  // Don't render if not a Dify team
  if (!isDifyTeam) {
    return null
  }

  // Convert apps to SearchableSelectItem format
  const selectItems: SearchableSelectItem[] = apps.map(app => ({
    value: app.id,
    label: app.name,
    searchText: app.name,
    content: (
      <div className="flex items-center gap-2 min-w-0">
        {app.icon ? (
          <div
            className="w-6 h-6 flex-shrink-0 rounded flex items-center justify-center text-sm"
            style={{ backgroundColor: app.icon_background }}
          >
            {app.icon}
          </div>
        ) : (
          <RocketLaunchIcon className="w-4 h-4 flex-shrink-0 text-text-muted" />
        )}
        <span
          className="font-medium text-xs text-text-secondary truncate flex-1 min-w-0"
          title={app.name}
        >
          {app.name}
        </span>
        <span className="text-xs text-text-muted flex-shrink-0 capitalize">{app.mode}</span>
      </div>
    ),
  }))

  if (error) {
    return (
      <div className="flex items-center space-x-2 min-w-0 text-xs text-red-500">
        <RocketLaunchIcon className="w-3 h-3 flex-shrink-0" />
        <span className="truncate">{error}</span>
      </div>
    )
  }

  return (
    <div className="flex items-center space-x-2 min-w-0">
      <RocketLaunchIcon
        className={`w-3 h-3 text-text-muted flex-shrink-0 ${isLoading ? 'animate-pulse' : ''}`}
      />
      <div className="relative min-w-0" style={{ width: 220 }}>
        <SearchableSelect
          value={selectedAppId || ''}
          onValueChange={onAppChange}
          disabled={disabled || isLoading || apps.length === 0}
          placeholder={
            isLoading ? 'Loading apps...' : apps.length === 0 ? 'No apps found' : 'Select Dify App'
          }
          searchPlaceholder="Search apps..."
          items={selectItems}
          loading={isLoading}
          emptyText="No apps available"
          noMatchText="No matching apps"
          triggerClassName="w-full border-0 shadow-none h-auto py-0 px-0 hover:bg-transparent focus:ring-0"
          contentClassName="max-w-[320px]"
          renderTriggerValue={item => {
            if (!item) return null
            const app = apps.find(a => a.id === item.value)
            return (
              <div className="flex items-center gap-2 min-w-0">
                {app?.icon ? (
                  <div
                    className="w-4 h-4 flex-shrink-0 rounded flex items-center justify-center text-xs"
                    style={{ backgroundColor: app.icon_background }}
                  >
                    {app.icon}
                  </div>
                ) : (
                  <RocketLaunchIcon className="w-3 h-3 flex-shrink-0" />
                )}
                <span className="truncate max-w-full flex-1 min-w-0" title={item.label}>
                  {item.label}
                </span>
              </div>
            )
          }}
        />
      </div>
    </div>
  )
}
