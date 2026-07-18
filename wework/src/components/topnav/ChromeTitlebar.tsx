import { cn } from '@/lib/utils'
import { isTauriRuntime } from '@/lib/runtime-environment'
import type { AppTab } from '@/config/apps'
import {
  TITLEBAR_ACTIONS_PORTAL_ID,
  TITLEBAR_CENTER_PORTAL_ID,
  TITLEBAR_RIGHT_PANEL_PORTAL_ID,
} from './TitlebarActionsPortal'
import { TitlebarExtensionSlot } from '@extensions/titlebar'
import { MacOSTitleBarDragRegion } from '@/components/layout/MacOSTitleBarDragRegion'
import { DesktopAppSwitcher } from '@/components/layout/DesktopAppSwitcher'
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
  beforeTabs?: ReactNode
  afterTabs?: ReactNode
  className?: string
  iconOnlyTabs?: boolean
}

export function ChromeTitlebar({
  tabs,
  activeKey,
  onNavigate,
  beforeTabs,
  afterTabs,
  className,
  iconOnlyTabs = false,
}: ChromeTitlebarProps) {
  const isTauri = isTauriRuntime()
  const platform = getPlatform()

  return (
    <div
      data-testid="chrome-titlebar"
      className={cn(
        'z-titlebar flex h-[38px] shrink-0 items-center bg-surface pr-2 select-none',
        className
      )}
    >
      {/* macOS: traffic light spacer (left) */}
      {isTauri && platform === 'mac' && (
        <div
          className="w-[92px] shrink-0 self-stretch"
          data-testid="macos-traffic-light-spacer"
          data-tauri-drag-region
        >
          <MacOSTitleBarDragRegion />
        </div>
      )}

      {beforeTabs && (
        <div data-testid="chrome-titlebar-before-tabs" className="mr-1 flex shrink-0 items-center">
          {beforeTabs}
        </div>
      )}

      {/* Tab strip */}
      {iconOnlyTabs ? (
        <DesktopAppSwitcher
          activeApp={
            activeKey === 'apps'
              ? 'apps'
              : activeKey === 'todo'
                ? 'todo'
                : activeKey === 'wegent'
                  ? 'wegent'
                  : 'wework'
          }
          onNavigate={onNavigate}
        />
      ) : (
        <div className="flex min-w-0 items-center gap-1 overflow-hidden">
          {tabs.map(tab => (
            <button
              key={tab.key}
              type="button"
              data-testid={`chrome-tab-${tab.key}`}
              onClick={() => onNavigate(tab.key)}
              title={tab.label}
              aria-label={tab.label}
              className={cn(
                'group relative flex h-8 max-w-[220px] min-w-24 items-center justify-center gap-2.5 rounded-lg px-3 text-center text-sm font-medium leading-none transition-colors',
                activeKey === tab.key
                  ? 'bg-black/[0.045] text-text-primary'
                  : 'text-text-secondary hover:bg-black/[0.04]'
              )}
            >
              <span className="truncate">{tab.label}</span>
            </button>
          ))}
        </div>
      )}
      {afterTabs && (
        <div data-testid="chrome-titlebar-after-tabs" className="ml-3 flex shrink-0 items-center">
          {afterTabs}
        </div>
      )}

      <div
        id={TITLEBAR_CENTER_PORTAL_ID}
        data-testid="titlebar-center"
        className="pointer-events-none relative z-chrome flex h-full min-w-6 flex-1 items-center overflow-hidden"
        {...(isTauri ? { 'data-tauri-drag-region': '' } : {})}
      >
        {isTauri && <MacOSTitleBarDragRegion className="absolute inset-0 z-0 h-full w-full" />}
      </div>
      {isTauri && <TitlebarExtensionSlot />}
      <div
        data-testid="titlebar-right-workspace-zone"
        className="pointer-events-none absolute right-0 top-0 z-chrome flex h-full items-center"
        style={{
          width: 'var(--right-workspace-titlebar-width, auto)',
        }}
      >
        <div
          id={TITLEBAR_RIGHT_PANEL_PORTAL_ID}
          data-testid="titlebar-right-panel"
          className="pointer-events-auto relative flex min-w-0 flex-1 self-stretch items-center"
        >
          {isTauri ? (
            <div data-testid="titlebar-right-panel-drag-region" className="absolute inset-0 z-0">
              <MacOSTitleBarDragRegion className="h-full w-full" />
            </div>
          ) : null}
        </div>
        <div
          id={TITLEBAR_ACTIONS_PORTAL_ID}
          data-testid="titlebar-actions"
          className="pointer-events-auto flex h-full shrink-0 items-center gap-1 pr-3"
        />
      </div>

      {/* Windows/Linux: right spacer for native window controls */}
      {isTauri && platform !== 'mac' && (
        <div className="w-[138px] shrink-0 self-stretch" data-tauri-drag-region>
          <MacOSTitleBarDragRegion />
        </div>
      )}
    </div>
  )
}
