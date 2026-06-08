import { PanelBottom, PanelRight } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import {
  EnvironmentInfoPopover,
} from '../EnvironmentInfoPopover'
import {
  DESKTOP_TOP_BAR_BUTTON_CLASS,
} from '../DesktopTopBar'
import { cn } from '@/lib/utils'
import type { EnvironmentInfo } from '@/types/environment'

interface WorkspacePanelActionsProps {
  environmentInfo: EnvironmentInfo
  onRefreshEnvironmentInfo: () => Promise<void>
  onCommitEnvironmentChanges: (message: string) => Promise<void>
  onListEnvironmentBranches: () => Promise<string[]>
  onCheckoutEnvironmentBranch: (branchName: string) => Promise<void>
  onCreateEnvironmentBranch: (branchName: string) => Promise<void>
  rightPanelOpen: boolean
  bottomPanelOpen: boolean
  onToggleRightPanel: () => void
  onToggleBottomPanel: () => void
}

export function WorkspacePanelActions({
  environmentInfo,
  onRefreshEnvironmentInfo,
  onCommitEnvironmentChanges,
  onListEnvironmentBranches,
  onCheckoutEnvironmentBranch,
  onCreateEnvironmentBranch,
  rightPanelOpen,
  bottomPanelOpen,
  onToggleRightPanel,
  onToggleBottomPanel,
}: WorkspacePanelActionsProps) {
  const { t } = useTranslation('common')
  const canShowEnvironmentInfo =
    environmentInfo.loading !== false || Boolean(environmentInfo.branchName?.trim())

  return (
    <>
      {canShowEnvironmentInfo && (
        <EnvironmentInfoPopover
          info={environmentInfo}
          onRefresh={onRefreshEnvironmentInfo}
          onCommitChanges={onCommitEnvironmentChanges}
          onListBranches={onListEnvironmentBranches}
          onCheckoutBranch={onCheckoutEnvironmentBranch}
          onCreateBranch={onCreateEnvironmentBranch}
        />
      )}
      <button
        type="button"
        data-testid="toggle-bottom-workspace-panel-button"
        onClick={onToggleBottomPanel}
        className={cn(
          DESKTOP_TOP_BAR_BUTTON_CLASS,
          bottomPanelOpen && 'bg-black/[0.10] text-[#374151]',
        )}
        aria-label={t('workbench.toggle_bottom_workspace_panel', '打开底部栏')}
      >
        <PanelBottom />
      </button>
      <button
        type="button"
        data-testid="toggle-right-workspace-panel-button"
        onClick={onToggleRightPanel}
        className={cn(
          DESKTOP_TOP_BAR_BUTTON_CLASS,
          rightPanelOpen && 'bg-black/[0.10] text-[#374151]',
        )}
        aria-label={t('workbench.toggle_right_workspace_panel', '打开右侧栏')}
      >
        <PanelRight />
      </button>
    </>
  )
}
