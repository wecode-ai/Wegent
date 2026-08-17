import { Upload, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'

const MAX_PLUGIN_PACKAGE_SIZE_BYTES = 50 * 1024 * 1024

export function PluginUploadDialog({
  isUploading,
  uploadError = null,
  onCancel,
  onErrorReset,
  onUpload,
}: {
  isUploading: boolean
  uploadError?: string | null
  onCancel: () => void
  onErrorReset?: () => void
  onUpload: (file: File) => Promise<void>
}) {
  const { t } = useTranslation('common')
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState('')
  const visibleError = error || uploadError

  const selectFile = (nextFile: File | null) => {
    setError('')
    onErrorReset?.()
    if (!nextFile) {
      setFile(null)
      return
    }
    if (!nextFile.name?.toLowerCase().endsWith('.zip')) {
      setError(t('workbench.plugins_plugin_upload_zip_error', '请选择 .zip 插件包'))
      setFile(null)
      return
    }
    if (nextFile.size > MAX_PLUGIN_PACKAGE_SIZE_BYTES) {
      setError(t('workbench.plugins_plugin_upload_size_error', '插件安装包不能超过 50MB'))
      setFile(null)
      return
    }
    setFile(nextFile)
  }

  return (
    <div className="plugin-dialog-overlay fixed inset-0 z-modal flex items-center justify-center px-4">
      <form
        data-testid="plugin-upload-dialog"
        className="plugin-dialog-surface w-full max-w-[480px] p-5"
        onSubmit={event => {
          event.preventDefault()
          if (!file) {
            setError(t('workbench.plugins_plugin_upload_select_file', '请先选择插件包'))
            return
          }
          onUpload(file).catch(uploadError => {
            setError(
              uploadError instanceof Error
                ? uploadError.message
                : t('workbench.plugins_plugin_upload_failed', '插件上传失败')
            )
          })
        }}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="heading-subsection">
              {t('workbench.plugins_plugin_upload_title', '上传 Claude Code 插件')}
            </h2>
            <p className="mt-1 text-sm text-text-secondary">
              {t(
                'workbench.plugins_plugin_upload_description',
                '选择包含 .codex-plugin/plugin.json 的 ZIP 包。'
              )}
            </p>
          </div>
          <button
            type="button"
            aria-label={t('workbench.plugins_uninstall_cancel', '取消')}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-text-muted hover:bg-surface"
            onClick={onCancel}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <label className="mt-5 flex min-h-36 cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-border/45 bg-surface px-4 text-center transition-colors hover:border-focus/60 focus-within:border-focus/70 focus-within:ring-2 focus-within:ring-focus/15">
          <Upload className="h-8 w-8 text-text-secondary" />
          <span className="mt-3 text-sm font-medium">
            {file ? file.name : t('workbench.plugins_plugin_upload_drop_title', '选择插件 ZIP 包')}
          </span>
          <span className="mt-1 text-xs text-text-muted">
            {t('workbench.plugins_plugin_upload_hint', '支持 Claude Code 插件 ZIP，最大 50MB')}
          </span>
          <input
            type="file"
            accept=".zip,application/zip"
            data-testid="plugin-upload-file-input"
            className="sr-only"
            onChange={event => selectFile(event.target.files?.[0] ?? null)}
          />
        </label>

        {visibleError && <p className="mt-3 text-sm font-medium text-red-500">{visibleError}</p>}

        <div className="mt-5 flex justify-end gap-3">
          <button
            type="button"
            className="h-9 rounded-lg border border-border/30 px-4 text-sm font-medium hover:bg-surface"
            onClick={onCancel}
          >
            {t('workbench.plugins_uninstall_cancel', '取消')}
          </button>
          <button
            type="submit"
            data-testid="plugin-upload-confirm-button"
            disabled={isUploading}
            className="h-9 rounded-lg bg-text-primary px-4 text-sm font-medium text-background hover:bg-text-primary/90 disabled:opacity-50"
          >
            {isUploading
              ? t('workbench.plugins_plugin_uploading', '上传中')
              : t('workbench.plugins_skill_upload_confirm', '上传')}
          </button>
        </div>
      </form>
    </div>
  )
}
