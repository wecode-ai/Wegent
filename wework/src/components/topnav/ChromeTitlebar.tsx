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
import { TaskFeedbackDialog } from '@/features/feedback/TaskFeedbackDialog'
import { useTranslation } from '@/hooks/useTranslation'
import { MessageSquareWarning } from 'lucide-react'
import { DESKTOP_TOP_BAR_BUTTON_CLASS } from '@/components/layout/DesktopTopBar'
import { useState, type ReactNode } from 'react'
import { WorkspaceTabStrip } from '@/features/workspace-tabs/WorkspaceTabStrip'
import type { WorkspaceTabKind } from '@/features/workspace-tabs/workspaceTabs'

interface ChromeTitlebarProps {
  beforeTabs?: ReactNode
  afterTabs?: ReactNode
  className?: string
  showWorkspacePortals?: boolean
  showFeedback?: boolean
  availableWorkspaceTabKinds?: readonly WorkspaceTabKind[]
}

export function ChromeTitlebar({
  beforeTabs,
  afterTabs,
  className,
  showWorkspacePortals = true,
  showFeedback = true,
  availableWorkspaceTabKinds,
}: ChromeTitlebarProps) {
  const isElectron = isElectronRuntime()
  const isDesktop = isDesktopRuntime()
  const platform = getPlatform()
  const feedbackSlotVisible = isDesktop && platform === 'mac'
  const fixedActionsWidth = showWorkspacePortals
    ? feedbackSlotVisible
      ? '6.75rem'
      : '5rem'
    : feedbackSlotVisible
      ? '1.75rem'
      : '0px'

  return (
    <div
      data-testid="chrome-titlebar"
      className={cn(
        'z-titlebar flex h-[38px] shrink-0 items-center bg-[rgb(var(--color-titlebar))] pr-2 select-none',
        className
      )}
    >
      {/* macOS: traffic light spacer (left) */}
      {isDesktop && platform === 'mac' && (
        <div className="w-[92px] shrink-0 self-stretch" data-testid="macos-traffic-light-spacer">
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

      <WorkspaceTabStrip availableKinds={availableWorkspaceTabKinds} />
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
          className="pointer-events-none absolute top-0 z-chrome flex h-full items-center"
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
      {(showWorkspacePortals || feedbackSlotVisible) && (
        <div
          data-testid="titlebar-fixed-actions"
          className="relative z-chrome flex h-full shrink-0 items-center"
          style={{ width: fixedActionsWidth }}
        >
          {showWorkspacePortals && (
            <div
              id={TITLEBAR_ACTIONS_PORTAL_ID}
              data-testid="titlebar-actions"
              className="electron-titlebar-interactive-region pointer-events-auto flex h-full w-[5rem] shrink-0 items-center justify-end gap-1"
            />
          )}
          {feedbackSlotVisible && (
            <div
              id={TITLEBAR_FEEDBACK_PORTAL_ID}
              data-testid="titlebar-feedback"
              className="electron-titlebar-interactive-region pointer-events-auto flex h-full w-7 shrink-0 items-center justify-center"
            >
              {showFeedback && <TopnavFeedbackButton />}
            </div>
          )}
        </div>
      )}

      {/* Linux: right spacer for native window controls */}
      {isDesktop && platform === 'linux' && (
        <div className="electron-titlebar-drag-region w-[138px] shrink-0 self-stretch">
          <MacOSTitleBarDragRegion />
        </div>
      )}

      {/* Windows: custom window frame controls */}
      {((isDesktop && platform === 'win') ||
        (isElectron && (platform === 'win' || platform === 'linux'))) && (
        <div className="electron-titlebar-interactive-region relative z-chrome w-[138px] shrink-0 self-stretch">
          <WindowFrameControls className="h-full justify-end" />
        </div>
      )}
    </div>
  )
}

function TopnavFeedbackButton() {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        data-testid="topnav-feedback-button"
        className={DESKTOP_TOP_BAR_BUTTON_CLASS}
        aria-label={t('workbench.feedback_button')}
        title={t('workbench.feedback_button')}
        onClick={() => setOpen(true)}
      >
        <MessageSquareWarning className="h-4 w-4" />
      </button>
      <TaskFeedbackDialog
        open={open}
        hasActiveTask={false}
        onClose={() => setOpen(false)}
        getTaskContext={() => Promise.resolve({})}
      />
    </>
  )
}
