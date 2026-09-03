import { Check, ChevronDown, GitBranch, Search, Workflow } from 'lucide-react'
import { useState } from 'react'

import { useTranslation } from '@/hooks/useTranslation'
import { isGitWorkspaceProject } from '@/lib/projectClassification'
import { cn } from '@/lib/utils'
import type { ProjectWorktreeAvailability } from '@/lib/worktree-availability'
import type { ProjectWithTasks } from '@/types/api'

interface GitWorkspaceContext {
  branchName?: string
  currentProject?: ProjectWithTasks | null
  executionMode: string
  executionModeLocked?: boolean
  onCheckoutBranch?: (branchName: string) => Promise<void>
  onExecutionModeChange: (mode: string) => void
  onListBranches?: () => Promise<string[]>
  worktreeAvailability?: ProjectWorktreeAvailability
  worktreeBranch?: string | null
}

interface GitWorkspaceMenuSectionProps {
  closeMenu: () => void
  context: GitWorkspaceContext
}

type OpenSection = 'launch-mode' | 'branch' | null

function unavailableMessageKey(reason: ProjectWorktreeAvailability['reason']): string | null {
  if (reason === 'available') return null
  return `workbench.worktree_unavailable_${reason}`
}

export default function GitWorkspaceMenuSection({
  closeMenu,
  context,
}: GitWorkspaceMenuSectionProps) {
  const { t } = useTranslation('common')
  const [openSection, setOpenSection] = useState<OpenSection>(null)
  const [branchQuery, setBranchQuery] = useState('')
  const [branches, setBranches] = useState<string[]>([])
  const [branchesLoading, setBranchesLoading] = useState(false)
  const branchName = context.worktreeBranch ?? context.branchName ?? ''
  const projectSupportsWorktrees = Boolean(
    context.currentProject && isGitWorkspaceProject(context.currentProject)
  )
  const availability =
    context.worktreeAvailability ??
    (projectSupportsWorktrees
      ? {
          available: false,
          reason: 'preflight_pending' as const,
          deviceId: null,
          sourcePath: null,
        }
      : {
          available: false,
          reason: 'not_git' as const,
          deviceId: null,
          sourcePath: null,
        })
  const messageKey = unavailableMessageKey(availability.reason)
  const availableBranches = Array.from(new Set([branchName, ...branches].filter(Boolean)))
  const filteredBranches = availableBranches.filter(branch =>
    branch.toLocaleLowerCase().includes(branchQuery.trim().toLocaleLowerCase())
  )

  const toggleBranchSection = () => {
    const opening = openSection !== 'branch'
    setOpenSection(opening ? 'branch' : null)
    setBranchQuery('')
    if (!opening || !context.onListBranches) return
    setBranchesLoading(true)
    void context
      .onListBranches()
      .then(setBranches)
      .catch(() => setBranches([]))
      .finally(() => setBranchesLoading(false))
  }

  return (
    <>
      <button
        type="button"
        role="menuitem"
        data-testid="popout-workspace-launch-mode-button"
        className={cn(
          'flex min-h-11 w-full items-center justify-between gap-4 rounded-lg px-3 text-sm font-normal hover:bg-muted',
          openSection === 'launch-mode' && 'bg-muted'
        )}
        onClick={() =>
          setOpenSection(current => (current === 'launch-mode' ? null : 'launch-mode'))
        }
      >
        <span className="text-text-primary">
          {t('workbench.popout_workspace_menu_launch_mode')}
        </span>
        <span className="flex min-w-0 items-center gap-2 text-text-primary">
          <Workflow className="h-4 w-4 shrink-0" />
          <span className="max-w-40 truncate">
            {context.executionMode === 'git_worktree'
              ? t('workbench.popout_workspace_menu_worktree')
              : t('workbench.popout_workspace_menu_current_workspace')}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-text-secondary" />
        </span>
      </button>
      {openSection === 'launch-mode' ? (
        <div
          role="menu"
          data-testid="popout-workspace-launch-mode-submenu"
          className="mx-2 mb-1 rounded-xl border border-border/60 bg-background p-1"
        >
          {(
            [
              ['current_workspace', t('workbench.popout_workspace_menu_current_workspace')],
              ['git_worktree', t('workbench.popout_workspace_menu_worktree')],
            ] as const
          ).map(([mode, label]) => {
            const disabled =
              context.executionModeLocked || (mode === 'git_worktree' && !availability.available)
            return (
              <button
                key={mode}
                type="button"
                role="menuitemradio"
                aria-checked={context.executionMode === mode}
                disabled={disabled}
                data-testid={`popout-workspace-launch-mode-${mode}`}
                className="flex min-h-10 w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-normal text-text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-45"
                onClick={() => {
                  context.onExecutionModeChange(mode)
                  closeMenu()
                }}
              >
                <Workflow className="h-4 w-4 shrink-0 text-text-secondary" />
                <span className="min-w-0 flex-1">{label}</span>
                {context.executionMode === mode ? <Check className="h-4 w-4 shrink-0" /> : null}
              </button>
            )
          })}
          {messageKey ? (
            <p
              data-testid="popout-workspace-worktree-unavailable-reason"
              className="px-3 pt-1 text-xs leading-4 text-text-muted"
              role="status"
            >
              {t(messageKey)}
            </p>
          ) : null}
        </div>
      ) : null}
      <button
        type="button"
        role="menuitem"
        data-testid="popout-workspace-branch-button"
        className={cn(
          'flex min-h-11 w-full items-center justify-between gap-4 rounded-lg px-3 text-sm font-normal hover:bg-muted',
          openSection === 'branch' && 'bg-muted'
        )}
        onClick={toggleBranchSection}
      >
        <span className="text-text-primary">{t('workbench.popout_workspace_menu_branch')}</span>
        <span className="flex min-w-0 items-center gap-2 text-text-primary">
          <GitBranch className="h-4 w-4 shrink-0" />
          <span className="max-w-40 truncate">
            {branchName || t('workbench.popout_workspace_menu_no_branch')}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-text-secondary" />
        </span>
      </button>
      {openSection === 'branch' ? (
        <div
          role="menu"
          data-testid="popout-workspace-branch-submenu"
          className="mx-2 mb-1 rounded-xl border border-border/60 bg-background p-1"
        >
          <label className="mb-1 flex h-9 items-center gap-2 rounded-lg border border-border/70 px-2 text-text-secondary focus-within:border-focus">
            <Search className="h-4 w-4 shrink-0" />
            <input
              data-testid="popout-workspace-branch-search"
              value={branchQuery}
              onChange={event => setBranchQuery(event.target.value)}
              className="min-w-0 flex-1 bg-transparent text-sm font-normal text-text-primary outline-none placeholder:text-text-muted"
              placeholder={t('workbench.environment_branch_search', '搜索分支')}
            />
          </label>
          <div className="max-h-60 overflow-y-auto">
            {branchesLoading ? (
              <div className="px-3 py-2 text-sm font-normal text-text-secondary">
                {t('loading', '加载中…')}
              </div>
            ) : (
              filteredBranches.map(branch => (
                <button
                  key={branch}
                  type="button"
                  role="menuitemradio"
                  aria-checked={branchName === branch}
                  data-testid={`popout-workspace-branch-option-${branch}`}
                  className="flex min-h-10 w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-normal text-text-primary hover:bg-muted"
                  onClick={() => {
                    void context.onCheckoutBranch?.(branch).catch(error => {
                      console.error('[Wework Git] Failed to checkout branch', error)
                    })
                    closeMenu()
                  }}
                >
                  <GitBranch className="h-4 w-4 shrink-0 text-text-secondary" />
                  <span className="min-w-0 flex-1 truncate">{branch}</span>
                  {branchName === branch ? <Check className="h-4 w-4 shrink-0" /> : null}
                </button>
              ))
            )}
          </div>
        </div>
      ) : null}
    </>
  )
}
