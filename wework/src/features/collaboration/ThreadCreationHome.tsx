import { useState } from 'react'
import { collaborationMessages, type CollaborationProject } from '@wegent/collaboration'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { openWeworkScheme } from '@/features/notifications/schemeEvents'
import { weworkThreadScheme } from '@/features/notifications/scheme'
import type { GroupSource } from './CollaborationGroupsSurface'
import { ThreadCreateDialog } from './ThreadCreateDialog'

/** All desktop entry points create group-owned Threads, even without a project. */
export function ThreadCreationHome({
  sources,
  projects,
  locale,
  onConnectCloud,
  accountScope,
}: {
  sources: GroupSource[]
  projects: CollaborationProject[]
  locale: 'zh-CN' | 'en'
  onConnectCloud?(): void
  accountScope: string
}) {
  const { t } = useTranslation('collaboration')
  const [store, setStore] = useState<'local' | 'cloud'>(
    sources.some(source => source.store === 'cloud') ? 'cloud' : 'local'
  )
  const [projectId, setProjectId] = useState('')
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const source = sources.find(source => source.store === store)
  const options = projects.filter(
    project =>
      (project.project_store === 'local' ? 'local' : 'cloud') === store &&
      project.status === 'active' &&
      ['Owner', 'Maintainer', 'Developer'].includes(project.access_role ?? '')
  )
  const project = options.find(project => project.id === projectId)
  const field = 'rounded-lg border border-border bg-background px-3 py-2 text-sm text-text-primary'
  return (
    <section className="mx-auto w-full max-w-2xl space-y-6 p-8" data-testid="thread-creation-home">
      <div className="space-y-2">
        <h1 className="heading-lg text-text-primary">{t('newThread')}</h1>
        <p className="text-sm text-text-muted">{t('threadHomeHint')}</p>
      </div>
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-2 text-sm text-text-primary">
          {t('storage')}
          <select
            className={field}
            data-testid="thread-home-store"
            value={store}
            onChange={event => {
              setStore(event.target.value as 'local' | 'cloud')
              setProjectId('')
            }}
          >
            {!source && <option value={store}>{t(store)}</option>}
            {sources.map(source => (
              <option key={source.store} value={source.store}>
                {t(source.store)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-48 flex-col gap-2 text-sm text-text-primary">
          {t('projectOptional')}
          <select
            className={field}
            data-testid="thread-home-project"
            value={project?.id ?? ''}
            onChange={event => setProjectId(event.target.value)}
          >
            <option value="">{t('noProject')}</option>
            {options.map(project => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <Button data-testid="thread-home-create" disabled={!source} onClick={() => setOpen(true)}>
          {t('continue')}
        </Button>
      </div>
      {!source && (
        <div className="space-y-2">
          <p role="status" className="text-sm text-text-muted">
            {t('threadSourceUnavailable')}
          </p>
          {store === 'cloud' && onConnectCloud && (
            <Button data-testid="thread-home-connect" variant="ghost" onClick={onConnectCloud}>
              {t('connectCloud')}
            </Button>
          )}
        </div>
      )}
      {store === 'local' && <p className="text-sm text-text-muted">{t('localHint')}</p>}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {open && source && (
        <ThreadCreateDialog
          key={`${accountScope}:${store}:${project?.id ?? ''}`}
          api={source.workspace}
          groups={source.groups}
          store={store}
          locale={locale}
          accountScope={store === 'local' ? 'local' : accountScope}
          form={{
            api: source.workspace,
            project,
            allIssues: [],
            messages: collaborationMessages[locale],
            onClose: () => setOpen(false),
            onError: () => setError(t('threadCreateFailed')),
            onCreated: issue => {
              setOpen(false)
              openWeworkScheme(
                weworkThreadScheme(
                  issue.group_id ?? issue.cloud_project_id,
                  issue.id,
                  store === 'cloud' ? 'backend' : 'local'
                )
              )
            },
          }}
        />
      )}
    </section>
  )
}
