import { ActionMenu } from '../controls/ActionMenu'
import { Button as ControlButton } from '../markdown/Button'
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
  actionsAvailable?: boolean
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
  sectionOnly?: boolean
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
  sectionOnly = false,
  sectionLabel,
}: ProjectSpaceSidebarProps) {
  const [copiedProjectId, setCopiedProjectId] = useState<string | null>(null)

  useEffect(() => {
    if (copiedProjectId === null) return
    const timer = window.setTimeout(() => setCopiedProjectId(null), 2000)
    return () => window.clearTimeout(timer)
  }, [copiedProjectId])

  const copyProjectId = async (project: ProjectSpaceSidebarProject) => {
    await project.onCopyId()
    setCopiedProjectId(project.id)
  }
  const primaryTextClass = sectionOnly
    ? 'text-text-primary'
    : 'text-[rgb(var(--color-sidebar-text-primary))]'
  const secondaryTextClass = sectionOnly
    ? 'text-text-secondary'
    : 'text-[rgb(var(--color-sidebar-text-secondary))]'
  const hoverBackgroundClass = sectionOnly
    ? 'hover:bg-hover'
    : 'hover:bg-[rgb(var(--color-sidebar-hover))]'
  const hoverPrimaryTextClass = sectionOnly
    ? 'hover:text-text-primary'
    : 'hover:text-[rgb(var(--color-sidebar-text-primary))]'
  const activeBackgroundClass = sectionOnly ? 'bg-hover' : 'bg-[rgb(var(--color-sidebar-active))]'

  const addButton = (
    <ControlButton
      variant="unstyled"
      type="button"
      data-testid="cloud-project-add"
      onClick={onAdd}
      className="h-6 w-6 rounded-md hover:bg-muted"
      aria-label={addLabel}
      title={renderTooltip ? undefined : addLabel}
    >
      {addIcon}
    </ControlButton>
  )

  const renderProjectMoreButton = (project: ProjectSpaceSidebarProject) => (
    <ActionMenu
      ariaLabel={labels.actions}
      testId={'cloud-sidebar-project-more-' + project.id}
      menuTestId={'cloud-sidebar-project-menu-' + project.id}
      triggerLabel={moreIcon}
      density="dense"
      triggerClassName={`hidden shrink-0 items-center justify-center rounded-md p-0 transition group-focus-within:flex group-hover:flex ${secondaryTextClass} ${hoverBackgroundClass} ${hoverPrimaryTextClass}`}
      items={[
        ...(project.canManage
          ? [
              {
                testId: 'cloud-sidebar-rename-project-' + project.id,
                label: labels.rename,
                onSelect: project.onRename,
              },
              {
                testId: 'cloud-sidebar-archive-project-' + project.id,
                label: labels.archive,
                danger: true,
                onSelect: project.onArchive,
              },
            ]
          : []),
        {
          testId: 'cloud-sidebar-copy-project-id-' + project.id,
          label: (
            <>
              {copiedProjectId === project.id ? checkIcon : copyIcon}
              {copiedProjectId === project.id ? labels.copied : labels.copyId}
            </>
          ),
          onSelect: () => copyProjectId(project),
        },
      ]}
    />
  )

  return (
    <div className={sectionOnly ? 'w-full' : 'flex h-full w-[240px] flex-col px-1.5 pt-1.5'}>
      {!sectionOnly ? header : null}
      {!sectionOnly ? (
        <nav className="space-y-0.5">
          {navItems.map(item => (
            <ControlButton
              variant="unstyled"
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
            </ControlButton>
          ))}
        </nav>
      ) : null}
      <div
        className={`${sectionOnly ? '' : 'mt-6 '}flex h-[30px] items-center px-2.5 text-xs font-medium ${secondaryTextClass}`}
      >
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
                ? `group relative flex h-[30px] w-full items-center rounded-[10px] px-0 text-base leading-5 ${activeBackgroundClass} ${primaryTextClass}`
                : `group relative flex h-[30px] w-full items-center rounded-[10px] px-0 text-base leading-5 ${primaryTextClass} ${hoverBackgroundClass}`
            }
          >
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid={`cloud-sidebar-project-${project.id}`}
              onClick={() => onSelectProject(project.key)}
              className={`flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-md px-2.5 text-base ${primaryTextClass}`}
            >
              {project.icon}
              <span className="min-w-0 flex-1 truncate text-left">{project.name}</span>
            </ControlButton>
            {project.count ? (
              <span
                className={`flex h-7 w-7 shrink-0 items-center justify-center text-xs group-focus-within:hidden group-hover:hidden ${secondaryTextClass}`}
              >
                {project.count}
              </span>
            ) : null}
            {project.actionsAvailable !== false ? renderProjectMoreButton(project) : null}
          </div>
        ))}
      </div>
      {!sectionOnly ? account : null}
    </div>
  )
}
