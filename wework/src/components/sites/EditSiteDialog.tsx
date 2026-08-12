import { FormEvent, useEffect, useRef, useState } from 'react'
import { Loader2, Pencil } from 'lucide-react'
import type { Site } from '@/api/sites'
import { useTranslation } from '@/hooks/useTranslation'

interface EditSiteDialogProps {
  site: Site
  loading: boolean
  error: string | null
  onCancel: () => void
  onConfirm: (input: { title: string; customDomainPrefix: string | null }) => void
}

export function EditSiteDialog({ site, loading, error, onCancel, onConfirm }: EditSiteDialogProps) {
  const { t } = useTranslation('sites')
  const titleInputRef = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState(site.name)
  const [customDomainPrefix, setCustomDomainPrefix] = useState(site.custom_domain_prefix ?? '')
  const trimmedTitle = title.trim()
  const normalizedPrefix = customDomainPrefix.trim().toLowerCase()
  const currentPrefix = site.custom_domain_prefix ?? ''
  const hasChanges = trimmedTitle !== site.name || normalizedPrefix !== currentPrefix
  const canSave = Boolean(trimmedTitle) && hasChanges && !loading

  useEffect(() => {
    titleInputRef.current?.focus()
    titleInputRef.current?.select()
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !loading) onCancel()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [loading, onCancel])

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSave) return
    onConfirm({
      title: trimmedTitle,
      customDomainPrefix: normalizedPrefix || null,
    })
  }

  return (
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/40 px-4"
      onClick={event => {
        if (!loading && event.target === event.currentTarget) onCancel()
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="site-edit-dialog-title"
        data-testid="site-edit-dialog"
        className="w-full max-w-[440px] rounded-lg border border-border bg-popover p-5 shadow-[0_18px_50px_rgba(0,0,0,0.28)]"
        onClick={event => event.stopPropagation()}
        onSubmit={submit}
      >
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface text-text-secondary">
            <Pencil className="h-4 w-4" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="site-edit-dialog-title" className="text-sm font-semibold text-text-primary">
              {t('edit_title', '编辑站点')}
            </h2>
            <div className="mt-4 space-y-3">
              <label className="block">
                <span className="text-xs font-medium text-text-secondary">
                  {t('edit_site_title_label', '标题')}
                </span>
                <input
                  ref={titleInputRef}
                  value={title}
                  onChange={event => setTitle(event.target.value)}
                  data-testid="site-edit-title-input"
                  disabled={loading}
                  maxLength={255}
                  className="mt-1 h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-focus focus:ring-2 focus:ring-focus/15 disabled:cursor-wait disabled:opacity-60"
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-text-secondary">
                  {t('edit_domain_prefix_label', '自定义域名前缀')}
                </span>
                <input
                  value={customDomainPrefix}
                  onChange={event => setCustomDomainPrefix(event.target.value.toLowerCase())}
                  data-testid="site-edit-domain-prefix-input"
                  disabled={loading}
                  maxLength={63}
                  placeholder={t('edit_domain_prefix_placeholder', '只允许小写字母、数字、短横线')}
                  className="mt-1 h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-focus focus:ring-2 focus:ring-focus/15 disabled:cursor-wait disabled:opacity-60"
                />
              </label>
            </div>
            {error && (
              <p className="mt-3 text-xs leading-5 text-red-500" role="alert">
                {error}
              </p>
            )}
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            data-testid="site-edit-cancel-button"
            onClick={onCancel}
            disabled={loading}
            className="h-8 rounded-md px-3 text-sm text-text-secondary transition-colors hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('cancel', '取消')}
          </button>
          <button
            type="submit"
            data-testid="site-edit-save-button"
            disabled={!canSave}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-text-primary px-3 text-sm font-medium text-background transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            {loading ? t('saving', '保存中') : t('save', '保存')}
          </button>
        </div>
      </form>
    </div>
  )
}
