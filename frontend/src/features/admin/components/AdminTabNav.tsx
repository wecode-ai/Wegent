// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import {
  Users,
  Cpu,
  Settings,
  Sparkles,
  KeyRound,
  Database,
  Bot,
  UsersRound,
  Ghost,
  Terminal,
  Activity,
} from 'lucide-react'

export type AdminTabId =
  | 'users'
  | 'public-models'
  | 'public-retrievers'
  | 'public-skills'
  | 'public-ghosts'
  | 'public-shells'
  | 'public-teams'
  | 'public-bots'
  | 'api-keys'
  | 'system-config'
  | 'monitor'

interface AdminTabNavProps {
  activeTab: AdminTabId
  onTabChange: (tab: AdminTabId) => void
}

interface TabItem {
  id: AdminTabId
  label: string
  icon: React.ElementType
}

export function AdminTabNav({ activeTab, onTabChange }: AdminTabNavProps) {
  const { t } = useTranslation()
  const isMobile = useIsMobile()
  const indicatorContainerRef = useRef<HTMLDivElement | null>(null)
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const [indicatorStyle, setIndicatorStyle] = useState({ width: 0, left: 0 })

  // Tab items
  const tabs: TabItem[] = [
    { id: 'users', label: t('admin:tabs.users'), icon: Users },
    { id: 'public-models', label: t('admin:tabs.public_models'), icon: Cpu },
    { id: 'public-retrievers', label: t('admin:tabs.public_retrievers'), icon: Database },
    { id: 'public-skills', label: t('admin:tabs.public_skills'), icon: Sparkles },
    { id: 'public-ghosts', label: t('admin:tabs.public_ghosts'), icon: Ghost },
    { id: 'public-shells', label: t('admin:tabs.public_shells'), icon: Terminal },
    { id: 'public-teams', label: t('admin:tabs.public_teams'), icon: UsersRound },
    { id: 'public-bots', label: t('admin:tabs.public_bots'), icon: Bot },
    { id: 'api-keys', label: t('admin:tabs.api_keys'), icon: KeyRound },
    { id: 'system-config', label: t('admin:tabs.system_config'), icon: Settings },
    { id: 'monitor', label: t('admin:tabs.monitor'), icon: Activity },
  ]

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

  // Mobile: Dropdown select
  if (isMobile) {
    return (
      <div className="px-4 py-2 border-t border-border bg-base">
        <Select value={activeTab} onValueChange={value => onTabChange(value as AdminTabId)}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder={t('admin:tabs.users')} />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {tabs.map(tab => (
                <SelectItem key={tab.id} value={tab.id}>
                  <div className="flex items-center gap-2">
                    <tab.icon className="w-4 h-4" />
                    {tab.label}
                  </div>
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
    )
  }

  // Desktop: Horizontal tab navigation
  return (
    <div
      ref={indicatorContainerRef}
      className="relative flex items-center gap-1 px-4 py-2 border-t border-border bg-base overflow-x-auto"
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

      {/* Tab buttons */}
      {tabs.map(tab => (
        <button
          key={tab.id}
          type="button"
          ref={element => {
            itemRefs.current[tab.id] = element
          }}
          onClick={() => onTabChange(tab.id)}
          className={`relative flex items-center gap-2 px-3 py-2 text-sm font-medium whitespace-nowrap rounded-md transition-colors duration-200 ${
            activeTab === tab.id
              ? 'text-primary bg-primary/10'
              : 'text-text-secondary hover:text-text-primary hover:bg-muted'
          }`}
          aria-current={activeTab === tab.id ? 'page' : undefined}
        >
          <tab.icon className="w-4 h-4" />
          {tab.label}
        </button>
      ))}
    </div>
  )
}

export default AdminTabNav
