import { SelectField } from '@wegent/collaboration/controls/SelectField'
import { Folder, GitBranch, Workflow } from 'lucide-react'

import { WorktreeBranchSelector } from '@/components/chat/composer/WorktreeBranchSelector'
import { BranchSelector } from '@/components/common/BranchSelector'
import { useTranslation } from '@/hooks/useTranslation'
import { isGitWorkspaceProject } from '@/lib/projectClassification'
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
        {context.executionModeLocked ? (
          <div
            data-testid="execution-mode-button"
            role="status"
            className="flex min-h-11 items-center gap-1.5 px-2.5 text-sm text-text-primary md:min-h-7"
          >
            {worktreeSelected ? <Workflow className="h-4 w-4" /> : <Folder className="h-4 w-4" />}
            <span>{modeLabel}</span>
          </div>
        ) : (
          <SelectField
            testId="execution-mode-button"
            menuTestId="project-execution-mode-menu"
            appearance="composer"
            triggerContent={
              <>
                {worktreeSelected ? (
                  <Workflow aria-hidden="true" className="h-4 w-4 shrink-0" />
                ) : (
                  <Folder aria-hidden="true" className="h-4 w-4 shrink-0" />
                )}
                <span className="min-w-0 truncate">{modeLabel}</span>
              </>
            }
            accessibleLabel={t('workbench.execution_mode_label', '执行方式')}
            value={worktreeSelected ? 'git_worktree' : 'current_workspace'}
            onChange={mode => {
              if (
                !context.executionModeLocked &&
                (mode !== 'git_worktree' || worktreeAvailability.available)
              )
                context.onExecutionModeChange(mode)
            }}
            options={[
              {
                value: 'current_workspace',
                label: t('workbench.execution_mode_current_workspace'),
                icon: <Folder className="h-4 w-4" />,
                testId: 'execution-mode-current-workspace-button',
              },
              {
                value: 'git_worktree',
                label: t('workbench.execution_mode_git_worktree'),
                icon: <Workflow className="h-4 w-4" />,
                disabled: !worktreeAvailability.available,
                testId: 'execution-mode-git-worktree-button',
              },
            ]}
            footer={
              !worktreeAvailability.available ? (
                <p
                  data-testid="execution-mode-worktree-unavailable-reason"
                  className="px-2 py-1 text-xs text-text-secondary"
                  role="status"
                >
                  {t(`workbench.worktree_unavailable_${worktreeAvailability.reason}`)}
                </p>
              ) : undefined
            }
          />
        )}
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
