import { Folder, Loader2, X } from 'lucide-react'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { DialogForm } from '@/components/common/DialogForm'
import { useDialogKeyboard } from '@/hooks/useDialogKeyboard'
import { useTranslation } from '@/hooks/useTranslation'
import type { ProjectWithTasks } from '@/types/api'

interface ExistingLocalProjectImportDialogProps {
  open: boolean
  projects: ProjectWithTasks[]
  onClose: () => void
  onImport: (project: ProjectWithTasks) => Promise<void>
}

function projectPath(project: ProjectWithTasks): string | null {
  return project.config?.workspace?.source === 'local_path'
    ? (project.config.workspace.localPath ?? null)
    : null
}

export function ExistingLocalProjectImportDialog({
  open,
  projects,
  onClose,
  onImport,
}: ExistingLocalProjectImportDialogProps) {
  const { t } = useTranslation('common')
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(projects[0]?.id ?? null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useDialogKeyboard<HTMLFormElement>(() => {
    if (!submitting) onClose()
  })

  if (!open) return null

  const selectedProject =
    projects.find(project => project.id === selectedProjectId) ?? projects[0] ?? null
  const importProject = async () => {
    if (!selectedProject || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      await onImport(selectedProject)
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : String(importError))
    } finally {
      setSubmitting(false)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4">
      <DialogForm
        aria-labelledby="existing-local-project-import-title"
        aria-modal="true"
        className="w-full max-w-lg rounded-2xl border border-border bg-popover p-5 text-text-primary shadow-2xl"
        data-testid="existing-local-project-import-dialog"
        onSubmit={event => {
          event.preventDefault()
          void importProject()
        }}
        ref={dialogRef}
        role="dialog"
      >
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="heading-base" id="existing-local-project-import-title">
              {t('workbench.import_existing_local_project', '导入已有项目')}
            </h2>
            <p className="mt-1 text-sm text-text-secondary">
              {t(
                'workbench.import_existing_local_project_description',
                '选择任务中已有、但尚未加入本地协作空间的项目。'
              )}
            </p>
          </div>
          <button
            aria-label={t('workbench.close_dialog', '关闭')}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-muted disabled:opacity-50"
            data-testid="close-existing-local-project-import-dialog"
            disabled={submitting}
            onClick={onClose}
            type="button"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {projects.length > 0 ? (
          <div className="mt-5 max-h-80 space-y-1 overflow-y-auto">
            {projects.map(project => {
              const path = projectPath(project)
              const selected = selectedProject?.id === project.id
              return (
                <button
                  aria-pressed={selected}
                  className={`flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-left ${
                    selected ? 'border-text-primary bg-muted' : 'border-transparent hover:bg-muted'
                  }`}
                  data-testid={`existing-local-project-option-${project.id}`}
                  key={project.id}
                  onClick={() => {
                    setSelectedProjectId(project.id)
                    setError(null)
                  }}
                  type="button"
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-background text-text-secondary">
                    <Folder className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-base font-medium">{project.name}</span>
                    {path ? (
                      <span
                        className="mt-0.5 block truncate text-sm text-text-secondary"
                        title={path}
                      >
                        {path}
                      </span>
                    ) : null}
                  </span>
                </button>
              )
            })}
          </div>
        ) : (
          <div
            className="mt-5 rounded-xl border border-border bg-background px-4 py-8 text-center text-sm text-text-secondary"
            data-testid="existing-local-project-import-empty"
          >
            {t(
              'workbench.no_existing_local_projects_to_import',
              '任务中的本地项目都已加入协作空间。'
            )}
          </div>
        )}

        {error ? <p className="mt-3 text-sm text-red-500">{error}</p> : null}

        <div className="mt-5 flex justify-end gap-3">
          <button
            className="h-9 rounded-lg border border-border px-4 text-sm font-medium text-text-primary hover:bg-muted disabled:opacity-50"
            disabled={submitting}
            onClick={onClose}
            type="button"
          >
            {t('workbench.cancel', '取消')}
          </button>
          <button
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-text-primary px-4 text-sm font-medium text-background hover:bg-text-primary/90 disabled:opacity-50"
            data-testid="confirm-existing-local-project-import"
            disabled={!selectedProject || submitting}
            type="submit"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {t('workbench.add_to_collaboration', '加入协作')}
          </button>
        </div>
      </DialogForm>
    </div>,
    document.body
  )
}
