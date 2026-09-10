// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState, type ReactNode } from 'react'

export interface ProjectSpaceSidebarNavItem {
  icon?: ReactNode
  label: string
  onClick(): void
  selected?: boolean
  testId?: string
}

export interface ProjectSpaceSidebarProject {
  canManage: boolean
  count?: number
  icon: ReactNode
  id: string
  key: string
  name: string
  selected: boolean
  onArchive(): void
  onCopyId(): Promise<void>
  onRename(): void
}

interface ProjectSpaceSidebarTooltipOptions {
  align: 'end'
  children: ReactNode
  className?: string
  label: string
  side: 'bottom'
}

interface ProjectSpaceSidebarLabels {
  actions: string
  archive: string
  copied: string
  copyId: string
  rename: string
}

interface ProjectSpaceSidebarProps {
  account?: ReactNode
  addIcon: ReactNode
  addLabel: string
  checkIcon: ReactNode
  copyIcon: ReactNode
  header: ReactNode
  labels: ProjectSpaceSidebarLabels
  moreIcon: ReactNode
  navItems: ProjectSpaceSidebarNavItem[]
  onAdd(): void
  onSelectProject(projectKey: string): void
  projects: ProjectSpaceSidebarProject[]
  renderTooltip?(options: ProjectSpaceSidebarTooltipOptions): ReactNode
  sectionLabel: string
}

export function ProjectSpaceSidebar({
  account,
  addIcon,
  addLabel,
  checkIcon,
  copyIcon,
  header,
  labels,
  moreIcon,
  navItems,
  onAdd,
  onSelectProject,
  projects,
  renderTooltip,
  sectionLabel,
}: ProjectSpaceSidebarProps) {
  const [openProjectId, setOpenProjectId] = useState<string | null>(null)
  const [copiedProjectId, setCopiedProjectId] = useState<string | null>(null)

  useEffect(() => {
    if (openProjectId === null) return

    const closeOnOutsideClick = (event: MouseEvent) => {
      if (
        event.target instanceof Element &&
        !event.target.closest('[data-cloud-project-menu-root]')
      ) {
        setOpenProjectId(null)
      }
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenProjectId(null)
    }

    document.addEventListener('mousedown', closeOnOutsideClick)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [openProjectId])

  const copyProjectId = (project: ProjectSpaceSidebarProject) => {
    void project.onCopyId().then(() => {
      setCopiedProjectId(project.id)
      window.setTimeout(() => setCopiedProjectId(null), 2000)
    })
    setOpenProjectId(null)
  }

  const addButton = (
    <button
      type="button"
      data-testid="cloud-project-add"
      onClick={onAdd}
      className="h-6 w-6 rounded-md hover:bg-muted"
      aria-label={addLabel}
      title={renderTooltip ? undefined : addLabel}
    >
      {addIcon}
    </button>
  )

  const renderProjectMoreButton = (project: ProjectSpaceSidebarProject) => {
    const button = (
      <button
        type="button"
        data-testid={`cloud-sidebar-project-more-${project.id}`}
        onClick={() => setOpenProjectId(current => (current === project.id ? null : project.id))}
        className="hidden h-7 w-7 shrink-0 items-center justify-center rounded-md text-[rgb(var(--color-sidebar-text-muted))] transition hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))] focus:flex group-hover:flex"
        aria-expanded={openProjectId === project.id}
        aria-label={labels.actions}
        title={renderTooltip ? undefined : labels.actions}
      >
        {moreIcon}
      </button>
    )

    return renderTooltip
      ? renderTooltip({
          align: 'end',
          children: button,
          label: labels.actions,
          side: 'bottom',
        })
      : button
  }

  return (
    <div className="flex h-full w-[240px] flex-col px-1.5 pt-1.5">
      {header}
      <nav className="space-y-0.5">
        {navItems.map(item => (
          <button
            type="button"
            data-testid={item.testId}
            aria-current={item.selected ? 'page' : undefined}
            key={item.testId ?? item.label}
            onClick={item.onClick}
            className={
              item.selected
                ? 'flex h-[30px] w-full items-center gap-2 rounded-[10px] bg-[rgb(var(--color-sidebar-active))] px-2 text-left text-base leading-5 text-text-primary'
                : 'flex h-[30px] w-full items-center gap-2 rounded-[10px] px-2 text-left text-base leading-5 text-[rgb(var(--color-sidebar-text-primary))] hover:bg-[rgb(var(--color-sidebar-hover))]'
            }
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
      <div className="mt-6 flex h-[30px] items-center px-2.5 text-xs font-medium text-[rgb(var(--color-sidebar-text-muted))] opacity-75">
        {sectionLabel}
        {renderTooltip ? (
          renderTooltip({
            align: 'end',
            children: addButton,
            className: 'ml-auto',
            label: addLabel,
            side: 'bottom',
          })
        ) : (
          <span className="ml-auto inline-flex">{addButton}</span>
        )}
      </div>
      <div className="mt-2 min-h-0 flex-1 overflow-y-auto">
        {projects.map(project => (
          <div
            key={project.key}
            data-cloud-project-menu-root
            className={
              project.selected
                ? 'group relative flex h-[30px] w-full items-center rounded-[10px] bg-[rgb(var(--color-sidebar-active))] px-0 text-base leading-5 text-text-primary'
                : 'group relative flex h-[30px] w-full items-center rounded-[10px] px-0 text-base leading-5 text-[rgb(var(--color-sidebar-text-primary))] hover:bg-[rgb(var(--color-sidebar-hover))]'
            }
          >
            <button
              type="button"
              data-testid={`cloud-sidebar-project-${project.id}`}
              onClick={() => onSelectProject(project.key)}
              className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-md px-2.5 text-base"
            >
              {project.icon}
              <span className="min-w-0 flex-1 truncate text-left">{project.name}</span>
            </button>
            {project.count ? (
              <span className="flex h-7 w-7 shrink-0 items-center justify-center text-xs text-[rgb(var(--color-sidebar-text-muted))] group-hover:hidden">
                {project.count}
              </span>
            ) : null}
            {renderProjectMoreButton(project)}
            {openProjectId === project.id ? (
              <div
                data-testid={`cloud-sidebar-project-menu-${project.id}`}
                role="menu"
                className="absolute right-0 top-8 z-30 w-36 rounded-lg border border-border bg-background p-1 shadow-md"
              >
                {project.canManage ? (
                  <>
                    <button
                      type="button"
                      data-testid={`cloud-sidebar-rename-project-${project.id}`}
                      onClick={() => {
                        project.onRename()
                        setOpenProjectId(null)
                      }}
                      role="menuitem"
                      className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-xs text-text-secondary hover:bg-muted"
                    >
                      <span className="w-3.5 text-center" aria-hidden="true">
                        Aa
                      </span>
                      {labels.rename}
                    </button>
                    <button
                      type="button"
                      data-testid={`cloud-sidebar-archive-project-${project.id}`}
                      onClick={() => {
                        project.onArchive()
                        setOpenProjectId(null)
                      }}
                      role="menuitem"
                      className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-xs text-red-600 hover:bg-muted"
                    >
                      <span className="w-3.5 text-center" aria-hidden="true">
                        ×
                      </span>
                      {labels.archive}
                    </button>
                  </>
                ) : null}
                <button
                  type="button"
                  data-testid={`cloud-sidebar-copy-project-id-${project.id}`}
                  onClick={() => copyProjectId(project)}
                  role="menuitem"
                  className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-xs text-text-secondary hover:bg-muted"
                >
                  {copiedProjectId === project.id ? checkIcon : copyIcon}
                  {copiedProjectId === project.id ? labels.copied : labels.copyId}
                </button>
              </div>
            ) : null}
          </div>
        ))}
      </div>
      {account}
    </div>
  )
}
