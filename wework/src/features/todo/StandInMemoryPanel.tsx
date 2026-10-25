import { useEffect, useState } from 'react'
import { Brain, Plus, X } from 'lucide-react'
import { dequal } from 'dequal'
import type { StandInExecutorApi, StandInMemory, StandInMemoryScope } from '@/api/standIn'
import type { PersonalStandInSettings } from '@/api/personalStandIn'
import { useTranslation } from '@/hooks/useTranslation'
import { useDialogKeyboard } from '@/hooks/useDialogKeyboard'

export function StandInMemoryPanel({
  api,
  settings,
  onClose,
}: {
  api: StandInExecutorApi
  settings: PersonalStandInSettings
  onClose(): void
}) {
  const { t } = useTranslation('common')
  const [items, setItems] = useState<StandInMemory[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [editing, setEditing] = useState<Partial<StandInMemory> | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [discard, setDiscard] = useState<'close' | 'cancel' | null>(null)
  const scopes: { scope: StandInMemoryScope; label: string }[] = [
    { scope: { kind: 'personal' }, label: t('standIn.memory.personal') },
    ...settings.roles.map(role => ({
      scope: { kind: 'role' as const, roleId: role.id },
      label: role.name || t('standIn.workspace.role_name'),
    })),
  ]
  for (const identity of [settings.primary, ...settings.roles]) {
    for (const source of identity?.connections ?? []) {
      const scope: StandInMemoryScope =
        source.providerId === '@wegent/dsh-connection-dingtalk/dingtalk' &&
        (source.kind === 'group' || source.kind === 'direct')
          ? {
              kind: 'dingtalk',
              id: source.id,
              profile: source.profile,
              conversationKind: source.kind,
            }
          : {
              kind: 'connection',
              providerId: source.providerId,
              id: source.id,
              profile: source.profile,
              resourceKind: source.kind,
            }
      if (!scopes.some(row => dequal(row.scope, scope))) scopes.push({ scope, label: source.name })
    }
    for (const project of identity?.collaboration?.projects ?? []) {
      const scope: StandInMemoryScope = { kind: 'project', id: project.id, store: project.store }
      if (!scopes.some(row => dequal(row.scope, scope)))
        scopes.push({ scope, label: `${t('standIn.memory.project')} · ${project.id}` })
    }
  }
  const label = (scope: StandInMemoryScope) =>
    scopes.find(row => dequal(row.scope, scope))?.label ?? t('standIn.memory.disconnected')
  useEffect(() => {
    let active = true
    api
      .memories(settings.userId, settings.executionDeviceId)
      .then(rows => {
        if (active) {
          setItems(rows)
          setError(null)
        }
      })
      .catch(cause => {
        if (active) setError(String(cause))
      })
    return () => {
      active = false
    }
  }, [api, settings.userId, settings.executionDeviceId, retry])
  const dirty =
    editing !== null &&
    !dequal(
      editing,
      items?.find(row => row.id === editing.id) ?? { content: '', scope: { kind: 'personal' } }
    )
  const close = () => {
    if (busy) return
    if (dirty) setDiscard('close')
    else onClose()
  }
  const ref = useDialogKeyboard<HTMLDivElement>(close)
  const mutate = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div ref={ref} className="flex min-h-full flex-col px-5" data-testid="stand-in-memory-panel">
      <header className="sticky top-0 z-10 mb-5 flex items-center gap-2 border-b border-border bg-background py-4">
        <Brain className="h-4 w-4" />
        <h2 className="heading-sm flex-1">{t('standIn.memory.title')}</h2>
        <button
          type="button"
          data-testid="stand-in-memory-close"
          aria-label={t('standIn.close')}
          onClick={close}
          disabled={busy}
          className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
        >
          <X className="h-4 w-4" />
        </button>
      </header>
      <p className="mb-5 text-sm text-text-muted">{t('standIn.memory.help')}</p>
      {error && (
        <div role="alert" className="mb-4 text-sm text-error">
          <p>{error}</p>
          <button
            type="button"
            data-testid="stand-in-memory-retry"
            disabled={busy}
            onClick={() => setRetry(value => value + 1)}
            className="mt-2 underline"
          >
            {t('standIn.reload')}
          </button>
        </div>
      )}
      {items === null && !error && <p role="status">{t('standIn.loading')}</p>}
      {items !== null && (
        <>
          {!editing && (
            <button
              type="button"
              data-testid="stand-in-memory-add"
              onClick={() => setEditing({ content: '', scope: { kind: 'personal' } })}
              className="mb-4 inline-flex min-h-8 items-center gap-2 self-start rounded-md border border-border px-3 text-sm hover:bg-muted"
            >
              <Plus className="h-4 w-4" />
              {t('standIn.memory.add')}
            </button>
          )}
          {editing && (
            <form
              data-testid="stand-in-memory-editor"
              className="mb-5 grid gap-3 rounded-lg border border-border p-4"
              onSubmit={event => {
                event.preventDefault()
                void mutate(async () => {
                  const row = await api.saveMemory(settings.userId, settings.executionDeviceId, {
                    ...editing,
                    content: editing.content ?? '',
                    scope: editing.scope ?? { kind: 'personal' },
                  })
                  setItems(current => [row, ...(current ?? []).filter(item => item.id !== row.id)])
                  setEditing(null)
                })
              }}
            >
              <label className="grid gap-2 text-sm">
                {t('standIn.memory.content')}
                <textarea
                  data-testid="stand-in-memory-content"
                  autoFocus
                  required
                  maxLength={1000}
                  rows={4}
                  disabled={busy}
                  value={editing.content ?? ''}
                  onChange={event => setEditing({ ...editing, content: event.target.value })}
                  className="rounded-md border border-border bg-transparent p-3"
                />
              </label>
              <label className="grid gap-2 text-sm">
                {t('standIn.memory.scope')}
                <select
                  data-testid="stand-in-memory-scope"
                  disabled={busy}
                  value={JSON.stringify(editing.scope)}
                  onChange={event =>
                    setEditing({
                      ...editing,
                      scope: JSON.parse(event.target.value) as StandInMemoryScope,
                    })
                  }
                  className="min-h-8 rounded-md border border-border bg-background px-2"
                >
                  {scopes.map(row => (
                    <option key={JSON.stringify(row.scope)} value={JSON.stringify(row.scope)}>
                      {row.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  data-testid="stand-in-memory-cancel"
                  disabled={busy}
                  onClick={() => {
                    if (dirty) setDiscard('cancel')
                    else setEditing(null)
                  }}
                  className="min-h-8 rounded-md px-3 hover:bg-muted"
                >
                  {t('standIn.cancel')}
                </button>
                <button
                  type="submit"
                  data-testid="stand-in-memory-save"
                  disabled={busy || !editing.content?.trim()}
                  className="min-h-8 rounded-md bg-text-primary px-3 text-background disabled:opacity-50"
                >
                  {t('standIn.save')}
                </button>
              </div>
            </form>
          )}
          {!items.length && !editing && (
            <p className="py-8 text-sm text-text-muted">{t('standIn.memory.empty')}</p>
          )}
          <ul className="divide-y divide-border">
            {items.map(row => (
              <li key={row.id} data-testid="stand-in-memory-item" className="py-4">
                <p className="whitespace-pre-wrap break-words text-sm">{row.content}</p>
                <p className="mt-2 text-xs text-text-muted">
                  {label(row.scope)} · {new Date(row.updatedAt).toLocaleDateString()}
                </p>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    data-testid="stand-in-memory-edit"
                    disabled={busy || editing !== null}
                    onClick={() => setEditing(row)}
                    className="min-h-8 rounded-md px-2 text-sm hover:bg-muted"
                  >
                    {t('standIn.memory.edit')}
                  </button>
                  <button
                    type="button"
                    data-testid="stand-in-memory-delete"
                    disabled={busy || editing !== null}
                    onClick={() => setDeleting(row.id)}
                    className="min-h-8 rounded-md px-2 text-sm hover:bg-muted"
                  >
                    {t('standIn.memory.forget')}
                  </button>
                  {deleting === row.id && (
                    <>
                      <button
                        type="button"
                        data-testid="stand-in-memory-delete-confirm"
                        disabled={busy}
                        onClick={() =>
                          void mutate(async () => {
                            await api.deleteMemory(
                              settings.userId,
                              settings.executionDeviceId,
                              row.id,
                              row.version
                            )
                            setItems(current => current?.filter(item => item.id !== row.id) ?? [])
                            setDeleting(null)
                          })
                        }
                        className="min-h-8 rounded-md px-2 text-sm text-error hover:bg-muted"
                      >
                        {t('standIn.memory.confirm_forget')}
                      </button>
                      <button
                        type="button"
                        data-testid="stand-in-memory-delete-cancel"
                        disabled={busy}
                        onClick={() => setDeleting(null)}
                        className="min-h-8 rounded-md px-2 text-sm hover:bg-muted"
                      >
                        {t('standIn.cancel')}
                      </button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {discard && (
        <div
          role="alertdialog"
          aria-label={t('standIn.personal.discard_help')}
          className="sticky bottom-0 mt-auto border-t border-border bg-background py-4"
        >
          <p className="text-sm">{t('standIn.personal.discard_help')}</p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              data-testid="stand-in-memory-discard"
              onClick={() => {
                setEditing(null)
                setDiscard(null)
                if (discard === 'close') onClose()
              }}
              className="min-h-8 rounded-md border border-border px-3"
            >
              {t('standIn.memory.discard')}
            </button>
            <button
              type="button"
              data-testid="stand-in-memory-keep"
              onClick={() => setDiscard(null)}
              className="min-h-8 rounded-md px-3 hover:bg-muted"
            >
              {t('standIn.cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
