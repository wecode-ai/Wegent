import { cn } from '@/lib/utils'
import { isTauriRuntime } from '@/lib/runtime-environment'
import type { AppTab } from '@/config/apps'
import { Grid3X3, Globe2 } from 'lucide-react'
import { TITLEBAR_ACTIONS_PORTAL_ID } from './TitlebarActionsPortal'
import { TitlebarExtensionSlot } from '@extensions/titlebar'
import type { ReactNode } from 'react'

function getPlatform(): 'mac' | 'win' | 'linux' {
  if (typeof navigator === 'undefined') return 'mac'

  const userAgent = navigator.userAgent || ''
  if (/Mac/i.test(userAgent)) return 'mac'
  if (/Win/i.test(userAgent)) return 'win'
  return 'linux'
}

interface ChromeTitlebarProps {
  tabs: AppTab[]
  activeKey: string
  onNavigate: (appKey: string) => void
  afterTabs?: ReactNode
}

export function ChromeTitlebar({ tabs, activeKey, onNavigate, afterTabs }: ChromeTitlebarProps) {
  const isTauri = isTauriRuntime()
  const platform = getPlatform()

  return (
    <div
      data-testid="chrome-titlebar"
      {...(isTauri ? { 'data-tauri-drag-region': '' } : {})}
      className="z-titlebar flex h-[38px] shrink-0 items-center bg-surface pr-2 select-none"
    >
      {/* macOS: traffic light spacer (left) */}
      {isTauri && platform === 'mac' && (
        <div
          className="w-[95px] shrink-0"
          data-testid="macos-traffic-light-spacer"
          data-tauri-drag-region
        />
      )}

      {/* Tab strip */}
      <div className="flex min-w-0 items-center gap-1 overflow-hidden">
        {tabs.map(tab => (
          <button
            key={tab.key}
            type="button"
            data-testid={`chrome-tab-${tab.key}`}
            onClick={() => onNavigate(tab.key)}
            className={cn(
              'flex h-7 max-w-[220px] min-w-24 items-center justify-center gap-2.5 rounded-lg px-3 text-center text-[13px] leading-none font-medium transition-colors',
              activeKey === tab.key
                ? 'bg-black/[0.045] text-text-primary'
                : 'text-text-secondary hover:bg-black/[0.04]'
            )}
          >
            {tab.key === 'wework' && (
              <Globe2 aria-hidden="true" className="h-4 w-4 shrink-0 stroke-[1.8]" />
            )}
            {tab.key === 'apps' && (
              <Grid3X3 aria-hidden="true" className="h-4 w-4 shrink-0 stroke-[1.8]" />
            )}
            <span className="truncate">{tab.label}</span>
          </button>
        ))}
      </div>
      {afterTabs && (
        <div data-testid="chrome-titlebar-after-tabs" className="ml-3 flex shrink-0 items-center">
          {afterTabs}
        </div>
      )}

      <div className="min-w-6 flex-1" {...(isTauri ? { 'data-tauri-drag-region': '' } : {})} />
      {isTauri && <TitlebarExtensionSlot />}
      <div
        id={TITLEBAR_ACTIONS_PORTAL_ID}
        data-testid="titlebar-actions"
        className="flex shrink-0 items-center gap-2"
      />

      {/* Windows/Linux: right spacer for native window controls */}
      {isTauri && platform !== 'mac' && (
        <div className="w-[138px] shrink-0" data-tauri-drag-region />
      )}
    </div>
  )
}
