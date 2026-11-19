import { Tooltip } from '@/components/ui/tooltip'
import { useTranslation } from '@/hooks/useTranslation'
import { SelectField } from '@wegent/collaboration/controls/SelectField'
import { TextField as ControlInput } from '@wegent/collaboration/controls/TextField'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { Check, Maximize2, Plus, X } from 'lucide-react'
import { useState } from 'react'

export function BoardQuickCreate({
  columnKey,
  columnLabel,
  localProjects,
  localProjectId,
  onLocalProjectChange,
  onCancel,
  onCreate,
  onOpenFull,
}: {
  columnKey: string
  columnLabel: string
  localProjects?: Array<{ id: number; name: string }>
  localProjectId?: number | null
  onLocalProjectChange?: (projectId: number) => void
  onCancel: () => void
  onCreate: (content: string) => Promise<void>
  onOpenFull: (content: string) => void
}) {
  const { t } = useTranslation('common')
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    const trimmedContent = content.trim()
    if (!trimmedContent || busy) return
    setBusy(true)
    setError(null)
    try {
      await onCreate(trimmedContent)
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t('todo.quick_create_failed', '创建任务失败，请重试')
      )
      setBusy(false)
    }
  }

  return (
    <form
      data-testid={`cloud-todo-column-quick-create-${columnKey}`}
      className="shrink-0 px-2 pb-2"
      onSubmit={event => {
        event.preventDefault()
        void submit()
      }}
    >
      <div className="rounded-xl border border-border bg-background p-2 shadow-sm">
        <label className="flex items-center gap-2">
          <Plus className="h-4 w-4 shrink-0 text-text-muted" />
          <span className="sr-only">
            {t('todo.new_task_in_column', '在{{column}}中新建任务', {
              column: columnLabel,
            })}
          </span>
          <ControlInput
            density="compact"
            appearance="plain"
            autoFocus
            data-testid={`cloud-todo-column-quick-create-input-${columnKey}`}
            value={content}
            disabled={busy}
            onChange={event => {
              setContent(event.target.value)
              setError(null)
            }}
            onKeyDown={event => {
              if (event.key === 'Escape') {
                event.preventDefault()
                onCancel()
              }
            }}
            placeholder={t('todo.quick_create_placeholder', '输入事项内容')}
            className="min-w-0 flex-1 placeholder:text-text-muted disabled:opacity-60"
          />
        </label>
        {error ? (
          <p
            data-testid={`cloud-todo-column-quick-create-error-${columnKey}`}
            className="mt-1 px-6 text-xs text-destructive"
            role="alert"
          >
            {error}
          </p>
        ) : null}
        <div className="mt-1 flex items-center justify-between pl-6">
          {localProjects?.length && localProjectId && onLocalProjectChange ? (
            <SelectField
              testId={'cloud-todo-column-quick-create-project-' + columnKey}
              accessibleLabel={t('todo.local_project_filter', '本地项目')}
              value={String(localProjectId)}
              onChange={value => onLocalProjectChange(Number(value))}
              options={localProjects.map(project => ({
                value: String(project.id),
                label: project.name,
              }))}
              triggerContent={
                <span className="truncate">
                  {t('todo.project_with_name', '项目：{{project}}', {
                    project:
                      localProjects.find(project => project.id === localProjectId)?.name ?? '',
                  })}
                </span>
              }
              className="max-w-40"
            />
          ) : (
            <span />
          )}
          <span className="flex items-center gap-1">
            <Tooltip label={t('todo.quick_create_full_mode', '完整模式')} side="top" align="end">
              <ControlButton
                variant="unstyled"
                type="button"
                data-testid={`cloud-todo-column-quick-create-full-${columnKey}`}
                disabled={busy}
                onClick={() => onOpenFull(content.trim())}
                className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-muted hover:text-text-primary disabled:opacity-50"
                aria-label={t('todo.quick_create_full_mode', '完整模式')}
              >
                <Maximize2 className="h-3.5 w-3.5" />
              </ControlButton>
            </Tooltip>
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid={`cloud-todo-column-quick-create-cancel-${columnKey}`}
              disabled={busy}
              onClick={onCancel}
              className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-muted hover:text-text-primary disabled:opacity-50"
              aria-label={t('common.cancel', '取消')}
            >
              <X className="h-3.5 w-3.5" />
            </ControlButton>
            <ControlButton
              variant="primary"
              size="sm"
              type="submit"
              data-testid={`cloud-todo-column-quick-create-confirm-${columnKey}`}
              disabled={!content.trim() || busy}
              className="flex h-7 w-7 items-center justify-center rounded-md bg-text-primary text-background hover:opacity-90 disabled:opacity-40"
              aria-label={
                busy ? t('todo.creating', '创建中…') : t('todo.quick_create_confirm', '创建任务')
              }
            >
              <Check className="h-3.5 w-3.5" />
            </ControlButton>
          </span>
        </div>
      </div>
    </form>
  )
}
