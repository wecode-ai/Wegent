import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { GitBranch, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type { StandInRole, StandInSourceConnection } from '@/api/personalStandIn'
import type { ConnectionProviderDescriptor, StandInExecutorApi } from '@/api/standIn'
import { GithubCliAuthDialog } from '@/components/plugins/GithubCliAuthDialog'
import type {
  LocalConnectorAuthResult,
  LocalConnectorAuthTransport,
} from '@/api/local/localConnectorAuth'
import { StandInConnectionHeader } from './StandInConnectionHeader'
import { StandInProcessingSettings } from './StandInProcessingSettings'

import { createGitConnectionsModel, GIT_CONNECTION_PREFIX } from './standInGitConnectionsModel'
export { GIT_CONNECTION_PREFIX } from './standInGitConnectionsModel'
const fieldClassName =
  'block h-11 w-full min-w-0 rounded-md border border-border bg-background px-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-secondary focus-visible:border-focus focus-visible:ring-2 focus-visible:ring-focus/20 disabled:opacity-50 md:h-9'

interface StandInGitConnectionsProps {
  role: StandInRole
  provider: ConnectionProviderDescriptor
  api: StandInExecutorApi
  deviceId: string
  disabled: boolean
  onChange(role: StandInRole): void

  userId?: number
}
export function StandInGitConnections(props: StandInGitConnectionsProps) {
  const scope = JSON.stringify([
    props.userId,
    props.role.id,
    props.role.executionDeviceId,
    props.deviceId,
    props.provider.id,
  ])
  const [owner, setOwner] = useState({ api: props.api, scope, revision: 0 })
  if (owner.api !== props.api || owner.scope !== scope)
    setOwner({ api: props.api, scope, revision: owner.revision + 1 })
  return <StandInGitConnectionsContent key={owner.revision} {...props} />
}
function StandInGitConnectionsContent({
  role,
  provider,
  api,
  deviceId,
  disabled,
  onChange,
}: StandInGitConnectionsProps) {
  const { t } = useTranslation('common')
  const platform = provider.id.slice(GIT_CONNECTION_PREFIX.length)
  const input = useMemo(() => ({ role, onChange, disabled }), [role, onChange, disabled])
  const [model] = useState(() => createGitConnectionsModel(api, deviceId, provider.id, input))
  const subscribe = useCallback(
    (listener: () => void) => model.subscribe(listener, input),
    [model, input]
  )
  const state = useSyncExternalStore(subscribe, model.getSnapshot, model.getSnapshot)
  const { instance, kind, query, items, selection, cursor, busy, searchState, auth } = state
  const error =
    state.error?.kind === 'instance'
      ? t('standIn.git.invalid_instance')
      : state.error
        ? t(`standIn.git.errors.${state.error.code}`, {
            defaultValue: t('standIn.git.request_failed'),
          })
        : undefined
  const setInstance = (value: string) => model.set('instance', value)
  const setKind = (value: string) => model.set('kind', value)
  const setQuery = (value: string) => model.set('query', value)
  const setSelection = (value: Parameters<typeof model.set<'selection'>>[1]) =>
    model.set('selection', value)
  const resetSearch = model.resetSearch
  const search = model.search
  const add = model.add
  const authTransport = useMemo<LocalConnectorAuthTransport>(
    () => ({
      start: target =>
        api.gitConnection(deviceId, {
          channel: 'auth',
          authOperation: 'start',
          ...target,
        }) as unknown as Promise<LocalConnectorAuthResult>,
      poll: (target, sessionId) =>
        api.gitConnection(deviceId, {
          channel: 'auth',
          authOperation: 'poll',
          ...target,
          sessionId,
        }) as unknown as Promise<LocalConnectorAuthResult>,
      cancel: (target, sessionId) =>
        api.gitConnection(deviceId, {
          channel: 'auth',
          authOperation: 'cancel',
          ...target,
          sessionId,
        }),
    }),
    [api, deviceId]
  )
  const rows = (role.connections ?? []).filter(row => row.providerId === provider.id)
  const remove = (row: StandInSourceConnection) => {
    onChange({ ...role, connections: (role.connections ?? []).filter(value => value !== row) })
  }
  return (
    <section className="space-y-4" data-testid={`stand-in-git-${platform}`}>
      <StandInConnectionHeader
        icon={GitBranch}
        title={provider.displayName}
        description={t('standIn.git.description')}
      />
      <div className="space-y-3 border-b border-border pb-4">
        {platform === 'gitlab' && (
          <label className="block space-y-1 text-sm">
            {t('standIn.git.instance')}
            <input
              data-testid="stand-in-git-instance"
              type="url"
              placeholder="https://gitlab.com"
              autoCapitalize="none"
              spellCheck={false}
              className={fieldClassName}
              value={instance}
              disabled={disabled || busy}
              onChange={event => {
                resetSearch()
                setInstance(event.target.value)
              }}
            />
          </label>
        )}
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-medium">{t('standIn.git.account')}</p>
            <p className="text-xs leading-relaxed text-text-secondary">
              {t('standIn.git.account_help')}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-11 shrink-0 md:h-9"
            disabled={disabled || busy}
            data-testid="stand-in-git-login"
            onClick={() => void model.login()}
          >
            {t('standIn.git.login')}
          </Button>
        </div>
      </div>
      {rows.length > 0 && (
        <h4 className="text-sm font-medium">{t('standIn.git.selected_connections')}</h4>
      )}
      {rows.map(row => (
        <div
          key={`${row.profile}:${row.kind}:${row.id}`}
          className="flex items-center gap-2 border-b border-border/50 py-2"
        >
          <div className="min-w-0 flex-1">
            <p className="break-all text-sm">{row.name}</p>
            <p className="text-xs text-text-secondary">
              {t(`standIn.git.${row.kind}`)} · {profileInstance(row.profile)}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            disabled={disabled || busy}
            data-testid={`stand-in-git-remove-${row.id}`}
            aria-label={t('standIn.workspace.remove_connection', { name: row.name })}
            onClick={() => remove(row)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <label className="block space-y-1 text-sm">
        {t('standIn.git.scope')}
        <select
          data-testid="stand-in-git-kind"
          className={fieldClassName}
          value={kind}
          disabled={disabled || busy}
          onChange={event => {
            resetSearch()
            setKind(event.target.value)
          }}
        >
          <option className="bg-background text-text-primary" value="personal">
            {t('standIn.git.personal')}
          </option>
          <option className="bg-background text-text-primary" value="repository">
            {t('standIn.git.repository')}
          </option>
        </select>
      </label>
      <div className="space-y-2">
        {kind === 'repository' && (
          <label className="block text-sm" htmlFor={`stand-in-git-query-${platform}`}>
            {t('standIn.git.search')}
          </label>
        )}
        <div className="flex items-center gap-2">
          {kind === 'repository' && (
            <input
              id={`stand-in-git-query-${platform}`}
              data-testid="stand-in-git-query"
              className={fieldClassName}
              placeholder={t('standIn.git.search_placeholder')}
              value={query}
              disabled={disabled || busy}
              onChange={event => {
                resetSearch()
                setQuery(event.target.value)
              }}
            />
          )}
          <Button
            size="sm"
            className="h-11 shrink-0 md:h-9"
            disabled={disabled || busy}
            data-testid="stand-in-git-search"
            onClick={() => void search()}
          >
            {t(kind === 'personal' ? 'standIn.git.check_account' : 'standIn.git.search')}
          </Button>
        </div>
        <p className="text-xs leading-relaxed text-text-secondary">
          {t(kind === 'personal' ? 'standIn.git.personal_help' : 'standIn.git.repository_help')}
        </p>
      </div>
      <p className="text-xs leading-relaxed text-text-secondary">{t('standIn.git.permissions')}</p>
      {(searchState === 'loading' ||
        (searchState === 'ready' && items.length === 0 && !cursor)) && (
        <p
          role="status"
          data-testid="stand-in-git-query-status"
          className="text-sm text-text-secondary"
        >
          {t(
            `standIn.git.${searchState === 'loading' ? 'loading' : 'empty'}_${kind === 'personal' ? 'account' : 'repositories'}`
          )}
        </p>
      )}
      {items.map(item => (
        <label
          key={`${item.profile}:${item.id}`}
          className="flex min-h-11 items-center gap-2 text-sm"
        >
          <input
            type="checkbox"
            data-testid={`stand-in-git-select-${item.id}`}
            disabled={disabled || busy}
            checked={selection.some(row => row.id === item.id && row.profile === item.profile)}
            onChange={event =>
              setSelection(previous =>
                event.target.checked ? [...previous, item] : previous.filter(row => row !== item)
              )
            }
          />
          {item.name}
        </label>
      ))}
      {cursor && (
        <Button
          variant="ghost"
          disabled={disabled || busy}
          data-testid="stand-in-git-more"
          onClick={() => void search(cursor)}
        >
          {t('standIn.git.more')}
        </Button>
      )}
      {selection.length > 0 && (
        <Button
          disabled={disabled || busy}
          data-testid="stand-in-git-add"
          onClick={() => void add()}
        >
          <Plus className="mr-1 h-4 w-4" />
          {t('standIn.git.add')}
        </Button>
      )}
      <StandInProcessingSettings
        disabled={disabled}
        rows={rows.map(row => ({
          key: `${row.profile}:${row.kind}:${row.id}`,
          name: row.name,
          testId: `stand-in-git-policy-${row.id}`,
          policy: row.policy,
          onChange: policy =>
            onChange({
              ...role,
              connections: (role.connections ?? []).map(value =>
                value === row ? { ...value, policy: { ...policy, askBeforeAct: true } } : value
              ),
            }),
        }))}
      />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {auth && (
        <GithubCliAuthDialog
          testId="stand-in-git-auth-dialog"
          title={t('standIn.workspace.connect_source', { name: provider.displayName })}
          target={auth}
          transport={authTransport}
          onCancel={() => model.set('auth', undefined)}
          onSuccess={model.clearAuth}
        />
      )}
    </section>
  )
}

function profileInstance(profile: string): string {
  try {
    const value: unknown = JSON.parse(profile)
    return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : ''
  } catch {
    return ''
  }
}
