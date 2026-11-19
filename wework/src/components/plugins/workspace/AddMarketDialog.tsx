import { useTranslation } from '@/hooks/useTranslation'
import { DialogSurface } from '@wegent/collaboration/controls/DialogSurface'
import { TextField as ControlInput } from '@wegent/collaboration/controls/TextField'
import { Textarea as ControlTextarea } from '@wegent/collaboration/controls/Textarea'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { X } from 'lucide-react'
import type { FormEvent } from 'react'
import { useRef } from 'react'
import { isMarketplaceSourceValid, type AddMarketFormData } from './marketplaceWorkspaceHelpers'

export function AddMarketDialog({
  isOpen,
  isSubmitting,
  formData,
  onClose,
  onChange,
  onSubmit,
}: {
  isOpen: boolean
  isSubmitting: boolean
  formData: AddMarketFormData
  onClose: () => void
  onChange: (data: AddMarketFormData) => void
  onSubmit: (event: FormEvent) => void
}) {
  const { t } = useTranslation('common')
  const sourceInputRef = useRef<HTMLInputElement>(null)
  const sourceIsValid = isMarketplaceSourceValid(formData.source)
  const sourceError = Boolean(formData.source.trim()) && !sourceIsValid

  if (!isOpen) return null

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    if (!sourceIsValid) {
      event.preventDefault()
      sourceInputRef.current?.focus()
      return
    }
    onSubmit(event)
  }

  return (
    <div
      className="plugin-dialog-overlay fixed inset-0 z-50 flex items-center justify-center p-6"
      onClick={() => {
        if (!isSubmitting) onClose()
      }}
    >
      <DialogSurface
        initialFocus={() => sourceInputRef.current}
        finalFocus={() =>
          document.querySelector<HTMLElement>('[data-testid="plugins-create-button"]')
        }
        onClose={() => {
          if (!isSubmitting) onClose()
        }}
        render={
          <div
            aria-labelledby="plugins-marketplace-dialog-title"
            tabIndex={-1}
            data-testid="plugins-marketplace-dialog"
            className="plugin-dialog-surface max-h-[88vh] w-full max-w-[600px] overflow-y-auto"
            onClick={event => event.stopPropagation()}
          />
        }
      >
        <div className="plugin-dialog-divider flex items-start justify-between gap-6 border-b px-6 py-5">
          <div className="min-w-0">
            <h2
              id="plugins-marketplace-dialog-title"
              className="heading-subsection text-text-primary"
            >
              {t('workbench.plugins_add_market', '添加插件市场')}
            </h2>
            <p className="mt-1 text-sm leading-5 text-text-secondary">
              {t(
                'workbench.plugins_add_market_description',
                '从 GitHub 仓库、Git URL 或本地文件夹添加。'
              )}{' '}
              <a
                href="https://developers.openai.com/plugins/build/plugins"
                target="_blank"
                rel="noreferrer"
                className="font-medium text-focus hover:underline wework:text-blue-600"
              >
                {t('common.learn_more', '了解更多')}
              </a>
            </p>
          </div>
          <ControlButton
            variant="unstyled"
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            data-testid="plugins-marketplace-close-button"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-surface hover:text-text-primary focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/20 disabled:opacity-50"
            aria-label={t('common.close', '关闭')}
          >
            <X className="h-4 w-4" />
          </ControlButton>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="space-y-5 px-6 py-[22px]">
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-text-primary">
                {t('workbench.plugins_market_source', '来源')}
              </span>
              <ControlInput
                ref={sourceInputRef}
                type="text"
                required
                autoComplete="off"
                aria-invalid={sourceError}
                aria-describedby="plugins-marketplace-source-note"
                data-testid="plugins-marketplace-path-input"
                value={formData.source}
                onChange={event => onChange({ ...formData, source: event.target.value })}
                placeholder="openai/plugins 或 git@github.com:org/repo.git"
                className={[
                  'w-full transition-colors placeholder:text-text-muted',
                  sourceError
                    ? 'border-destructive/70 focus:border-destructive focus:ring-destructive/15 wework:border-red-500/70 wework:focus:border-red-500 wework:focus:ring-red-500/15'
                    : '',
                ].join('')}
              />
              <span
                id="plugins-marketplace-source-note"
                className={[
                  'mt-1.5 block text-xs leading-4',
                  sourceError ? 'text-destructive wework:text-red-600' : 'text-text-muted',
                ].join(' ')}
              >
                {sourceError
                  ? t(
                      'workbench.plugins_market_source_invalid',
                      '请输入 GitHub 简写、Git URL 或本地目录。'
                    )
                  : t(
                      'workbench.plugins_market_source_hint',
                      '支持 GitHub 简写、HTTPS/SSH Git URL 或本地目录。'
                    )}
              </span>
            </label>

            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-text-primary">
                {t('workbench.plugins_market_git_ref', 'Git 引用')}
              </span>
              <ControlInput
                type="text"
                autoComplete="off"
                data-testid="plugins-marketplace-git-ref-input"
                value={formData.gitRef}
                onChange={event => onChange({ ...formData, gitRef: event.target.value })}
                placeholder={t('workbench.plugins_market_git_ref_placeholder', '主分支')}
                className="h-10 w-full transition-colors placeholder:text-text-muted"
              />
            </label>

            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-text-primary">
                {t('workbench.plugins_market_sparse_path', '稀疏路径')}
              </span>
              <ControlTextarea
                data-testid="plugins-marketplace-sparse-path-input"
                value={formData.subPath}
                onChange={event => onChange({ ...formData, subPath: event.target.value })}
                placeholder="plugins/codex"
                className="min-h-[78px] w-full resize-y rounded-lg border border-border/45 bg-background px-3 py-2.5 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted keyboard:focus:border-focus/70 keyboard:focus:ring-2 keyboard:focus:ring-focus/15"
              />
            </label>
          </div>

          <div className="plugin-dialog-divider flex justify-end gap-[9px] border-t px-6 py-4">
            <ControlButton
              variant="outline"
              size="sm"
              type="button"
              data-testid="plugins-marketplace-cancel-button"
              onClick={onClose}
              disabled={isSubmitting}
              className="h-9 rounded-lg border border-border/30 bg-surface px-4 text-sm font-medium text-text-primary transition-colors hover:bg-muted disabled:opacity-50"
            >
              {t('common.cancel', '取消')}
            </ControlButton>
            <ControlButton
              variant="primary"
              size="sm"
              type="submit"
              data-testid="plugins-marketplace-save-button"
              disabled={isSubmitting || !sourceIsValid}
              className="h-9 rounded-lg bg-text-primary px-4 text-sm font-medium text-background transition-colors hover:bg-text-primary/90 disabled:opacity-50"
            >
              {isSubmitting
                ? t('workbench.plugins_adding_market', '添加中...')
                : t('workbench.plugins_confirm_add_market', '添加市场')}
            </ControlButton>
          </div>
        </form>
      </DialogSurface>
    </div>
  )
}
