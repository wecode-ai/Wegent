import { BranchPicker } from '@/components/common/branch-selector/BranchPicker'
import { useTranslation } from '@/hooks/useTranslation'

interface WorktreeBranchSelectorProps {
  currentBranch?: string
  selectedBranch?: string | null
  loading?: boolean
  onListBranches: () => Promise<string[]>
  onSelectBranch: (branchName: string | null) => void
}

export function WorktreeBranchSelector({
  currentBranch,
  selectedBranch,
  loading = false,
  onListBranches,
  onSelectBranch,
}: WorktreeBranchSelectorProps) {
  const { t } = useTranslation('common')
  const current = currentBranch?.trim() || ''
  const selected = selectedBranch?.trim() || current
  return (
    <div className="min-w-0 max-w-72 shrink">
      <BranchPicker
        mobileSheet
        composer
        activateSelected
        value={selected}
        label={
          loading
            ? t('workbench.project_worktree_branch_loading', '加载中')
            : selected || t('workbench.project_worktree_branch_empty', '选择分支')
        }
        prefix="project-worktree"
        triggerTestId="project-worktree-branch-button"
        accessibleLabel={t('workbench.project_worktree_branch_title', '启动分支')}
        onListBranches={onListBranches}
        onChoose={branch => onSelectBranch(branch === current ? null : branch)}
      />
    </div>
  )
}
