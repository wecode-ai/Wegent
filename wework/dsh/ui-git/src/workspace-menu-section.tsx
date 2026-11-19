import { SearchableSelect } from '@wegent/collaboration/controls/SearchableSelect'
import { SelectField } from '@wegent/collaboration/controls/SelectField'
import { Button } from '@wegent/collaboration/markdown/Button'
import { GitBranch, Workflow } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { isGitWorkspaceProject } from '@/lib/projectClassification'
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

function unavailableMessageKey(reason: ProjectWorktreeAvailability['reason']): string | null {
  if (reason === 'available') return null
  return `workbench.worktree_unavailable_${reason}`
}

export default function GitWorkspaceMenuSection({
  closeMenu,
  context,
}: GitWorkspaceMenuSectionProps) {
  const { t } = useTranslation('common')
  const [branches, setBranches] = useState<string[]>([])
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [branchesError, setBranchesError] = useState<string | null>(null)
  const [checkoutError, setCheckoutError] = useState<string | null>(null)
  const [checkingOut, setCheckingOut] = useState(false)
  const request = useRef(0)
  const attachMenu = useCallback((node: HTMLDivElement | null) => {
    if (!node) return
    return () => {
      request.current += 1
    }
  }, [])
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
  const modeOptions = [
    {
      value: 'current_workspace',
      label: t('workbench.popout_workspace_menu_current_workspace'),
      disabled: context.executionModeLocked,
      testId: 'popout-workspace-launch-mode-current_workspace',
    },
    {
      value: 'git_worktree',
      label: t('workbench.popout_workspace_menu_worktree'),
      disabled: context.executionModeLocked || !availability.available,
      testId: 'popout-workspace-launch-mode-git_worktree',
    },
  ]

  const loadBranches = async () => {
    if (!context.onListBranches) return
    const revision = ++request.current
    setBranchesLoading(true)
    setBranchesError(null)
    try {
      const next = await context.onListBranches()
      if (request.current === revision) setBranches(next)
    } catch (cause) {
      if (request.current === revision)
        setBranchesError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (request.current === revision) setBranchesLoading(false)
    }
  }

  const checkout = async (branch: string) => {
    if (!context.onCheckoutBranch || checkingOut) return
    setCheckingOut(true)
    setCheckoutError(null)
    try {
      await context.onCheckoutBranch(branch)
      closeMenu()
    } catch (cause) {
      setCheckoutError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setCheckingOut(false)
    }
  }

  return (
    <div ref={attachMenu} className="space-y-2 px-1">
      <SelectField
        accessibleLabel={t('workbench.popout_workspace_menu_launch_mode')}
        testId="popout-workspace-launch-mode-button"
        menuTestId="popout-workspace-launch-mode-submenu"
        value={context.executionMode}
        options={modeOptions.map(option => ({
          ...option,
          icon: <Workflow className="h-4 w-4 shrink-0" aria-hidden="true" />,
        }))}
        onChange={mode => {
          if (!modeOptions.some(option => option.value === mode && !option.disabled)) return
          context.onExecutionModeChange(mode)
          closeMenu()
        }}
        className="w-full"
        footer={
          messageKey ? (
            <p
              data-testid="popout-workspace-worktree-unavailable-reason"
              className="px-2 py-1 text-xs text-text-secondary"
              role="status"
            >
              {t(messageKey)}
            </p>
          ) : undefined
        }
      />
      <SearchableSelect
        accessibleLabel={t('workbench.popout_workspace_menu_branch')}
        testId="popout-workspace-branch-button"
        menuTestId="popout-workspace-branch-submenu"
        searchTestId="popout-workspace-branch-search"
        value={branchName}
        disabled={!context.onCheckoutBranch || checkingOut}
        options={availableBranches.map(branch => ({
          value: branch,
          label: branch,
          icon: <GitBranch className="h-4 w-4 shrink-0" aria-hidden="true" />,
          testId: 'popout-workspace-branch-option-' + branch,
        }))}
        onChange={branch => {
          void checkout(branch)
        }}
        onOpenChange={open => {
          if (open) void loadBranches()
        }}
        searchPlaceholder={t('workbench.environment_branch_search', '搜索分支')}
        emptyLabel={t('workbench.popout_workspace_menu_no_branch')}
        searchStatus={
          branchesLoading ? (
            <p role="status" className="px-2 py-1 text-sm text-text-secondary">
              {t('loading', '加载中…')}
            </p>
          ) : branchesError ? (
            <p role="alert" className="px-2 py-1 text-sm text-destructive">
              {branchesError}
            </p>
          ) : undefined
        }
        footer={
          branchesError ? (
            <Button
              variant="ghost"
              data-testid="popout-workspace-branch-retry"
              onClick={() => {
                void loadBranches()
              }}
            >
              {t('retry', '重试')}
            </Button>
          ) : undefined
        }
        className="w-full"
      />
      {checkoutError && (
        <p
          role="alert"
          data-testid="popout-workspace-branch-error"
          className="px-2 text-sm text-destructive"
        >
          {checkoutError}
        </p>
      )}
    </div>
  )
}
