import { NotificationCenter } from '@/features/notifications/NotificationCenter'
import { cn } from '@/lib/utils'
import { isDesktopRuntime, isElectronRuntime } from '@/lib/runtime-environment'
import { getPlatform } from '@/lib/platform'
import {
  TITLEBAR_ACTIONS_PORTAL_ID,
  TITLEBAR_FEEDBACK_PORTAL_ID,
  TITLEBAR_RIGHT_PANEL_PORTAL_ID,
} from './TitlebarActionsPortal'
import { TitlebarExtensionSlot } from '@extensions/titlebar'
import { MacOSTitleBarDragRegion } from '@/components/layout/MacOSTitleBarDragRegion'
import { WindowFrameControls } from '@/components/layout/WindowFrameControls'
import { ApplicationMenuButton } from './ApplicationMenuButton'
import { GlobalFeedbackButton } from '@/features/feedback/GlobalFeedbackButton'
import { useRef, type CSSProperties, type ReactNode } from 'react'
import { useElementGeometry } from '@wegent/collaboration/dom-events'
import { WorkspaceTabStrip } from '@/features/workspace-tabs/WorkspaceTabStrip'
import type { WorkspaceTabKind } from '@/features/workspace-tabs/workspaceTabs'

interface ChromeTitlebarProps {
  beforeTabs?: ReactNode
  afterTabs?: ReactNode
  className?: string
  showWorkspacePortals?: boolean
  availableWorkspaceTabKinds?: readonly WorkspaceTabKind[]
}

export function ChromeTitlebar({
  beforeTabs,
  afterTabs,
  className,
  showWorkspacePortals = true,
  availableWorkspaceTabKinds,
}: ChromeTitlebarProps) {
  const isElectron = isElectronRuntime()
  const isDesktop = isDesktopRuntime()
  const platform = getPlatform()
  const feedbackSlotVisible = isDesktop
  const actionsRef = useRef<HTMLDivElement>(null)
  const fixedActionsWidth = 'var(--titlebar-fixed-actions-width, 0px)'
  const geometry = useElementGeometry([actionsRef])
  const actionsWidth = geometry?.elements[0]?.width ?? 0

  return (
    <div
      style={{ '--titlebar-fixed-actions-width': `${actionsWidth}px` } as CSSProperties}
      data-testid="chrome-titlebar"
      className={cn(
        'relative z-titlebar flex h-12 shrink-0 items-center bg-[rgb(var(--color-titlebar))] pr-2 select-none sm:max-md:h-11 md:h-[38px]',
        isDesktop && platform !== 'mac' && 'max-sm:h-24 max-sm:pb-12',
        className
      )}
    >
      {/* macOS: traffic light spacer (left) */}
      {isDesktop && platform === 'mac' && (
        <div className="w-[92px] shrink-0 self-stretch" data-testid="macos-traffic-light-spacer">
          <MacOSTitleBarDragRegion />
        </div>
      )}

      {/* Windows/Linux: the frameless window hides the OS menu bar, so the
          application menu is exposed through a native button instead. */}
      {isDesktop && (platform === 'win' || platform === 'linux') && <ApplicationMenuButton />}
      {isDesktop && platform !== 'mac' && (
        <div
          data-testid="compact-titlebar-drag-region"
          className="min-w-0 flex-1 self-stretch sm:hidden"
        >
          <MacOSTitleBarDragRegion />
        </div>
      )}

      {beforeTabs && (
        <div
          data-testid="chrome-titlebar-before-tabs"
          className="electron-titlebar-interactive-region mr-1 flex shrink-0 items-center"
        >
          {beforeTabs}
        </div>
      )}

      <WorkspaceTabStrip
        availableKinds={availableWorkspaceTabKinds}
        className={
          isDesktop && platform !== 'mac'
            ? 'max-sm:absolute max-sm:inset-x-0 max-sm:bottom-0 max-sm:h-12 max-sm:w-full'
            : undefined
        }
      />
      {afterTabs && (
        <div
          data-testid="chrome-titlebar-after-tabs"
          className="electron-titlebar-interactive-region ml-3 flex shrink-0 items-center"
        >
          {afterTabs}
        </div>
      )}

      {showWorkspacePortals && isDesktop && <TitlebarExtensionSlot />}
      {showWorkspacePortals && (
        <div
          data-testid="titlebar-right-workspace-zone"
          className="pointer-events-none absolute top-0 z-chrome flex h-12 items-center md:h-full"
          style={{
            right:
              isDesktop && platform === 'win'
                ? `calc(138px + ${fixedActionsWidth})`
                : isDesktop && platform === 'linux'
                  ? `calc(138px + ${fixedActionsWidth})`
                  : fixedActionsWidth,
            width: 'var(--right-workspace-titlebar-width, auto)',
          }}
        >
          <div
            id={TITLEBAR_RIGHT_PANEL_PORTAL_ID}
            data-testid="titlebar-right-panel"
            className="pointer-events-auto relative flex min-w-0 flex-1 self-stretch items-center"
          >
            {isDesktop ? (
              <div data-testid="titlebar-right-panel-drag-region" className="absolute inset-0 z-0">
                <MacOSTitleBarDragRegion className="h-full w-full" />
              </div>
            ) : null}
          </div>
        </div>
      )}
      {
        <div
          ref={actionsRef}
          data-testid="titlebar-fixed-actions"
          className="relative z-chrome flex h-full shrink-0 items-center"
        >
          {showWorkspacePortals && (
            <div
              id={TITLEBAR_ACTIONS_PORTAL_ID}
              data-testid="titlebar-actions"
              className="electron-titlebar-interactive-region pointer-events-auto flex h-full shrink-0 items-center justify-end gap-1"
            />
          )}
          <div
            data-testid="titlebar-notifications"
            className="electron-titlebar-interactive-region flex h-full w-11 shrink-0 items-center justify-center md:w-9"
          >
            <NotificationCenter />
          </div>
          {feedbackSlotVisible && (
            <div
              id={TITLEBAR_FEEDBACK_PORTAL_ID}
              data-testid="titlebar-feedback"
              className="electron-titlebar-interactive-region pointer-events-auto flex h-full w-11 shrink-0 items-center justify-center md:w-7"
            >
              <GlobalFeedbackButton />
            </div>
          )}
        </div>
      }

      {/* Windows and Linux share the Electron window controls. */}
      {isElectron && (platform === 'win' || platform === 'linux') && (
        <div className="electron-titlebar-interactive-region relative z-chrome w-[138px] shrink-0 self-stretch">
          <WindowFrameControls className="h-full justify-end" />
        </div>
      )}
    </div>
  )
}
