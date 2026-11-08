import { useStandInPanelNavigation } from './useStandInPanelNavigation'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { useEffect, useImperativeHandle, useState, type Ref } from 'react'
import { Plus } from 'lucide-react'
import { StandInSettingsHeader } from './StandInSettingsLayout'
import { dequal } from 'dequal'
import type { CollaborationProject } from '@wegent/collaboration'
import type { StandInExecutorApi, StandInMemory, StandInMemoryScope } from '@/api/standIn'
import { standInRoleName, type PersonalStandInSettings } from '@/api/personalStandIn'
import { useTranslation } from '@/hooks/useTranslation'
import { useDialogKeyboard } from '@/hooks/useDialogKeyboard'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import type { StandInSettingsHandle } from './StandInSettingsPage'
import { StandInMemoryEvidence } from './StandInMemoryEvidence'
import { StandInMemoryRules } from './StandInMemoryRules'

export function StandInMemoryPanel({
  api,
  settings,
  projects,
  fixedScope,
  scopeLabel,
  onClose,
  onBack,
  ref,
}: {
  api: StandInExecutorApi
  settings: PersonalStandInSettings
  projects: CollaborationProject[]
  fixedScope?: StandInMemoryScope
  scopeLabel?: string
  onClose(): void
  onBack?: () => void
  ref?: Ref<StandInSettingsHandle>
}) {
  const { t } = useTranslation('common')
  const [items, setItems] = useState<StandInMemory[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [editing, setEditing] = useState<Partial<StandInMemory> | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [discard, setDiscard] = useState<'close' | 'cancel' | null>(null)
  const scopeKey = fixedScope ? JSON.stringify(fixedScope) : undefined
  const scopes: { scope: StandInMemoryScope; label: string }[] = fixedScope
    ? [{ scope: fixedScope, label: scopeLabel ?? t('standIn.memory.project') }]
    : [
        { scope: fixedScope ?? { kind: 'personal' }, label: t('standIn.memory.personal') },
        ...settings.roles.map((role, index) => ({
          scope: { kind: 'role' as const, roleId: role.id },
          label: t('standIn.memory.role', {
            name: standInRoleName(role, index, t('standIn.personal.default_role')),
          }),
        })),
      ]
  for (const identity of fixedScope ? [] : [settings.primary, ...settings.roles]) {
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
      const source = projects.find(
        row =>
          row.id === project.id &&
          (row.project_store === 'local' ? 'local' : 'cloud') === project.store
      )
      if (source && !scopes.some(row => dequal(row.scope, scope)))
        scopes.push({ scope, label: `${t('standIn.memory.project')} · ${source.name}` })
    }
  }
  const selectedScope = scopes.find(row => dequal(row.scope, editing?.scope))
  const label = (scope: StandInMemoryScope) =>
    scopes.find(row => dequal(row.scope, scope))?.label ?? t('standIn.memory.disconnected')
  useEffect(() => {
    let active = true
    api
      .memories(settings.userId, settings.executionDeviceId)
      .then(rows => {
        if (active) {
          setItems(
            rows.filter(row =>
              scopeKey
                ? dequal(row.scope, JSON.parse(scopeKey))
                : row.scope.kind !== 'project_coordinator'
            )
          )
          setError(null)
        }
      })
      .catch(cause => {
        if (active) setError(getStandInErrorMessage(cause))
      })
    return () => {
      active = false
    }
  }, [api, settings.userId, settings.executionDeviceId, retry, scopeKey])
  const dirty =
    editing !== null &&
    !dequal(
      editing,
      items?.find(row => row.id === editing.id) ?? {
        content: '',
        scope: fixedScope ?? { kind: 'personal' },
      }
    )
  const navigation = useStandInPanelNavigation(dirty, busy, () => setDiscard('close'))
  const close = () => navigation.requestLeave(onClose)
  const dialogRef = useDialogKeyboard<HTMLDivElement>(close, !discard)
  useImperativeHandle(ref, () => ({ requestClose: close, requestLeave: navigation.requestLeave }))
  const mutate = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (cause) {
      setError(getStandInErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div
      ref={dialogRef}
      className="flex min-h-full flex-col px-5"
      data-testid="stand-in-memory-panel"
    >
      <StandInSettingsHeader
        title={t('standIn.memory.title')}
        disabled={busy}
        back={
          onBack
            ? { testId: 'stand-in-memory-back', onClick: () => navigation.requestLeave(onBack) }
            : undefined
        }
        close={{ testId: 'stand-in-memory-close', onClick: close }}
        path={
          onBack
            ? [
                {
                  label: t('standIn.workspace.primary_profile'),
                  testId: 'stand-in-memory-path-settings',
                  onClick: () => navigation.requestLeave(onBack),
                },
                { label: t('standIn.memory.title'), testId: 'stand-in-memory-path-current' },
              ]
            : undefined
        }
      />
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
              disabled={busy}
              onClick={() => setEditing({ content: '', scope: fixedScope ?? { kind: 'personal' } })}
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
                    scope: editing.scope ?? fixedScope ?? { kind: 'personal' },
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
                  value={JSON.stringify(selectedScope?.scope ?? editing.scope)}
                  onChange={event =>
                    setEditing({
                      ...editing,
                      scope: JSON.parse(event.target.value) as StandInMemoryScope,
                    })
                  }
                  className="min-h-8 rounded-md border border-border bg-background px-2"
                >
                  {!selectedScope && (
                    <option value={JSON.stringify(editing.scope)} disabled>
                      {t('standIn.memory.disconnected')}
                    </option>
                  )}
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
                  disabled={busy || !editing.content?.trim() || !selectedScope}
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
                <StandInMemoryEvidence memory={row} />
                <div className="mt-2 flex flex-wrap gap-2">
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
                      <p className="basis-full text-sm text-text-muted">
                        {t('standIn.memory.forget_retention')}
                      </p>
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
      <StandInMemoryRules
        api={api}
        userId={settings.userId}
        deviceId={settings.executionDeviceId}
        fixedScope={fixedScope}
        label={label}
        refreshKey={items}
        disabled={busy || editing !== null || deleting !== null}
        onBusyChange={setBusy}
      />
      <ConfirmDialog
        open={discard !== null}
        destructive
        title={t('standIn.personal.discard_help')}
        description={t('standIn.personal.discard_description')}
        cancelLabel={t('standIn.personal.keep_editing')}
        confirmLabel={t('standIn.memory.discard')}
        confirmTestId="stand-in-memory-discard"
        cancelTestId="stand-in-memory-keep"
        onClose={() => {
          navigation.cancelLeave()
          setDiscard(null)
        }}
        onConfirm={() => {
          setEditing(null)
          setDiscard(null)
          navigation.confirmLeave(() => {
            if (discard === 'close') onClose()
          })
        }}
      />
    </div>
  )
}
