import {
  Check,
  ChevronDown,
  Ellipsis,
  Folder,
  GitBranch,
  Search,
  ShieldCheck,
  Workflow,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { ProjectExecutionMode, ProjectWithTasks } from '@/types/api'
import { useAnchoredPortalMenu } from './useAnchoredPortalMenu'
import { useOutsideClick } from './useOutsideClick'

type WorkspaceSubmenu = 'project' | 'launchMode' | 'branch'

interface PopoutWorkspaceMenuProps {
  branchName?: string | null
  currentProjectId?: number
  disabled?: boolean
  executionMode: ProjectExecutionMode
  executionModeLocked?: boolean
  isGitProject?: boolean
  projectName?: string | null
  projects: ProjectWithTasks[]
  onCheckoutBranch?: (branchName: string) => Promise<void>
  onExecutionModeChange: (mode: ProjectExecutionMode) => void
  onListBranches?: () => Promise<string[]>
  onSelectProject: (projectId: number | null) => void
}

const SUBMENU_GAP = 6

interface WorkspaceActionRowProps {
  active: boolean
  icon: typeof Folder
  label: string
  onClick: () => void
  rowRef: RefObject<HTMLButtonElement | null>
  testId: string
  value: string
}

function WorkspaceActionRow({
  active,
  icon: Icon,
  label,
  onClick,
  rowRef,
  testId,
  value,
}: WorkspaceActionRowProps) {
  return (
    <button
      ref={rowRef}
      type="button"
      role="menuitem"
      data-testid={testId}
      className={cn(
        'flex min-h-11 w-full items-center justify-between gap-4 rounded-lg px-3 text-sm font-normal hover:bg-muted',
        active && 'bg-muted'
      )}
      onClick={onClick}
    >
      <span className="text-text-primary">{label}</span>
      <span className="flex min-w-0 items-center gap-2 text-text-primary">
        <Icon className="h-4 w-4 shrink-0" />
        <span className="max-w-40 truncate">{value}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-text-secondary" />
      </span>
    </button>
  )
}

export function PopoutWorkspaceMenu({
  branchName,
  currentProjectId,
  disabled = false,
  executionMode,
  executionModeLocked = false,
  isGitProject = false,
  projectName,
  projects,
  onCheckoutBranch,
  onExecutionModeChange,
  onListBranches,
  onSelectProject,
}: PopoutWorkspaceMenuProps) {
  const { t } = useTranslation('common')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const submenuRef = useRef<HTMLDivElement>(null)
  const projectRowRef = useRef<HTMLButtonElement>(null)
  const launchModeRowRef = useRef<HTMLButtonElement>(null)
  const branchRowRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [submenu, setSubmenu] = useState<WorkspaceSubmenu | null>(null)
  const [projectQuery, setProjectQuery] = useState('')
  const [branchQuery, setBranchQuery] = useState('')
  const [branches, setBranches] = useState<string[]>([])
  const [branchesLoading, setBranchesLoading] = useState(false)
  const closeMenu = useCallback(() => {
    setOpen(false)
    setSubmenu(null)
    setProjectQuery('')
    setBranchQuery('')
  }, [])
  const outsideRefs = useMemo(() => [triggerRef, submenuRef], [])
  const menuLayout = useAnchoredPortalMenu(open, triggerRef, menuRef)
  const submenuAnchorRef =
    submenu === 'project'
      ? projectRowRef
      : submenu === 'launchMode'
        ? launchModeRowRef
        : branchRowRef
  const submenuLayout = useAnchoredPortalMenu(submenu !== null, submenuAnchorRef, submenuRef, {
    align: 'end',
    gap: SUBMENU_GAP,
    placement: 'prefer-below',
  })

  useOutsideClick(menuRef, open, closeMenu, outsideRefs)

  useEffect(() => {
    if (!open) return undefined

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (submenu) {
        setSubmenu(null)
        return
      }
      closeMenu()
      triggerRef.current?.focus()
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [closeMenu, open, submenu])

  const filteredProjects = projects.filter(project =>
    project.name.toLocaleLowerCase().includes(projectQuery.trim().toLocaleLowerCase())
  )
  const availableBranches = Array.from(
    new Set([branchName, ...branches].filter(Boolean))
  ) as string[]
  const filteredBranches = availableBranches.filter(branch =>
    branch.toLocaleLowerCase().includes(branchQuery.trim().toLocaleLowerCase())
  )
  const toggleSubmenu = (nextSubmenu: WorkspaceSubmenu) => {
    const opening = submenu !== nextSubmenu
    setSubmenu(opening ? nextSubmenu : null)
    if (nextSubmenu !== 'project') setProjectQuery('')
    if (nextSubmenu !== 'branch') setBranchQuery('')
    if (opening && nextSubmenu === 'branch' && onListBranches) {
      setBranchesLoading(true)
      void onListBranches()
        .then(setBranches)
        .catch(() => setBranches([]))
        .finally(() => setBranchesLoading(false))
    }
  }

  const submenuContent =
    submenu === 'project' ? (
      <>
        <label className="mx-2 mb-1 flex h-9 items-center gap-2 rounded-lg border border-border/70 px-2 text-text-secondary focus-within:border-focus">
          <Search className="h-4 w-4 shrink-0" />
          <input
            data-testid="popout-workspace-project-search"
            value={projectQuery}
            onChange={event => setProjectQuery(event.target.value)}
            className="min-w-0 flex-1 bg-transparent text-sm font-normal text-text-primary outline-none placeholder:text-text-muted"
            placeholder={t('workbench.search_projects', '搜索项目')}
          />
        </label>
        <div className="max-h-60 overflow-y-auto">
          {filteredProjects.map(project => (
            <button
              key={project.id}
              type="button"
              role="menuitemradio"
              aria-checked={currentProjectId === project.id}
              data-testid={`popout-workspace-project-option-${project.id}`}
              className="flex min-h-10 w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-normal text-text-primary hover:bg-muted"
              onClick={() => {
                onSelectProject(project.id)
                closeMenu()
              }}
            >
              <Folder className="h-4 w-4 shrink-0 text-text-secondary" />
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
              {currentProjectId === project.id ? <Check className="h-4 w-4 shrink-0" /> : null}
            </button>
          ))}
        </div>
        <div className="my-1 border-t border-border/60" />
        <button
          type="button"
          role="menuitemradio"
          aria-checked={currentProjectId == null}
          data-testid="popout-workspace-no-project-option"
          className="flex min-h-10 w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-normal text-text-primary hover:bg-muted"
          onClick={() => {
            onSelectProject(null)
            closeMenu()
          }}
        >
          <Folder className="h-4 w-4 shrink-0 text-text-secondary" />
          <span className="min-w-0 flex-1">{t('workbench.popout_workspace_menu_no_project')}</span>
          {currentProjectId == null ? <Check className="h-4 w-4 shrink-0" /> : null}
        </button>
      </>
    ) : submenu === 'launchMode' ? (
      <>
        {(
          [
            ['current_workspace', t('workbench.popout_workspace_menu_current_workspace')],
            ['git_worktree', t('workbench.popout_workspace_menu_worktree')],
          ] as const
        ).map(([mode, label]) => {
          const modeDisabled =
            executionModeLocked || (mode === 'git_worktree' && (!projectName || !isGitProject))
          return (
            <button
              key={mode}
              type="button"
              role="menuitemradio"
              aria-checked={executionMode === mode}
              disabled={modeDisabled}
              data-testid={`popout-workspace-launch-mode-${mode}`}
              className="flex min-h-10 w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-normal text-text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-45"
              onClick={() => {
                onExecutionModeChange(mode)
                closeMenu()
              }}
            >
              <Workflow className="h-4 w-4 shrink-0 text-text-secondary" />
              <span className="min-w-0 flex-1">{label}</span>
              {executionMode === mode ? <Check className="h-4 w-4 shrink-0" /> : null}
            </button>
          )
        })}
      </>
    ) : submenu === 'branch' ? (
      <>
        <label className="mx-2 mb-1 flex h-9 items-center gap-2 rounded-lg border border-border/70 px-2 text-text-secondary focus-within:border-focus">
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
                  void onCheckoutBranch?.(branch).catch(error => {
                    console.error('[Wework] Failed to checkout Popout Window branch', error)
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
      </>
    ) : null

  const portal =
    open && typeof document !== 'undefined'
      ? createPortal(
          <>
            <div
              ref={menuRef}
              role="menu"
              data-testid="popout-workspace-menu"
              aria-label={t('workbench.popout_workspace_menu')}
              className="fixed z-[1000] w-80 rounded-2xl border border-border/70 bg-background p-2 shadow-[0_12px_32px_rgba(0,0,0,0.14)]"
              style={{
                left: menuLayout?.left ?? 0,
                maxHeight: menuLayout?.maxHeight,
                top: menuLayout?.top ?? 0,
                visibility: menuLayout ? 'visible' : 'hidden',
              }}
            >
              <WorkspaceActionRow
                active={submenu === 'project'}
                icon={Folder}
                label={t('workbench.popout_workspace_menu_project')}
                rowRef={projectRowRef}
                testId="popout-workspace-project-button"
                value={projectName || t('workbench.popout_workspace_menu_no_project')}
                onClick={() => toggleSubmenu('project')}
              />
              <WorkspaceActionRow
                active={submenu === 'launchMode'}
                icon={Workflow}
                label={t('workbench.popout_workspace_menu_launch_mode')}
                rowRef={launchModeRowRef}
                testId="popout-workspace-launch-mode-button"
                value={
                  executionMode === 'git_worktree'
                    ? t('workbench.popout_workspace_menu_worktree')
                    : t('workbench.popout_workspace_menu_current_workspace')
                }
                onClick={() => toggleSubmenu('launchMode')}
              />
              <WorkspaceActionRow
                active={submenu === 'branch'}
                icon={GitBranch}
                label={t('workbench.popout_workspace_menu_branch')}
                rowRef={branchRowRef}
                testId="popout-workspace-branch-button"
                value={branchName || t('workbench.popout_workspace_menu_no_branch')}
                onClick={() => toggleSubmenu('branch')}
              />
              <div className="my-1 border-t border-border/60" />
              <div className="flex min-h-11 items-center justify-between gap-4 px-3 text-sm font-normal">
                <span className="text-text-primary">
                  {t('workbench.popout_workspace_menu_permission')}
                </span>
                <span className="flex min-w-0 items-center gap-2 text-warning">
                  <ShieldCheck className="h-4 w-4 shrink-0" />
                  <span>{t('workbench.popout_workspace_menu_full_access')}</span>
                </span>
              </div>
            </div>
            {submenu && submenuContent ? (
              <div
                ref={submenuRef}
                role="menu"
                data-testid={`popout-workspace-${submenu}-submenu`}
                className="fixed z-[1001] w-72 overflow-y-auto rounded-2xl border border-border/70 bg-background p-2 shadow-[0_12px_32px_rgba(0,0,0,0.14)]"
                style={{
                  left: submenuLayout?.left ?? 0,
                  maxHeight: submenuLayout?.maxHeight,
                  top: submenuLayout?.top ?? 0,
                  visibility: submenuLayout ? 'visible' : 'hidden',
                }}
              >
                {submenuContent}
              </div>
            ) : null}
          </>,
          document.body
        )
      : null

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid="composer-project-menu-button"
        onClick={() => {
          setSubmenu(null)
          setOpen(current => !current)
        }}
        disabled={disabled}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
        aria-label={t('workbench.popout_workspace_menu')}
        aria-expanded={open}
        aria-haspopup="menu"
        title={t('workbench.popout_workspace_menu')}
      >
        <Ellipsis className="h-4 w-4" />
      </button>
      {portal}
    </>
  )
}
