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
  rightPanelOpen: boolean
  bottomPanelOpen: boolean
  onToggleRightPanel: () => void
  onToggleBottomPanel: () => void
}

export function WorkspacePanelActions({
  environmentInfo,
  onRefreshEnvironmentInfo,
  onCommitEnvironmentChanges,
  rightPanelOpen,
  bottomPanelOpen,
  onToggleRightPanel,
  onToggleBottomPanel,
}: WorkspacePanelActionsProps) {
  const { t } = useTranslation('common')

  return (
    <div className="absolute right-5 top-4 z-50 flex items-center gap-3">
      <EnvironmentInfoPopover
        info={environmentInfo}
        onRefresh={onRefreshEnvironmentInfo}
        onCommitChanges={onCommitEnvironmentChanges}
      />
      <button
        type="button"
        data-testid="toggle-bottom-workspace-panel-button"
        onClick={onToggleBottomPanel}
        className={`flex h-9 w-9 items-center justify-center rounded-md text-text-secondary hover:bg-muted ${
          bottomPanelOpen ? 'bg-muted text-text-primary' : ''
        }`}
        aria-label={t('workbench.toggle_bottom_workspace_panel', '打开底部栏')}
      >
        <PanelBottom className="h-5 w-5" />
      </button>
      <button
        type="button"
        data-testid="toggle-right-workspace-panel-button"
        onClick={onToggleRightPanel}
        className={`flex h-9 w-9 items-center justify-center rounded-md text-text-secondary hover:bg-muted ${
          rightPanelOpen ? 'bg-muted text-text-primary' : ''
        }`}
        aria-label={t('workbench.toggle_right_workspace_panel', '打开右侧栏')}
      >
        <PanelRight className="h-5 w-5" />
      </button>
    </div>
  )
}
