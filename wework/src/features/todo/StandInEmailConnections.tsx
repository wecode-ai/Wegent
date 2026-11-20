import {
  useCallback,
  useImperativeHandle,
  useMemo,
  useState,
  useSyncExternalStore,
  type Ref,
} from 'react'
import { Mail, Plus, X } from 'lucide-react'
import type { StandInRole } from '@/api/personalStandIn'
import { useTranslation } from '@/hooks/useTranslation'
import {
  createEmailConnectionsModel,
  initialEmailForm as initialForm,
  EMAIL_PROVIDER,
} from './standInEmailConnectionsModel'
export { EMAIL_PROVIDER } from './standInEmailConnectionsModel'
import { StandInConnectionHeader } from './StandInConnectionHeader'
import { StandInProcessingSettings } from './StandInProcessingSettings'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import type { AutomationNavigationHandle } from '@/features/automations/AutomationsPage'

interface StandInEmailConnectionsProps {
  role: StandInRole
  local: boolean
  disabled: boolean
  onChange(role: StandInRole): void
  onDirtyChange?(dirty: boolean): void
  ref?: Ref<AutomationNavigationHandle>

  userId?: number
  ownerApi?: object
}
export function StandInEmailConnections(props: StandInEmailConnectionsProps) {
  const scope = JSON.stringify([
    props.userId,
    props.role.executionDeviceId,
    props.role.id,
    props.local,
  ])
  const [owner, setOwner] = useState({ api: props.ownerApi, scope, revision: 0 })
  if (owner.api !== props.ownerApi || owner.scope !== scope)
    setOwner({ api: props.ownerApi, scope, revision: owner.revision + 1 })
  return <StandInEmailConnectionsContent key={owner.revision} {...props} />
}
function StandInEmailConnectionsContent({
  role,
  local,
  disabled,
  onChange,
  onDirtyChange,
  ref,
}: StandInEmailConnectionsProps) {
  const { t } = useTranslation('common')
  const input = useMemo(
    () => ({ role, local, disabled, onChange, onDirtyChange }),
    [role, local, disabled, onChange, onDirtyChange]
  )
  const [model] = useState(() => createEmailConnectionsModel(input))
  const subscribe = useCallback(
    (listener: () => void) => model.subscribe(listener, input),
    [model, input]
  )
  const state = useSyncExternalStore(subscribe, model.getSnapshot, model.getSnapshot)
  const { accounts, form, adding, busy, error, saved, removing, pendingNavigation } = state
  const setForm = (value: Parameters<typeof model.set<'form'>>[1]) => model.set('form', value)
  const setBaseline = (value: typeof initialForm) => model.set('baseline', value)
  const setAdding = (value: boolean | ((current: boolean) => boolean)) => model.set('adding', value)
  const setSaved = (value: 'connected' | 'updated' | null) => model.set('saved', value)
  const setRemoving = (value: typeof removing) => model.set('removing', value)
  const setPendingNavigation = (value: typeof pendingNavigation) =>
    model.set('pendingNavigation', () => value)
  const requestLeave = model.requestLeave
  const connect = model.connect
  const removeAccount = model.removeAccount
  const rows = (role.connections ?? []).filter(row => row.providerId === EMAIL_PROVIDER)
  useImperativeHandle(ref, () => ({ requestLeave }), [requestLeave])
  return (
    <section
      className="space-y-4 max-md:[&_button]:min-h-11 max-md:[&_button]:min-w-11"
      data-testid="stand-in-email-connections"
    >
      <StandInConnectionHeader
        icon={Mail}
        title={t('standIn.email.title')}
        description={t('standIn.email.help')}
      />
      {!local && <p role="status">{t('standIn.email.local_device')}</p>}
      {rows.map(row => (
        <div key={row.profile} className="flex items-center gap-2 border-b border-border py-2">
          <span className="min-w-0 flex-1 truncate text-sm">{row.name}</span>
          <button
            type="button"
            data-testid={`stand-in-email-remove-${row.profile}`}
            disabled={disabled || busy}
            aria-label={t('standIn.workspace.remove_connection', { name: row.name })}
            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
            onClick={() =>
              onChange({
                ...role,
                connections: (role.connections ?? []).filter(value => value !== row),
              })
            }
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
      {local &&
        accounts
          .filter(account => !rows.some(row => row.profile === account.id))
          .map(account => (
            <button
              key={account.id}
              type="button"
              data-testid={`stand-in-email-connect-${account.id}`}
              disabled={disabled || busy}
              onClick={() => connect(account)}
              className="flex min-h-9 w-full items-center justify-between rounded-md px-2 text-left text-sm hover:bg-muted"
            >
              <span>{account.email}</span>
              <span>{t('standIn.workspace.add')}</span>
            </button>
          ))}
      {local && accounts.length > 0 && (
        <details className="space-y-2">
          <summary
            data-testid="stand-in-email-manage"
            className="min-h-11 cursor-pointer text-sm text-text-secondary md:min-h-9"
          >
            {t('standIn.email.manage')}
          </summary>
          {accounts.map(account => (
            <div key={account.id} className="flex flex-wrap items-center gap-2 py-1 text-sm">
              <span className="min-w-0 flex-1 truncate">{account.email}</span>
              <button
                type="button"
                disabled={disabled || busy}
                data-testid={`stand-in-email-edit-${account.id}`}
                className="min-h-9 underline"
                onClick={() =>
                  requestLeave(() => {
                    setForm({ ...account, password: '' })
                    setBaseline({ ...account, password: '' })
                    setAdding(true)
                    setSaved(null)
                  })
                }
              >
                {t('standIn.email.update')}
              </button>
              <button
                type="button"
                disabled={disabled || busy}
                data-testid={`stand-in-email-delete-${account.id}`}
                className="min-h-9 text-error underline"
                onClick={() => setRemoving(account)}
              >
                {t('standIn.email.remove_account')}
              </button>
            </div>
          ))}
        </details>
      )}
      {local && (
        <button
          type="button"
          data-testid="stand-in-email-add"
          disabled={disabled || busy}
          aria-expanded={adding}
          onClick={() =>
            requestLeave(() => {
              setBaseline(initialForm)
              setForm(initialForm)
              setAdding(value => !value)
              setSaved(null)
            })
          }
          className="inline-flex min-h-9 items-center gap-2 text-sm hover:underline"
        >
          {adding ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
          {t(adding ? 'standIn.email.cancel_edit' : 'standIn.email.add_account')}
        </button>
      )}
      {adding && (
        <form
          onSubmit={event => {
            event.preventDefault()
            void model.save()
          }}
          className="space-y-4"
          data-testid="stand-in-email-form"
        >
          <fieldset disabled={disabled || busy} className="space-y-3">
            {(['email', 'username', 'password'] as const).map(key => (
              <label key={key} className="block space-y-1 text-sm">
                <span>{t(`standIn.email.${key}`)}</span>
                <input
                  data-testid={`stand-in-email-${key}`}
                  type={key === 'password' ? 'password' : key === 'email' ? 'email' : 'text'}
                  required={key !== 'username'}
                  disabled={Boolean(form.id) && key !== 'password'}
                  maxLength={1024}
                  autoComplete={key === 'password' ? 'new-password' : 'off'}
                  value={form[key]}
                  onChange={event => setForm(value => ({ ...value, [key]: event.target.value }))}
                  className="min-h-11 w-full rounded-md border border-border bg-background px-3 md:min-h-9"
                />
              </label>
            ))}
            <p className="text-xs text-text-secondary">{t('standIn.email.password_help')}</p>
            {form.id && (
              <p className="text-xs text-text-secondary">{t('standIn.email.update_help')}</p>
            )}
            {(['imap', 'smtp'] as const).map(protocol => (
              <fieldset
                key={protocol}
                disabled={Boolean(form.id) && protocol === 'imap'}
                className="space-y-2"
              >
                <legend className="mb-2 text-sm font-medium">
                  {t(`standIn.email.${protocol}_server`)}
                </legend>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_6rem_8rem]">
                  <label className="space-y-1 text-sm">
                    <span>{t('standIn.email.host')}</span>
                    <input
                      required
                      maxLength={253}
                      data-testid={`stand-in-email-${protocol}-host`}
                      value={form[protocol].host}
                      onChange={event =>
                        setForm(value => ({
                          ...value,
                          [protocol]: { ...value[protocol], host: event.target.value },
                        }))
                      }
                      className="min-h-11 w-full rounded-md border border-border bg-background px-3 md:min-h-9"
                    />
                  </label>
                  <label className="space-y-1 text-sm">
                    <span>{t('standIn.email.port')}</span>
                    <input
                      required
                      type="number"
                      min={1}
                      max={65535}
                      data-testid={`stand-in-email-${protocol}-port`}
                      value={form[protocol].port}
                      onChange={event =>
                        setForm(value => ({
                          ...value,
                          [protocol]: { ...value[protocol], port: Number(event.target.value) },
                        }))
                      }
                      className="min-h-11 w-full rounded-md border border-border bg-background px-3 md:min-h-9"
                    />
                  </label>
                  <label className="space-y-1 text-sm">
                    <span>{t('standIn.email.encryption')}</span>
                    <select
                      data-testid={`stand-in-email-${protocol}-tls`}
                      value={form[protocol].secure ? 'tls' : 'starttls'}
                      onChange={event =>
                        setForm(value => ({
                          ...value,
                          [protocol]: {
                            ...value[protocol],
                            secure: event.target.value === 'tls',
                            port:
                              protocol === 'imap'
                                ? event.target.value === 'tls'
                                  ? 993
                                  : 143
                                : event.target.value === 'tls'
                                  ? 465
                                  : 587,
                          },
                        }))
                      }
                      className="min-h-11 w-full rounded-md border border-border bg-background px-2 md:min-h-9"
                    >
                      <option value="tls">TLS</option>
                      <option value="starttls">STARTTLS</option>
                    </select>
                  </label>
                </div>
              </fieldset>
            ))}
            <button
              type="submit"
              data-testid="stand-in-email-save"
              className="min-h-9 rounded-md bg-text-primary px-3 text-sm text-background disabled:opacity-40"
            >
              {t(
                busy
                  ? 'standIn.email.verifying'
                  : form.id
                    ? 'standIn.email.verify_update'
                    : 'standIn.email.verify_connect'
              )}
            </button>
          </fieldset>
        </form>
      )}
      {saved && (
        <p role="status" data-testid="stand-in-email-verified" className="text-sm">
          {t(saved === 'updated' ? 'standIn.email.updated' : 'standIn.email.verified')}
        </p>
      )}
      {error && (
        <div role="alert" className="space-y-2 text-sm text-error">
          <p>{t(`standIn.email.${error}`)}</p>
          {error === 'email_unavailable' && (
            <button
              type="button"
              data-testid="stand-in-email-retry"
              disabled={busy}
              className="min-h-9 underline"
              onClick={() => {
                model.reload()
              }}
            >
              {t('standIn.workspace.connection_retry')}
            </button>
          )}
        </div>
      )}
      <StandInProcessingSettings
        disabled={disabled || busy}
        rows={rows.map(row => ({
          key: row.profile,
          name: row.name,
          testId: `stand-in-email-policy-${row.profile}`,
          policy: row.policy,
          outbound: true,
          onChange: policy =>
            onChange({
              ...role,
              connections: (role.connections ?? []).map(value =>
                value === row ? { ...value, policy } : value
              ),
            }),
        }))}
      />
      <ConfirmDialog
        open={Boolean(pendingNavigation)}
        title={t('standIn.email.discard_title')}
        description={t('standIn.email.discard_help')}
        confirmLabel={t('standIn.email.discard')}
        cancelLabel={t('standIn.email.cancel')}
        confirmTestId="stand-in-email-discard"
        onClose={() => setPendingNavigation(null)}
        onConfirm={() => {
          const action = pendingNavigation
          setBaseline(initialForm)
          setForm(initialForm)
          setPendingNavigation(null)
          action?.()
        }}
      />
      <ConfirmDialog
        open={Boolean(removing)}
        title={t('standIn.email.remove_account')}
        description={t('standIn.email.remove_help', { email: removing?.email })}
        confirmLabel={t('standIn.email.remove_confirm')}
        cancelLabel={t('standIn.email.cancel')}
        onConfirm={() => void removeAccount()}
        confirmTestId="stand-in-email-delete-confirm"
        pending={busy}
        destructive
        onClose={() => setRemoving(null)}
      />
    </section>
  )
}
