import { ArrowRight, FileText, LoaderCircle, Users, X } from 'lucide-react'
import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useDialogKeyboard } from '@/hooks/useDialogKeyboard'
import { useTranslation } from '@/hooks/useTranslation'
import type { PluginAccessResponse } from '@/types/api'
import { formatPluginVersion } from './plugin-display'

export interface PluginVersionSubmitDrawerProps {
  pluginName: string
  currentVersion: string
  nextVersion: string
  access: PluginAccessResponse
  publishing: boolean
  error?: string | null
  initialReleaseNotes?: string
  onClose: () => void
  onSubmit: (releaseNotes: string) => void
  onManageAccess: (releaseNotes: string) => void
}

const RELEASE_NOTES_LIMIT = 2000

function PluginVersionComparison({
  currentVersion,
  nextVersion,
}: Pick<PluginVersionSubmitDrawerProps, 'currentVersion' | 'nextVersion'>) {
  const { t } = useTranslation('common')
  return (
    <div className="flex items-center gap-4 rounded-xl border border-border/30 px-4 py-5">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-text-secondary">
          {t('workbench.plugins_version_submit_current', '当前共享版本')}
        </p>
        <p data-testid="plugin-version-submit-current" className="mt-2 heading-medium">
          v{formatPluginVersion(currentVersion).replace(/^v/i, '')}
        </p>
      </div>
      <ArrowRight aria-hidden="true" className="h-5 w-5 shrink-0 text-text-muted" />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-text-secondary">
          {t('workbench.plugins_version_submit_next', '本次提交')}
        </p>
        <p data-testid="plugin-version-submit-next" className="mt-2 heading-medium">
          v{formatPluginVersion(nextVersion).replace(/^v/i, '')}
        </p>
      </div>
    </div>
  )
}

function PluginVersionAccessSummary({ access }: { access: PluginAccessResponse }) {
  const { t } = useTranslation('common')
  const userCount = access.targets.filter(target => target.entityType === 'user').length
  const departmentCount = access.targets.filter(target => target.entityType === 'namespace').length
  const scopeSummary =
    access.scope === 'private' || access.targets.length === 0
      ? t('workbench.plugins_version_submit_private', '仅自己可用')
      : t('workbench.plugins_version_submit_scope_summary', {
          members: t('workbench.plugins_version_submit_members', { count: userCount }),
          departments: t('workbench.plugins_version_submit_departments', {
            count: departmentCount,
          }),
        })
  return (
    <div className="space-y-4 rounded-xl border border-border/30 px-4 py-4 text-sm">
      <p data-testid="plugin-version-submit-scope" className="flex items-start gap-3">
        <Users aria-hidden="true" className="h-4 w-4 shrink-0" />
        <span>{scopeSummary}</span>
      </p>
      <p data-testid="plugin-version-submit-allow-copy" className="flex items-start gap-3">
        <FileText aria-hidden="true" className="h-4 w-4 shrink-0" />
        <span>
          {access.allowCopy
            ? t('workbench.plugins_version_submit_copy_enabled', '允许复制：开启')
            : t('workbench.plugins_version_submit_copy_disabled', '允许复制：关闭')}
        </span>
      </p>
    </div>
  )
}

export function PluginVersionSubmitDrawer({
  pluginName,
  currentVersion,
  nextVersion,
  access,
  publishing,
  error,
  initialReleaseNotes = '',
  onClose,
  onSubmit,
  onManageAccess,
}: PluginVersionSubmitDrawerProps) {
  const { t } = useTranslation('common')
  const id = useId()
  const [releaseNotes, setReleaseNotes] = useState(initialReleaseNotes)
  const notesInvalid = releaseNotes.length > 0 && !releaseNotes.trim()
  const canSubmit = Boolean(releaseNotes.trim()) && releaseNotes.length <= RELEASE_NOTES_LIMIT
  const drawerRef = useDialogKeyboard<HTMLElement>(
    () => {
      if (!publishing) onClose()
    },
    true,
    '[data-testid="plugin-version-submit-notes"]:not([disabled])'
  )

  return (
    <div
      data-testid="plugin-version-submit-overlay"
      className="plugin-dialog-overlay fixed inset-0 z-modal flex justify-end"
    >
      <section
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-busy={publishing}
        tabIndex={-1}
        data-testid="plugin-version-submit-drawer"
        className="flex h-full w-full max-w-[480px] flex-col border-l border-border/30 bg-background text-text-primary shadow-lg"
      >
        <header className="flex items-start justify-between gap-4 px-5 py-5">
          <div className="min-w-0">
            <h2 id={`${id}-title`} className="heading-small">
              {t('workbench.plugins_version_submit_title', '提交新版本')}
            </h2>
            <p className="mt-1 break-words text-sm text-text-secondary">{pluginName}</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-11 w-11 shrink-0 md:h-8 md:w-8"
            data-testid="plugin-version-submit-close"
            aria-label={t('common.close', '关闭')}
            disabled={publishing}
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </Button>
        </header>

        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={event => {
            event.preventDefault()
            if (!publishing && canSubmit) onSubmit(releaseNotes.trim())
          }}
        >
          <div className="min-h-0 flex-1 space-y-7 overflow-y-auto px-5 py-2">
            <PluginVersionComparison currentVersion={currentVersion} nextVersion={nextVersion} />
            <div className="space-y-2">
              <label htmlFor={`${id}-notes`} className="block text-sm font-medium">
                {t('workbench.plugins_version_submit_notes', '更新说明')}
                <span aria-hidden="true" className="ml-1 text-destructive">
                  *
                </span>
              </label>
              <textarea
                id={`${id}-notes`}
                data-testid="plugin-version-submit-notes"
                className="h-40 w-full resize-none rounded-xl border border-border bg-background px-3 py-3 text-base outline-none keyboard:focus:border-focus/70 keyboard:focus:ring-2 keyboard:focus:ring-focus/15 disabled:opacity-60"
                value={releaseNotes}
                required
                maxLength={RELEASE_NOTES_LIMIT}
                disabled={publishing}
                aria-invalid={notesInvalid}
                aria-describedby={`${id}-notes-help`}
                placeholder={t(
                  'workbench.plugins_version_submit_notes_placeholder',
                  '说明本版本的改进和修复'
                )}
                onChange={event => setReleaseNotes(event.target.value)}
              />
              <p
                id={`${id}-notes-help`}
                className="flex justify-between gap-3 text-xs text-text-muted"
              >
                <span>
                  {notesInvalid
                    ? t('workbench.plugins_version_submit_notes_required', '更新说明不能为空')
                    : t('workbench.plugins_version_submit_notes_hint', '必填，最多 2000 字')}
                </span>
                <span data-testid="plugin-version-submit-notes-count">
                  {releaseNotes.length}/{RELEASE_NOTES_LIMIT}
                </span>
              </p>
            </div>

            <section className="space-y-3" aria-labelledby={`${id}-scope-title`}>
              <h3 id={`${id}-scope-title`} className="text-sm font-medium">
                {t('workbench.plugins_version_submit_inherit_scope', '沿用当前分享范围')}
              </h3>
              <PluginVersionAccessSummary access={access} />
              <button
                type="button"
                data-testid="plugin-version-submit-manage-access"
                className="min-h-11 rounded-md text-sm text-focus hover:underline keyboard:focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/30 disabled:pointer-events-none disabled:opacity-50 md:min-h-8"
                disabled={publishing}
                onClick={() => onManageAccess(releaseNotes)}
              >
                {t('workbench.plugins_version_submit_manage_scope', '管理分享范围')}
              </button>
            </section>

            <p
              data-testid="plugin-version-submit-preserve-version"
              className="text-sm leading-6 text-text-muted"
            >
              {t('workbench.plugins_version_submit_preserve_version', {
                version: formatPluginVersion(currentVersion).replace(/^v/i, ''),
              })}
            </p>
            {error ? (
              <p
                role="alert"
                className="rounded-xl bg-destructive/5 px-3 py-3 text-sm text-destructive"
              >
                {error}
              </p>
            ) : null}
          </div>

          <footer className="mx-5 flex shrink-0 justify-end gap-3 border-t border-border/30 py-5">
            <Button
              type="button"
              variant="outline"
              className="h-11 md:h-10"
              data-testid="plugin-version-submit-cancel"
              disabled={publishing}
              onClick={onClose}
            >
              {t('common.cancel', '取消')}
            </Button>
            <Button
              type="submit"
              className="h-11 md:h-10"
              data-testid="plugin-version-submit-confirm"
              disabled={publishing || !canSubmit}
            >
              {publishing ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : null}
              {publishing
                ? t('workbench.plugins_version_submit_submitting', '正在检查并提交…')
                : t('workbench.plugins_version_submit_confirm', '检查并提交')}
            </Button>
          </footer>
        </form>
      </section>
    </div>
  )
}
