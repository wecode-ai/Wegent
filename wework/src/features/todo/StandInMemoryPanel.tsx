import { standInRoleName, type PersonalStandInSettings } from '@/api/personalStandIn'
import type { StandInExecutorApi, StandInMemory, StandInMemoryScope } from '@/api/standIn'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { useTranslation } from '@/hooks/useTranslation'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { createAsyncResource } from '@wegent/chat-core/async-resource'
import type { CollaborationProject } from '@wegent/collaboration'
import { DialogSurface } from '@wegent/collaboration/controls/DialogSurface'
import { SegmentedControl } from '@wegent/collaboration/controls/SegmentedControl'
import {
  SelectContent,
  SelectItem,
  SelectRoot,
  SelectTrigger,
} from '@wegent/collaboration/controls/SelectParts'
import { normalizeSelectValue } from '@wegent/collaboration/controls/selectValue'
import { Textarea as ControlTextarea } from '@wegent/collaboration/controls/Textarea'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { dequal } from 'dequal'
import { Plus } from 'lucide-react'
import {
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type Ref,
} from 'react'
import { StandInMemoryEvidence } from './StandInMemoryEvidence'
import { StandInMemoryRules } from './StandInMemoryRules'
import { StandInRecentReview } from './StandInRecentReview'
import { StandInReworkReview } from './StandInReworkReview'
import { StandInSettingsHeader } from './StandInSettingsLayout'
import type { StandInSettingsHandle } from './StandInSettingsPage'
import { useStandInPanelNavigation } from './useStandInPanelNavigation'

interface StandInMemoryPanelProps {
  api: StandInExecutorApi
  settings: PersonalStandInSettings
  projects: CollaborationProject[]
  fixedScope?: StandInMemoryScope
  reviewRoleId?: string
  scopeLabel?: string
  onClose(): void
  onBack?: () => void
  parentLabel?: string
  ref?: Ref<StandInSettingsHandle>
}

export function StandInMemoryPanel(props: StandInMemoryPanelProps) {
  const { api, settings, fixedScope } = props
  const scope = JSON.stringify([
    settings.userId,
    settings.executionDeviceId,
    fixedScope,
    props.reviewRoleId,
  ])
  const [owner, setOwner] = useState({ api, scope, revision: 0 })
  if (owner.api !== api || owner.scope !== scope) {
    setOwner({ api, scope, revision: owner.revision + 1 })
  }
  return <StandInMemoryPanelContent key={owner.revision} {...props} />
}

function StandInMemoryPanelContent({
  api,
  settings,
  projects,
  fixedScope,
  reviewRoleId,
  scopeLabel,
  onClose,
  onBack,
  parentLabel,
  ref,
}: StandInMemoryPanelProps) {
  const { t } = useTranslation('common')
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Partial<StandInMemory> | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<'all' | 'today' | 'week'>('all')
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
  const { userId, executionDeviceId } = settings
  const resource = useMemo(
    () =>
      createAsyncResource(
        JSON.stringify(['stand-in-memory', userId, executionDeviceId, scopeKey, settings.version]),
        async () => {
          const rows = await api.memories(userId, executionDeviceId)
          return rows.filter(row =>
            scopeKey
              ? dequal(row.scope, JSON.parse(scopeKey))
              : row.scope.kind !== 'project_coordinator'
          )
        }
      ),
    [api, userId, executionDeviceId, scopeKey, settings.version]
  )
  const snapshot = useSyncExternalStore(
    resource.subscribe,
    resource.getSnapshot,
    resource.getSnapshot
  )
  const items = snapshot.data ?? null
  const reviewRole = settings.roles.find(role => role.id === reviewRoleId)
  const reviewIdentity = reviewRoleId === '@primary' ? settings.primary : reviewRole
  const showReviewTabs =
    !!reviewRoleId &&
    !!reviewIdentity &&
    (!!reviewIdentity.selfLearningEnabled ||
      items?.some(row => row.evidence?.trainingCase?.roleId === reviewRoleId))
  const reviewing = showReviewTabs && view !== 'all'
  const visibleError =
    error ?? (snapshot.status === 'error' ? getStandInErrorMessage(snapshot.error) : null)
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
  const dialogRef = useRef<HTMLDivElement>(null)
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
    <DialogSurface
      onClose={close}
      active={!discard}
      render={
        <div
          ref={dialogRef}
          className="flex min-h-full flex-col px-5"
          data-testid="stand-in-memory-panel"
        />
      }
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
                  label: parentLabel ?? t('standIn.workspace.primary_profile'),
                  testId: 'stand-in-memory-path-settings',
                  onClick: () => navigation.requestLeave(onBack),
                },
                { label: t('standIn.memory.title'), testId: 'stand-in-memory-path-current' },
              ]
            : undefined
        }
      />
      <p className="mb-4 text-sm text-text-secondary">{t('standIn.memory.help')}</p>
      {visibleError && (
        <div role="alert" className="mb-4 text-sm text-error">
          <p>{visibleError}</p>
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid="stand-in-memory-retry"
            disabled={busy}
            onClick={() => {
              setError(null)
              void resource.reload()
            }}
            className="mt-2 underline"
          >
            {t('standIn.reload')}
          </ControlButton>
        </div>
      )}
      {items === null && !visibleError && <p role="status">{t('standIn.loading')}</p>}
      {showReviewTabs && (
        <SegmentedControl
          label={t('standIn.memory.title')}
          className="mb-4 self-start"
          value={view}
          disabled={busy || editing !== null || deleting !== null}
          onChange={next => {
            setView(next)
            if (next !== 'all' && snapshot.status !== 'loading') void resource.reload()
          }}
          options={[
            { value: 'all', label: t('standIn.memory.manage_all'), testId: 'stand-in-memory-all' },
            {
              value: 'today',
              label: t('standIn.memory.review_today'),
              testId: 'stand-in-review-today',
            },
            {
              value: 'week',
              label: t('standIn.memory.review_week'),
              testId: 'stand-in-review-week',
            },
          ]}
        />
      )}
      {reviewing && snapshot.status === 'loading' && <p role="status">{t('standIn.loading')}</p>}
      {items !== null && reviewing && snapshot.status === 'ready' && (
        <StandInRecentReview
          memories={items}
          roleId={reviewRoleId}
          name={
            reviewRole
              ? standInRoleName(
                  reviewRole,
                  settings.roles.indexOf(reviewRole),
                  t('standIn.personal.default_role')
                )
              : t('standIn.memory.review_primary')
          }
          period={view}
        />
      )}
      {reviewing && reviewIdentity.selfLearningEnabled && (
        <StandInReworkReview
          key={settings.version}
          api={api}
          userId={userId}
          deviceId={reviewRole?.executionDeviceId ?? executionDeviceId}
          roleId={reviewRoleId}
        />
      )}
      {items !== null && !reviewing && (
        <>
          {!editing && (
            <div className="mb-3 space-y-3">
              {!items.length && (
                <p className="text-sm text-text-secondary">{t('standIn.memory.empty')}</p>
              )}
              <ControlButton
                variant={items.length ? 'outline' : 'primary'}
                size="sm"
                type="button"
                data-testid="stand-in-memory-add"
                disabled={busy}
                onClick={() =>
                  setEditing({ content: '', scope: fixedScope ?? { kind: 'personal' } })
                }
              >
                <Plus aria-hidden="true" className="size-4" />
                {t('standIn.memory.add')}
              </ControlButton>
            </div>
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
                  resource.update(current => [
                    row,
                    ...(current ?? []).filter(item => item.id !== row.id),
                  ])
                  setEditing(null)
                })
              }}
            >
              <label className="grid gap-2 text-sm">
                {t('standIn.memory.content')}
                <ControlTextarea
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
                <SelectRoot
                  disabled={busy}
                  value={normalizeSelectValue(
                    JSON.stringify(selectedScope?.scope ?? editing.scope)
                  )}
                  onValueChange={selectedValue => {
                    if (selectedValue !== null)
                      return setEditing({
                        ...editing,
                        scope: JSON.parse(selectedValue) as StandInMemoryScope,
                      })
                  }}
                >
                  <SelectTrigger density="compact" data-testid="stand-in-memory-scope" />
                  <SelectContent data-testid="stand-in-memory-scope-options">
                    {!selectedScope && (
                      <SelectItem value={String(JSON.stringify(editing.scope))} disabled>
                        {t('standIn.memory.disconnected')}
                      </SelectItem>
                    )}
                    {scopes.map(row => (
                      <SelectItem
                        key={JSON.stringify(row.scope)}
                        value={String(JSON.stringify(row.scope))}
                      >
                        {row.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </SelectRoot>
              </label>
              <div className="flex justify-end gap-2">
                <ControlButton
                  variant="unstyled"
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
                </ControlButton>
                <ControlButton
                  variant="primary"
                  size="sm"
                  type="submit"
                  data-testid="stand-in-memory-save"
                  disabled={busy || !editing.content?.trim() || !selectedScope}
                  className="min-h-8 rounded-md bg-text-primary px-3 text-background disabled:opacity-50"
                >
                  {t('standIn.save')}
                </ControlButton>
              </div>
            </form>
          )}
          <ul className="divide-y divide-border">
            {items.map(row => (
              <li key={row.id} data-testid="stand-in-memory-item" className="py-4">
                <p className="whitespace-pre-wrap break-words text-sm">
                  {row.evidenceUnavailable ? t('standIn.memory.source_unavailable') : row.content}
                </p>
                <p className="mt-2 text-xs text-text-muted">
                  {label(row.scope)} · {new Date(row.updatedAt).toLocaleDateString()}
                </p>
                <StandInMemoryEvidence memory={row} />
                <div className="mt-2 flex flex-wrap gap-2">
                  <ControlButton
                    variant="unstyled"
                    type="button"
                    data-testid="stand-in-memory-edit"
                    disabled={busy || editing !== null}
                    onClick={() => setEditing(row)}
                    className="min-h-8 rounded-md px-2 text-sm hover:bg-muted"
                  >
                    {t('standIn.memory.edit')}
                  </ControlButton>
                  <ControlButton
                    variant="unstyled"
                    type="button"
                    data-testid="stand-in-memory-delete"
                    disabled={busy || editing !== null}
                    onClick={() => setDeleting(row.id)}
                    className="min-h-8 rounded-md px-2 text-sm hover:bg-muted"
                  >
                    {t('standIn.memory.forget')}
                  </ControlButton>
                  {deleting === row.id && (
                    <>
                      <p className="basis-full text-sm text-text-muted">
                        {t('standIn.memory.forget_retention')}
                      </p>
                      <ControlButton
                        variant="unstyled"
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
                            resource.update(
                              current => current?.filter(item => item.id !== row.id) ?? []
                            )
                            setDeleting(null)
                          })
                        }
                        className="min-h-8 rounded-md px-2 text-sm text-error hover:bg-muted"
                      >
                        {t('standIn.memory.confirm_forget')}
                      </ControlButton>
                      <ControlButton
                        variant="unstyled"
                        type="button"
                        data-testid="stand-in-memory-delete-cancel"
                        disabled={busy}
                        onClick={() => setDeleting(null)}
                        className="min-h-8 rounded-md px-2 text-sm hover:bg-muted"
                      >
                        {t('standIn.cancel')}
                      </ControlButton>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {!reviewing && (
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
      )}
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
    </DialogSurface>
  )
}
