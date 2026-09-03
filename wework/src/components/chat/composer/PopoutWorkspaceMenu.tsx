import { Check, ChevronDown, Ellipsis, Folder, Search, ShieldCheck } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'

import { DshContributionSlotSurface } from '@/features/dsh-runtime/DshContributionSlotSurface'
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import { useAnchoredPortalMenu } from '@/hooks/useAnchoredPortalMenu'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { ProjectWithTasks } from '@/types/api'
import { useOutsideClick } from './useOutsideClick'

interface PopoutWorkspaceMenuProps {
  currentProjectId?: number
  disabled?: boolean
  extensionContext?: object
  projectName?: string | null
  projects: ProjectWithTasks[]
  onSelectProject: (projectId: number | null) => void
}

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
  currentProjectId,
  disabled = false,
  extensionContext = {},
  projectName,
  projects,
  onSelectProject,
}: PopoutWorkspaceMenuProps) {
  const { t } = useTranslation('common')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const submenuRef = useRef<HTMLDivElement>(null)
  const projectRowRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [projectSubmenuOpen, setProjectSubmenuOpen] = useState(false)
  const [projectQuery, setProjectQuery] = useState('')
  const closeMenu = useCallback(() => {
    setOpen(false)
    setProjectSubmenuOpen(false)
    setProjectQuery('')
  }, [])
  const outsideRefs = useMemo(() => [triggerRef, submenuRef], [])
  const menuLayout = useAnchoredPortalMenu(open, triggerRef, menuRef)
  const submenuLayout = useAnchoredPortalMenu(projectSubmenuOpen, projectRowRef, submenuRef, {
    align: 'end',
    gap: 6,
    placement: 'prefer-below',
  })

  useOutsideClick(menuRef, open, closeMenu, outsideRefs)

  useEffect(() => {
    if (!open) return undefined

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (projectSubmenuOpen) {
        setProjectSubmenuOpen(false)
        return
      }
      closeMenu()
      triggerRef.current?.focus()
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [closeMenu, open, projectSubmenuOpen])

  const filteredProjects = projects.filter(project =>
    project.name.toLocaleLowerCase().includes(projectQuery.trim().toLocaleLowerCase())
  )

  const projectSubmenu = (
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
  )

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
                active={projectSubmenuOpen}
                icon={Folder}
                label={t('workbench.popout_workspace_menu_project')}
                rowRef={projectRowRef}
                testId="popout-workspace-project-button"
                value={projectName || t('workbench.popout_workspace_menu_no_project')}
                onClick={() => setProjectSubmenuOpen(value => !value)}
              />
              <DshContributionSlotSurface
                attachedClassName="contents"
                props={{ closeMenu, context: extensionContext }}
                slot={WEWORK_DSH_SLOTS.workspaceMenuSection}
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
            {projectSubmenuOpen ? (
              <div
                ref={submenuRef}
                role="menu"
                data-testid="popout-workspace-project-submenu"
                className="fixed z-[1001] w-72 overflow-y-auto rounded-2xl border border-border/70 bg-background p-2 shadow-[0_12px_32px_rgba(0,0,0,0.14)]"
                style={{
                  left: submenuLayout?.left ?? 0,
                  maxHeight: submenuLayout?.maxHeight,
                  top: submenuLayout?.top ?? 0,
                  visibility: submenuLayout ? 'visible' : 'hidden',
                }}
              >
                {projectSubmenu}
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
          setProjectSubmenuOpen(false)
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
