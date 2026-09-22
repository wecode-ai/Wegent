import * as Popover from '@radix-ui/react-popover'
import { ChevronRight } from 'lucide-react'
import { Fragment, useState } from 'react'
import type { MenuPosition } from '@/components/common/ActionMenu'
import { workspaceFileBreadcrumbs } from './workspaceFileBreadcrumbModel'
import type { WorkspaceFileApi, WorkspaceFileEntry, WorkspaceTarget } from '@/types/workspace-files'
import { WorkspaceDirectoryPicker } from './WorkspaceDirectoryPicker'

export function WorkspaceFileBreadcrumbs({
  path,
  isDirectory,
  target,
  api,
  onSelect,
  onFileContextMenu,
}: {
  path: string
  isDirectory: boolean
  target: WorkspaceTarget
  api: WorkspaceFileApi
  onSelect: (entry: WorkspaceFileEntry) => void
  onFileContextMenu: (path: string, position: MenuPosition) => void
}) {
  const { prefix, crumbs } = workspaceFileBreadcrumbs(path, target.path, isDirectory)
  const [openPath, setOpenPath] = useState<string | null>(null)
  return (
    <div className="flex min-w-0 flex-row-reverse overflow-x-auto scrollbar-none">
      <div className="flex w-max shrink-0 items-center">
        <span className="sr-only">{prefix}</span>
        {crumbs.map((crumb, index) => {
          const file = index === crumbs.length - 1 && !isDirectory
          return (
            <Fragment key={crumb.path}>
              {index > 0 && (
                <>
                  <span className="sr-only">{crumbs[index - 1].path.endsWith('/') ? '' : '/'}</span>
                  <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
                </>
              )}
              <Popover.Root
                open={openPath === crumb.path}
                onOpenChange={open =>
                  setOpenPath(current =>
                    open ? crumb.path : current === crumb.path ? null : current
                  )
                }
              >
                <Popover.Trigger asChild>
                  <button
                    type="button"
                    data-testid={
                      file
                        ? 'workspace-file-name-button'
                        : `workspace-file-breadcrumb-${crumb.path}`
                    }
                    title={crumb.path}
                    onContextMenu={event => {
                      if (!file) {
                        event.preventDefault()
                        event.stopPropagation()
                      }
                    }}
                    onKeyDown={event => {
                      if (
                        !file &&
                        (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))
                      ) {
                        event.preventDefault()
                        event.stopPropagation()
                      }
                    }}
                    className="flex h-7 shrink-0 items-center whitespace-nowrap rounded px-1 text-sm hover:bg-muted data-[state=open]:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                  >
                    <span
                      className={
                        file
                          ? 'font-medium text-text-primary'
                          : index === 0
                            ? 'text-text-primary'
                            : undefined
                      }
                    >
                      {crumb.label}
                    </span>
                  </button>
                </Popover.Trigger>
                <Popover.Portal>
                  <Popover.Content
                    data-testid={
                      file ? 'workspace-file-siblings-menu' : 'workspace-file-directory-menu'
                    }
                    aria-label={crumb.path}
                    align="start"
                    sideOffset={1}
                    collisionPadding={8}
                    className="z-popover h-80 max-h-[var(--radix-popover-content-available-height)] w-80 max-w-[calc(100vw-1rem)] rounded-lg border border-border bg-popover p-1 text-text-primary shadow-sm outline-none"
                    onInteractOutside={event => {
                      if (
                        event.target instanceof Element &&
                        event.target.closest(
                          '[data-testid="workspace-file-context-menu"], [data-testid="workspace-file-open-with-submenu"]'
                        )
                      )
                        event.preventDefault()
                    }}
                  >
                    <WorkspaceDirectoryPicker
                      directoryPath={crumb.directoryPath}
                      activePath={crumb.activePath}
                      expandActive={crumb.expandActive}
                      target={target}
                      api={api}
                      onSelect={entry => {
                        setOpenPath(null)
                        onSelect(entry)
                      }}
                      onFileContextMenu={onFileContextMenu}
                    />
                  </Popover.Content>
                </Popover.Portal>
              </Popover.Root>
            </Fragment>
          )
        })}
      </div>
    </div>
  )
}
