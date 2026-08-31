import { FolderOpen, Loader2, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from '@/hooks/useTranslation'
import { openNativeDirectoryPicker } from '@/lib/native-directory-picker'

export interface SmartAppDevelopmentInput {
  parentPath: string
  name: string
  displayName: string
  description: string
}

interface SmartAppDevelopmentDialogProps {
  mode: 'create' | 'copy'
  initialDisplayName?: string
  onClose: () => void
  onSubmit: (input: SmartAppDevelopmentInput) => Promise<void>
}

function smartAppSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

export function SmartAppDevelopmentDialog({
  mode,
  initialDisplayName = '',
  onClose,
  onSubmit,
}: SmartAppDevelopmentDialogProps) {
  const { t } = useTranslation('common')
  const [displayName, setDisplayName] = useState(initialDisplayName)
  const [name, setName] = useState(() => smartAppSlug(initialDisplayName))
  const [nameEdited, setNameEdited] = useState(false)
  const [description, setDescription] = useState('')
  const [parentPath, setParentPath] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const valid = useMemo(
    () => Boolean(displayName.trim() && name.trim() && parentPath.trim()),
    [displayName, name, parentPath]
  )

  useEscapeKey(onClose, !submitting)

  async function chooseDirectory() {
    const selected = await openNativeDirectoryPicker()
    if (selected) {
      setParentPath(selected)
      setError(null)
    }
  }

  async function submit() {
    if (!valid || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      await onSubmit({
        parentPath: parentPath.trim(),
        name: name.trim(),
        displayName: displayName.trim(),
        description: description.trim(),
      })
      onClose()
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value))
    } finally {
      setSubmitting(false)
    }
  }

  const title =
    mode === 'create'
      ? t('workbench.smart_apps_create_title', '创建空白工作台')
      : t('workbench.smart_apps_copy_title', '复制为我的工作台')

  return createPortal(
    <div className="plugin-dialog-overlay fixed inset-0 z-modal flex items-end justify-center sm:items-center sm:p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="smart-app-development-title"
        data-testid="smart-app-development-dialog"
        className="plugin-dialog-surface w-full max-w-xl p-5"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="smart-app-development-title" className="heading-small">
              {title}
            </h2>
            <p className="mt-1 text-sm text-text-secondary">
              {mode === 'create'
                ? t(
                    'workbench.smart_apps_create_description',
                    '从 Web 预设创建可直接运行和持续开发的本地目录。'
                  )
                : t(
                    'workbench.smart_apps_copy_description',
                    '市场版本保持不变，副本将成为独立、可编辑的本地工作台。'
                  )}
            </p>
          </div>
          <button
            type="button"
            aria-label={t('common.close', '关闭')}
            data-testid="smart-app-development-close"
            disabled={submitting}
            onClick={onClose}
            className="flex h-11 w-11 items-center justify-center rounded-md text-text-secondary hover:bg-muted disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-5 grid gap-4">
          <label className="grid gap-1.5 text-sm text-text-secondary">
            <span>{t('workbench.smart_apps_display_name', '工作台名称')}</span>
            <input
              autoFocus
              data-testid="smart-app-development-display-name"
              value={displayName}
              disabled={submitting}
              onChange={event => {
                const value = event.target.value
                setDisplayName(value)
                if (!nameEdited) setName(smartAppSlug(value))
                setError(null)
              }}
              className="h-9 rounded-lg border border-border/50 bg-background px-3 text-sm text-text-primary outline-none focus:border-focus focus:ring-2 focus:ring-focus/15"
            />
          </label>

          <label className="grid gap-1.5 text-sm text-text-secondary">
            <span>{t('workbench.smart_apps_directory_name', '目录标识')}</span>
            <input
              data-testid="smart-app-development-name"
              value={name}
              disabled={submitting}
              onChange={event => {
                setNameEdited(true)
                setName(smartAppSlug(event.target.value))
                setError(null)
              }}
              className="h-9 rounded-lg border border-border/50 bg-background px-3 font-mono text-sm text-text-primary outline-none focus:border-focus focus:ring-2 focus:ring-focus/15"
            />
          </label>

          <label className="grid gap-1.5 text-sm text-text-secondary">
            <span>{t('workbench.smart_apps_parent_directory', '保存位置')}</span>
            <div className="flex gap-2">
              <input
                data-testid="smart-app-development-parent-path"
                value={parentPath}
                disabled={submitting}
                placeholder={t(
                  'workbench.smart_apps_parent_directory_placeholder',
                  '选择父目录或粘贴绝对路径'
                )}
                onChange={event => {
                  setParentPath(event.target.value)
                  setError(null)
                }}
                className="h-9 min-w-0 flex-1 rounded-lg border border-border/50 bg-background px-3 font-mono text-sm text-text-primary outline-none focus:border-focus focus:ring-2 focus:ring-focus/15"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                data-testid="smart-app-development-choose-directory"
                disabled={submitting}
                onClick={() => void chooseDirectory()}
              >
                <FolderOpen className="h-4 w-4" />
                {t('workbench.smart_apps_choose_directory', '选择')}
              </Button>
            </div>
          </label>

          {mode === 'create' ? (
            <label className="grid gap-1.5 text-sm text-text-secondary">
              <span>{t('workbench.smart_apps_description', '用途说明')}</span>
              <textarea
                data-testid="smart-app-development-description"
                value={description}
                disabled={submitting}
                rows={3}
                onChange={event => setDescription(event.target.value)}
                className="resize-none rounded-lg border border-border/50 bg-background px-3 py-2 text-sm text-text-primary outline-none focus:border-focus focus:ring-2 focus:ring-focus/15"
              />
            </label>
          ) : null}

          <div className="rounded-lg border border-border/50 bg-surface/30 px-3 py-2 text-xs text-text-secondary">
            {t(
              'workbench.smart_apps_web_preset_hint',
              '预设：DeepSeek Harness Web。创建后可反复使用开发助手添加插件或修改工作台代码。'
            )}
          </div>
        </div>

        {error ? (
          <p role="alert" className="mt-3 text-sm text-danger">
            {error}
          </p>
        ) : null}

        <div className="mt-6 flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            data-testid="smart-app-development-cancel"
            disabled={submitting}
            onClick={onClose}
          >
            {t('common.cancel', '取消')}
          </Button>
          <Button
            type="button"
            data-testid="smart-app-development-confirm"
            disabled={!valid || submitting}
            onClick={() => void submit()}
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {mode === 'create'
              ? t('workbench.smart_apps_create_and_develop', '创建并开发')
              : t('workbench.smart_apps_copy_and_develop', '复制并开发')}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  )
}
