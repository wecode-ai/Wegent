import { Check, ChevronDown, Folder, GitBranch, Workflow } from 'lucide-react'
import { useState } from 'react'

import { BranchSelector } from '@/components/common/BranchSelector'
import { WorktreeBranchSelector } from '@/components/chat/composer/WorktreeBranchSelector'
import { useTranslation } from '@/hooks/useTranslation'
import { isGitWorkspaceProject } from '@/lib/projectClassification'
import { cn } from '@/lib/utils'
import type { ProjectWorktreeAvailability } from '@/lib/worktree-availability'
import type { ProjectWithTasks } from '@/types/api'

interface GitProjectWorkContext {
  branchLoading?: boolean
  branchName?: string
  branchNameSource?: string
  currentProject?: ProjectWithTasks | null
  executionMode: string
  executionModeLocked?: boolean
  isMobile?: boolean
  onCheckoutBranch?: (branchName: string) => Promise<void>
  onCreateBranch?: (branchName: string) => Promise<void>
  onExecutionModeChange: (mode: string) => void
  onGenerateBranchName?: (sourceText: string) => Promise<string>
  onListBranches?: () => Promise<string[]>
  onRefreshBranch?: () => Promise<void>
  onWorktreeBranchChange?: (branchName: string | null) => void
  worktreeAvailability?: ProjectWorktreeAvailability
  worktreeBranch?: string | null
  project?: ProjectWithTasks | null
}

interface GitProjectWorkSectionProps {
  context: GitProjectWorkContext
}

export default function GitProjectWorkSection({ context }: GitProjectWorkSectionProps) {
  const { t } = useTranslation('common')
  const [modeMenuOpen, setModeMenuOpen] = useState(false)
  const project = context.project ?? context.currentProject
  const worktreeAvailability =
    context.worktreeAvailability ??
    ({
      available: false,
      reason: project && !isGitWorkspaceProject(project) ? 'not_git' : 'preflight_pending',
      deviceId: null,
      sourcePath: null,
    } as const)
  const projectIsRepository = Boolean(
    project && (isGitWorkspaceProject(project) || context.worktreeAvailability?.available)
  )
  if (!project) return null

  const worktreeSelected = context.executionMode === 'git_worktree'
  const modeLabel = worktreeSelected
    ? t('workbench.execution_mode_git_worktree', '新工作树')
    : t('workbench.execution_mode_current_workspace', '当前工作区')

  return (
    <>
      <div className="relative min-w-0 max-w-[10rem] shrink">
        {modeMenuOpen ? (
          <div
            data-testid="project-execution-mode-menu"
            className="absolute left-0 top-11 z-popover w-56 rounded-2xl border border-border bg-background p-2 shadow-[0_16px_44px_rgba(0,0,0,0.16)]"
          >
            {(
              [
                ['current_workspace', t('workbench.execution_mode_current_workspace')],
                ['git_worktree', t('workbench.execution_mode_git_worktree')],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                data-testid={`execution-mode-${mode.replaceAll('_', '-')}-button`}
                disabled={mode === 'git_worktree' && !worktreeAvailability.available}
                onClick={() => {
                  context.onExecutionModeChange(mode)
                  setModeMenuOpen(false)
                }}
                className="flex h-9 w-full items-center gap-3 rounded-lg px-2 text-left text-sm font-medium leading-[18px] text-text-secondary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
              >
                {mode === 'git_worktree' ? (
                  <Workflow className="h-4 w-4 shrink-0" />
                ) : (
                  <Folder className="h-4 w-4 shrink-0" />
                )}
                <span className="min-w-0 flex-1">{label}</span>
                {context.executionMode === mode ? <Check className="h-4 w-4 shrink-0" /> : null}
              </button>
            ))}
            {!worktreeAvailability.available ? (
              <p
                data-testid="execution-mode-worktree-unavailable-reason"
                className="px-2 pt-1 text-xs leading-4 text-text-muted"
                role="status"
              >
                {t(`workbench.worktree_unavailable_${worktreeAvailability.reason}`)}
              </p>
            ) : null}
          </div>
        ) : null}
        <button
          type="button"
          data-testid="execution-mode-button"
          disabled={context.executionModeLocked}
          onClick={() => setModeMenuOpen(open => !open)}
          className={cn(
            'flex h-9 w-full min-w-[44px] items-center gap-2 rounded-full px-2 text-sm font-normal leading-[18px] text-text-secondary hover:bg-background/70 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40',
            modeMenuOpen && 'bg-background/70 text-text-primary'
          )}
          aria-expanded={modeMenuOpen}
        >
          {worktreeSelected ? (
            <Workflow className="h-4 w-4 shrink-0" />
          ) : (
            <Folder className="h-4 w-4 shrink-0" />
          )}
          <span className="max-w-[8rem] truncate">{modeLabel}</span>
          <ChevronDown className="h-4 w-4 shrink-0" />
        </button>
      </div>
      {!context.executionModeLocked &&
      projectIsRepository &&
      !worktreeSelected &&
      context.onListBranches &&
      context.onCheckoutBranch ? (
        <BranchSelector
          variant="workbar"
          mobileSheet
          currentBranch={context.branchName}
          loading={context.branchLoading}
          onRefresh={context.onRefreshBranch}
          onListBranches={context.onListBranches}
          onCheckoutBranch={context.onCheckoutBranch}
          onCreateBranch={context.onCreateBranch}
          onGenerateBranchName={context.onGenerateBranchName}
          branchNameSource={context.branchNameSource}
        />
      ) : null}
      {!context.executionModeLocked &&
      projectIsRepository &&
      worktreeSelected &&
      context.onListBranches &&
      context.onWorktreeBranchChange ? (
        <WorktreeBranchSelector
          currentBranch={context.branchName}
          selectedBranch={context.worktreeBranch}
          loading={context.branchLoading}
          onListBranches={context.onListBranches}
          onSelectBranch={context.onWorktreeBranchChange}
        />
      ) : null}
      {context.executionModeLocked && context.branchName ? (
        <div
          data-testid="project-work-branch-readonly"
          className="flex h-9 min-w-0 max-w-[18rem] items-center gap-2 rounded-full px-2 text-sm font-normal leading-[18px] text-text-secondary"
          title={context.branchName}
        >
          <GitBranch className="h-4 w-4 shrink-0" />
          <span className="truncate">{context.branchName}</span>
        </div>
      ) : null}
    </>
  )
}
