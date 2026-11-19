import { useRef, useState, useSyncExternalStore } from 'react'
import { useDialogKeyboard } from '@wegent/collaboration/dom-events'
import { useSiteDialogScope } from './useSiteDialogScope'
import { createSiteCollaboratorsResource } from './siteCollaboratorsResource'
import { AlertCircle, Loader2, Trash2, UserPlus, X } from 'lucide-react'
import type { Site, SitesApi } from '@/api/sites'
import { useTranslation } from '@/hooks/useTranslation'
import { createRequestId } from '@/lib/request-id'

interface SiteCollaboratorsDialogProps {
  api: SitesApi
  site: Site
  onClose: () => void
}

export function SiteCollaboratorsDialog(props: SiteCollaboratorsDialogProps) {
  const scope = useSiteDialogScope(props.api, props.site.siteid)
  return (
    <SiteCollaboratorsDialogContent key={scope.key} {...props} restoreFocus={scope.restoreFocus} />
  )
}

function SiteCollaboratorsDialogContent({
  api,
  site,
  onClose,
  restoreFocus,
}: SiteCollaboratorsDialogProps & { restoreFocus: () => HTMLElement | null }) {
  const { t } = useTranslation('sites')
  const [resource] = useState(() => createSiteCollaboratorsResource(api, site.siteid))
  const snapshot = useSyncExternalStore(resource.subscribe, resource.getSnapshot)
  const { items, loading } = snapshot
  const [subject, setSubject] = useState('')
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const [actionError, setError] = useState<string | null>(null)
  const loadFailed = snapshot.failure !== null
  const error =
    actionError ??
    (snapshot.failure
      ? snapshot.failure.cause instanceof Error
        ? snapshot.failure.cause.message || t('collaborators_load_failed', '协作者加载失败')
        : t('collaborators_load_failed', '协作者加载失败')
      : null)
  const adding = useRef(false)
  const deleting = useRef<string | null>(null)
  const close = () => {
    if (!adding.current && !deleting.current) onClose()
  }
  const dialogRef = useDialogKeyboard<HTMLElement>(
    close,
    true,
    '[data-testid="site-collaborators-close"]',
    true,
    restoreFocus
  )

  const add = async () => {
    const normalized = subject.trim()
    if (!normalized || adding.current) return
    adding.current = true
    setSaving(true)
    setError(null)
    try {
      const collaborator = await api.addCollaborator(
        site.siteid,
        normalized,
        createRequestId('collaborator')
      )
      resource.accept(collaborator.subject, collaborator)
      setSubject('')
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : t('collaborator_add_failed', '添加协作者失败')
      )
    } finally {
      adding.current = false
      setSaving(false)
    }
  }

  const remove = async (collaboratorSubject: string) => {
    if (deleting.current) return
    deleting.current = collaboratorSubject
    setRemoving(collaboratorSubject)
    setError(null)
    try {
      await api.removeCollaborator(site.siteid, collaboratorSubject)
      resource.accept(collaboratorSubject, null)
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : t('collaborator_remove_failed', '移除协作者失败')
      )
    } finally {
      deleting.current = null
      setRemoving(null)
    }
  }

  return (
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/40 px-4"
      onClick={event => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <section
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="site-collaborators-title"
        data-testid="site-collaborators-dialog"
        className="w-full max-w-lg rounded-xl border border-border bg-popover p-5 shadow-[0_18px_50px_rgba(0,0,0,0.28)]"
      >
        <header className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 id="site-collaborators-title" className="truncate text-base font-medium">
              {t('manage_collaborators', '管理协作者')}
            </h2>
            <p className="mt-1 truncate text-sm text-text-secondary">{site.name}</p>
          </div>
          <button
            type="button"
            data-testid="site-collaborators-close"
            aria-label={t('close', '关闭')}
            onClick={close}
            disabled={saving || Boolean(removing)}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-surface hover:text-text-primary disabled:opacity-50"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>

        <div className="mt-5 flex gap-2">
          <input
            data-testid="site-collaborator-subject-input"
            value={subject}
            onChange={event => setSubject(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') void add()
            }}
            placeholder={t('collaborator_username_placeholder', '输入用户名')}
            aria-label={t('collaborator_username', '协作者用户名')}
            disabled={saving}
            className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-sm outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/30"
          />
          <button
            type="button"
            data-testid="site-collaborator-add"
            disabled={!subject.trim() || saving}
            onClick={() => void add()}
            className="flex h-9 items-center gap-1.5 rounded-lg bg-text-primary px-3 text-sm font-medium text-background disabled:opacity-50"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <UserPlus className="h-4 w-4" />
            )}
            {t('add_collaborator', '添加')}
          </button>
        </div>

        {error ? (
          <p className="mt-3 flex items-center gap-2 text-sm text-danger" role="alert">
            <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
            {error}
          </p>
        ) : null}

        {loadFailed && (
          <button
            type="button"
            data-testid="site-collaborators-retry"
            onClick={() => {
              setError(null)
              void resource.reload()
            }}
            className="mt-2 min-h-11 rounded-md border border-border px-3 text-sm md:min-h-8"
          >
            {t('retry', '重试')}
          </button>
        )}

        <div className="mt-4 min-h-24 rounded-lg border border-border">
          {loading ? (
            <div className="flex min-h-24 items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-text-secondary" aria-hidden="true" />
            </div>
          ) : loadFailed && items.length === 0 ? null : items.length === 0 ? (
            <p className="flex min-h-24 items-center justify-center text-sm text-text-secondary">
              {t('no_collaborators', '暂无协作者')}
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {items.map(item => (
                <li
                  key={item.subject}
                  className="flex h-11 items-center justify-between gap-3 px-3"
                >
                  <span className="truncate text-sm">{item.subject}</span>
                  <button
                    type="button"
                    data-testid={`site-collaborator-remove-${item.subject}`}
                    aria-label={t('remove_collaborator', { name: item.subject })}
                    disabled={Boolean(removing)}
                    onClick={() => void remove(item.subject)}
                    className="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-surface hover:text-danger disabled:opacity-50"
                  >
                    {removing === item.subject ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  )
}
