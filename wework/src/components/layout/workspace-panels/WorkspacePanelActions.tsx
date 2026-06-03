import { PanelBottom, PanelRight } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import {
  EnvironmentInfoPopover,
} from '../EnvironmentInfoPopover'
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

  return (
    <div className="absolute right-5 top-1 z-50 flex items-center gap-3">
      <EnvironmentInfoPopover
        info={environmentInfo}
        onRefresh={onRefreshEnvironmentInfo}
        onCommitChanges={onCommitEnvironmentChanges}
        onListBranches={onListEnvironmentBranches}
        onCheckoutBranch={onCheckoutEnvironmentBranch}
        onCreateBranch={onCreateEnvironmentBranch}
      />
      <button
        type="button"
        data-testid="toggle-bottom-workspace-panel-button"
        onClick={onToggleBottomPanel}
        className={`flex h-8 w-8 items-center justify-center rounded-md text-text-secondary hover:bg-muted ${
          bottomPanelOpen ? 'bg-muted text-text-primary' : ''
        }`}
        aria-label={t('workbench.toggle_bottom_workspace_panel', '打开底部栏')}
      >
        <PanelBottom className="h-4 w-4" />
      </button>
      <button
        type="button"
        data-testid="toggle-right-workspace-panel-button"
        onClick={onToggleRightPanel}
        className={`flex h-8 w-8 items-center justify-center rounded-md text-text-secondary hover:bg-muted ${
          rightPanelOpen ? 'bg-muted text-text-primary' : ''
        }`}
        aria-label={t('workbench.toggle_right_workspace_panel', '打开右侧栏')}
      >
        <PanelRight className="h-4 w-4" />
      </button>
    </div>
  )
}
