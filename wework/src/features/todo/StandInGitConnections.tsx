import type {
  LocalConnectorAuthResult,
  LocalConnectorAuthTransport,
} from '@/api/local/localConnectorAuth'
import type { StandInRole, StandInSourceConnection } from '@/api/personalStandIn'
import type { ConnectionProviderDescriptor, StandInExecutorApi } from '@/api/standIn'
import { GithubCliAuthDialog } from '@/components/plugins/GithubCliAuthDialog'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { Checkbox } from '@wegent/collaboration/controls/Checkbox'
import { TextField as ControlInput } from '@wegent/collaboration/controls/TextField'
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import {
  createGitConnectionsModel,
  GIT_CONNECTION_PREFIX,
  instanceOrigin,
  profileInstance,
  resourceKey,
} from './standInGitConnectionsModel'
import { ConnectionScopeList, ConnectionScopeRow } from './ConnectionScopeList'
import { useConnectionScopeBack, useConnectionScopeTitle } from './connectionScopeNavigation'
import { StandInConnectionForm } from './StandInConnectionForm'
import { StandInProcessingSettings } from './StandInProcessingSettings'

export { GIT_CONNECTION_PREFIX } from './standInGitConnectionsModel'

interface StandInGitConnectionsProps {
  role: StandInRole
  savedConnections?: readonly StandInSourceConnection[]
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
  savedConnections,
  provider,
  api,
  deviceId,
  disabled,
  onChange,
}: StandInGitConnectionsProps) {
  const { t } = useTranslation('common')
  const platform = provider.id.slice(GIT_CONNECTION_PREFIX.length)
  const input = useMemo(
    () => ({ role, savedConnections, onChange, disabled }),
    [role, savedConnections, onChange, disabled]
  )
  const [model] = useState(() => createGitConnectionsModel(api, deviceId, provider.id, input))
  const subscribe = useCallback(
    (listener: () => void) => model.subscribe(listener, input),
    [model, input]
  )
  const state = useSyncExternalStore(subscribe, model.getSnapshot, model.getSnapshot)
  const { instance, query, cursor, busy, searchState, auth, accountStatus, accounts } = state
  const [editing, setEditing] = useState<'choose' | 'personal' | 'repository' | 'item' | null>(null)
  const [scopeKey, setScopeKey] = useState<string | null>(null)
  const canSelectScope = accountStatus === 'ready'
  const invalidInstance = platform === 'gitlab' && !instanceOrigin(instance)
  const error =
    state.error?.kind === 'instance'
      ? t('standIn.git.invalid_instance')
      : state.error
        ? t(`standIn.git.errors.${state.error.code}`, {
            defaultValue: t('standIn.git.request_failed'),
          })
        : undefined
  const setKind = (value: string) => model.set('kind', value)
  const setQuery = (value: string) => model.set('query', value)
  const resetSearch = model.resetSearch
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
  const profiles = new Set(accounts.map(account => account.profile))
  const currentRows = rows.filter(row => profiles.has(row.profile))
  const otherRows = rows.filter(row => !profiles.has(row.profile))
  const personal = currentRows.filter(row => row.kind === 'personal')
  const repositories = currentRows.filter(row => row.kind === 'repository')
  const editedScope =
    editing === 'item' ? currentRows.find(row => resourceKey(row) === scopeKey) : undefined
  const setScopeTitle = useConnectionScopeTitle()
  const scopeKindTitle = (kind: 'personal' | 'repository') =>
    t(
      kind === 'personal'
        ? 'standIn.workspace.connection_git_personal_type'
        : 'standIn.workspace.connection_git_repository_type'
    )
  const openScope = (next: typeof editing, title: string | null) => {
    setEditing(next)
    setScopeTitle?.(title)
  }
  const chooseScope = () => openScope('choose', t('standIn.workspace.connection_add_scope'))
  const searchRepositories = async (page?: string) => {
    await model.search(page)
    if (model.getSnapshot().accountStatus !== 'ready') openScope(null, null)
  }
  const editKind = (value: 'personal' | 'repository') => {
    resetSearch()
    setQuery('')
    setKind(value)
    openScope(value, scopeKindTitle(value))
  }
  useConnectionScopeBack(
    editing && canSelectScope
      ? () => {
          resetSearch()
          if (editing === 'personal' || editing === 'repository') chooseScope()
          else openScope(null, null)
        }
      : null
  )
  const results = new Map([...state.items, ...repositories].map(row => [resourceKey(row), row]))
  const selected = new Set(repositories.map(resourceKey))
  return (
    <section className="space-y-4" data-testid={`stand-in-git-${platform}`}>
      <StandInConnectionForm
        compact
        account={
          <div className="flex flex-wrap items-end gap-3">
            {platform === 'gitlab' && (
              <label className="block min-w-48 flex-1 space-y-1 text-sm">
                {t('standIn.git.instance')}
                <ControlInput
                  data-testid="stand-in-git-instance"
                  type="url"
                  placeholder="https://gitlab.com"
                  autoCapitalize="none"
                  spellCheck={false}
                  className="block w-full min-w-0 transition-colors placeholder:text-text-secondary disabled:opacity-50"
                  value={instance}
                  disabled={disabled || busy}
                  onChange={event => {
                    model.setInstance(event.target.value)
                    openScope(null, null)
                  }}
                  onBlur={() => {
                    if (accountStatus === 'unavailable' && instanceOrigin(instance))
                      void model.checkAccount()
                  }}
                />
              </label>
            )}
            {accountStatus === 'signed_out' && (
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
            )}
            {accountStatus === 'checking' && (
              <p role="status" className="text-sm text-text-secondary">
                {t('standIn.git.loading_account')}
              </p>
            )}
            {accountStatus === 'unavailable' && !invalidInstance && (
              <Button
                variant="outline"
                size="sm"
                disabled={disabled || busy || !instanceOrigin(instance)}
                data-testid="stand-in-git-recheck-account"
                onClick={() => void model.checkAccount()}
              >
                {t('standIn.reload')}
              </Button>
            )}
            {invalidInstance && (
              <p
                role="alert"
                data-testid="stand-in-git-instance-invalid"
                className="text-sm text-destructive"
              >
                {t('standIn.git.invalid_instance')}
              </p>
            )}
            {accounts.map(account => (
              <div key={account.profile} className="min-w-0 space-y-1 text-sm">
                <p className="break-words font-medium">
                  {account.name.endsWith(` · ${profileInstance(account.profile)}`)
                    ? account.name.slice(0, -` · ${profileInstance(account.profile)}`.length)
                    : account.name}
                </p>
              </div>
            ))}
          </div>
        }
        scope={
          <>
            {accountStatus === 'signed_out' && !invalidInstance && (
              <p
                className="text-sm text-text-secondary"
                data-testid="stand-in-git-scope-requires-account"
              >
                {t('standIn.git.scope_requires_account')}
              </p>
            )}
            {canSelectScope && !editing && (
              <ConnectionScopeList
                empty={
                  currentRows.length ? undefined : t('standIn.workspace.connection_not_configured')
                }
                disabled={disabled || busy}
                testId="stand-in-git-add-scope"
                onAdd={chooseScope}
              >
                {currentRows.map(row => (
                  <ConnectionScopeRow
                    key={resourceKey(row)}
                    name={row.name}
                    description={
                      row.configurationSummary ??
                      t(
                        row.kind === 'personal'
                          ? 'standIn.workspace.connection_git_personal_type'
                          : 'standIn.workspace.connection_git_repository_type'
                      )
                    }
                    disabled={disabled || busy}
                    testId={`stand-in-git-open-scope-${row.kind}-${row.id}`}
                    onRemove={() => model.changeScope([row])}
                    onClick={() => {
                      setScopeKey(resourceKey(row))
                      openScope('item', row.name)
                    }}
                  />
                ))}
              </ConnectionScopeList>
            )}
            {canSelectScope && editedScope && (
              <div className="space-y-2">
                {editedScope.configurationSummary && (
                  <p className="text-sm text-text-secondary">{editedScope.configurationSummary}</p>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  disabled={disabled || busy}
                  data-testid={`stand-in-git-remove-scope-${editedScope.id}`}
                  onClick={() => {
                    model.changeScope([editedScope])
                    openScope(null, null)
                  }}
                >
                  {t('standIn.workspace.connection_remove_scope')}
                </Button>
              </div>
            )}
            {canSelectScope && editing === 'choose' && (
              <ul className="divide-y divide-border">
                <ConnectionScopeRow
                  name={scopeKindTitle('personal')}
                  testId="stand-in-git-kind-personal"
                  disabled={disabled || busy}
                  onClick={() => editKind('personal')}
                />
                <ConnectionScopeRow
                  name={scopeKindTitle('repository')}
                  testId="stand-in-git-kind-repository"
                  disabled={disabled || busy}
                  onClick={() => editKind('repository')}
                />
              </ul>
            )}
            {canSelectScope && editing === 'personal' && (
              <div className="space-y-2">
                {accounts.map(account => {
                  const row = personal.find(item => item.profile === account.profile)
                  return (
                    <label
                      key={account.profile}
                      className="flex min-h-11 items-center gap-2 text-sm"
                    >
                      <Checkbox
                        data-testid={`stand-in-git-personal-${account.id}`}
                        checked={Boolean(row)}
                        disabled={disabled || busy}
                        onCheckedChange={checked =>
                          model.changeScope(
                            checked === true || !row ? [] : [row],
                            checked === true ? [account] : []
                          )
                        }
                      />
                      <span className="min-w-0 break-words">{account.name}</span>
                    </label>
                  )
                })}
              </div>
            )}
            {canSelectScope && editing === 'repository' && (
              <>
                <form
                  className="flex items-center gap-2"
                  onSubmit={event => {
                    event.preventDefault()
                    void searchRepositories()
                  }}
                >
                  <ControlInput
                    data-testid="stand-in-git-query"
                    className="min-w-0 flex-1"
                    aria-label={t('standIn.git.search_placeholder')}
                    placeholder={t('standIn.git.search_placeholder')}
                    value={query}
                    disabled={disabled}
                    onChange={event => {
                      resetSearch()
                      setQuery(event.target.value)
                    }}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    type="submit"
                    className="shrink-0"
                    disabled={disabled || busy || !query.trim()}
                    data-testid="stand-in-git-search"
                  >
                    {t('standIn.git.search')}
                  </Button>
                </form>
                {(searchState === 'loading' ||
                  (searchState === 'ready' && state.items.length === 0 && !cursor)) && (
                  <p
                    role="status"
                    data-testid="stand-in-git-query-status"
                    className="text-sm text-text-secondary"
                  >
                    {t(
                      searchState === 'loading'
                        ? 'standIn.git.loading_repositories'
                        : 'standIn.git.empty_repositories'
                    )}
                  </p>
                )}
                {results.size > 0 && (
                  <div className="max-h-40 overflow-y-auto">
                    {[...results].map(([key, item]) => (
                      <label
                        key={key}
                        className="flex min-h-11 items-center gap-2 text-sm md:min-h-8"
                      >
                        <Checkbox
                          data-testid={`stand-in-git-select-${item.id}`}
                          disabled={disabled || busy}
                          checked={selected.has(key)}
                          onCheckedChange={checked =>
                            model.changeScope(
                              checked === true ? [] : [item],
                              checked === true ? [item] : []
                            )
                          }
                        />
                        <span className="min-w-0 break-words">
                          {item.name}
                          {item.configurationSummary && (
                            <span className="block text-xs text-text-secondary">
                              {item.configurationSummary}
                            </span>
                          )}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
                {cursor && (
                  <Button
                    variant="ghost"
                    disabled={disabled || busy}
                    data-testid="stand-in-git-more"
                    onClick={() => void searchRepositories(cursor)}
                  >
                    {t('standIn.git.more')}
                  </Button>
                )}
              </>
            )}
            {!editing && otherRows.length > 0 && (
              <div className="space-y-1">
                <p className="text-sm font-medium">
                  {t('standIn.workspace.connection_other_accounts')}
                </p>
                {otherRows.map(row => (
                  <label
                    key={resourceKey(row)}
                    className="flex min-h-11 items-center gap-2 text-sm md:min-h-8"
                  >
                    <Checkbox
                      data-testid={`stand-in-git-remove-${row.id}`}
                      checked
                      disabled={disabled || busy}
                      onCheckedChange={() => model.changeScope([row])}
                    />
                    <span className="min-w-0 break-words">
                      {row.name}
                      {row.configurationSummary && (
                        <span className="block text-xs text-text-secondary">
                          {row.configurationSummary}
                        </span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </>
        }
        trigger={
          editedScope && (
            <p className="text-sm text-text-secondary">
              {t('standIn.workspace.connection_git_trigger')}
            </p>
          )
        }
        processing={
          <StandInProcessingSettings
            compact
            disabled={disabled}
            rows={(editedScope ? [editedScope] : []).map(row => ({
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
        }
      />
      {(error || (accountStatus === 'unavailable' && !invalidInstance)) && (
        <p role="alert" className="text-sm text-destructive">
          {error ?? t('standIn.git.empty_account')}
        </p>
      )}
      {auth && (
        <GithubCliAuthDialog
          testId="stand-in-git-auth-dialog"
          title={t('standIn.workspace.connect_source', { name: provider.displayName })}
          target={auth}
          transport={authTransport}
          onCancel={() => model.set('auth', undefined)}
          onSuccess={() => {
            model.clearAuth()
            void model.checkAccount()
          }}
        />
      )}
    </section>
  )
}
