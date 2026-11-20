import { FolderOpen, Globe2, X } from 'lucide-react'
import { createPortal } from 'react-dom'

import { Tooltip } from '@/components/ui/tooltip'

import type { useDesktopSidebarModel } from './useDesktopSidebarModel'
export function DesktopSidebarProjectCreateMenu({
  t,
  onOpenStandaloneFolderProject,
  setStandaloneRemoteDialogIntent,
  setStandaloneWorkspaceDialogMode,
  projectCreateDialogOpen,
  setProjectCreateDialogOpen,
  projectCreateDialogRef,
}: ReturnType<typeof useDesktopSidebarModel>['projectCreateMenu']) {
  return (
    <>
      {projectCreateDialogOpen &&
        createPortal(
          <div
            data-testid="project-create-dialog-overlay"
            className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4"
            onClick={event => {
              if (event.target === event.currentTarget) setProjectCreateDialogOpen(false)
            }}
          >
            <div
              ref={projectCreateDialogRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="project-create-dialog-title"
              data-testid="projects-create-button-menu"
              className="w-full max-w-[520px] rounded-2xl border border-border bg-popover p-5 text-text-primary shadow-2xl"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 id="project-create-dialog-title" className="heading-base">
                    {t('workbench.create_project_title', '创建项目')}
                  </h2>
                  <p className="mt-2 text-sm leading-5 text-text-secondary">
                    {t(
                      'workbench.create_project_description',
                      '选择项目运行的位置。之后可以在项目中切换工作目录。'
                    )}
                  </p>
                </div>
                <Tooltip
                  label={t('workbench.close_dialog', '关闭')}
                  testId="close-project-source-dialog-tooltip"
                >
                  <button
                    type="button"
                    data-testid="close-project-source-dialog"
                    aria-label={t('workbench.close_dialog', '关闭')}
                    onClick={() => setProjectCreateDialogOpen(false)}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-muted"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </Tooltip>
              </div>
              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  data-testid="project-create-local-option"
                  onClick={() => {
                    setProjectCreateDialogOpen(false)
                    if (onOpenStandaloneFolderProject) {
                      onOpenStandaloneFolderProject('existing')
                    } else {
                      setStandaloneWorkspaceDialogMode('existing')
                    }
                  }}
                  className="rounded-xl border border-border bg-background p-4 text-left hover:bg-muted focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-primary/30"
                >
                  <FolderOpen className="h-5 w-5 text-text-primary" />
                  <span className="mt-3 block text-base font-medium">
                    {t('workbench.local_project', '本地项目')}
                  </span>
                  <span className="mt-1 block text-sm leading-5 text-text-secondary">
                    {t('workbench.local_project_description', '选择一个或多个本地文件夹。')}
                  </span>
                </button>
                <button
                  type="button"
                  data-testid="project-create-remote-option"
                  onClick={() => {
                    setProjectCreateDialogOpen(false)
                    if (onOpenStandaloneFolderProject) {
                      onOpenStandaloneFolderProject('remote', 'project')
                    } else {
                      setStandaloneRemoteDialogIntent('project')
                      setStandaloneWorkspaceDialogMode('remote')
                    }
                  }}
                  className="rounded-xl border border-border bg-background p-4 text-left hover:bg-muted focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-primary/30"
                >
                  <Globe2 className="h-5 w-5 text-text-primary" />
                  <span className="mt-3 block text-base font-medium">
                    {t('workbench.cloud_project', '云端项目')}
                  </span>
                  <span className="mt-1 block text-sm leading-5 text-text-secondary">
                    {t('workbench.cloud_project_description', '使用云设备或远程主机上的项目目录。')}
                  </span>
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  )
}
