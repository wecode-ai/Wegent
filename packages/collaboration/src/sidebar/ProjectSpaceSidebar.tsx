import { Button as ControlButton } from '../markdown/Button'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../controls/MenuParts'
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useState, type ReactNode } from 'react'

export interface ProjectSpaceSidebarNavItem {
  icon?: ReactNode
  label: string
  onClick(): void
  selected?: boolean
  testId?: string
}

export interface ProjectSpaceSidebarProject {
  actionsAvailable?: boolean
  archiveDisabled?: boolean
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

  const copyProjectId = (project: ProjectSpaceSidebarProject) => {
    void project.onCopyId().then(() => {
      setCopiedProjectId(project.id)
      window.setTimeout(() => setCopiedProjectId(null), 2000)
    })
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

  const renderProjectMoreButton = (project: ProjectSpaceSidebarProject) => {
    const button = (
      <MenuTrigger
        render={<button type="button" />}
        data-testid={`cloud-sidebar-project-more-${project.id}`}
        className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md opacity-0 transition focus:opacity-100 group-hover:opacity-100 aria-expanded:opacity-100 ${secondaryTextClass} ${hoverBackgroundClass} ${hoverPrimaryTextClass}`}
        aria-label={labels.actions}
        title={renderTooltip ? undefined : labels.actions}
      >
        {moreIcon}
      </MenuTrigger>
    )

    const trigger = renderTooltip
      ? renderTooltip({
          align: 'end',
          children: button,
          label: labels.actions,
          side: 'bottom',
        })
      : button
    return (
      <Menu>
        {trigger}
        <MenuContent
          data-testid={`cloud-sidebar-project-menu-${project.id}`}
          align="end"
          aria-label={labels.actions}
          className="w-36"
        >
          {project.canManage ? (
            <>
              <MenuItem
                data-testid={`cloud-sidebar-rename-project-${project.id}`}
                onSelect={project.onRename}
              >
                <span className="w-3.5 text-center" aria-hidden="true">
                  Aa
                </span>
                {labels.rename}
              </MenuItem>
              <MenuItem
                destructive
                data-testid={`cloud-sidebar-archive-project-${project.id}`}
                disabled={project.archiveDisabled}
                onSelect={project.onArchive}
              >
                <span className="w-3.5 text-center" aria-hidden="true">
                  ×
                </span>
                {labels.archive}
              </MenuItem>
            </>
          ) : null}
          <MenuItem
            data-testid={`cloud-sidebar-copy-project-id-${project.id}`}
            onSelect={() => copyProjectId(project)}
          >
            {copiedProjectId === project.id ? checkIcon : copyIcon}
            {copiedProjectId === project.id ? labels.copied : labels.copyId}
          </MenuItem>
        </MenuContent>
      </Menu>
    )
  }

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
                className={`flex h-7 w-7 shrink-0 items-center justify-center text-xs group-hover:hidden ${secondaryTextClass}`}
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
