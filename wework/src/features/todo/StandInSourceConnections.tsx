import { Button } from '@/components/ui/button'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { useEffect, useRef, useState } from 'react'
import { MessageSquare, Plus, Search, X } from 'lucide-react'
import type { StandInRole, StandInSourceConnection } from '@/api/personalStandIn'
import type { StandInExecutorApi, ConnectionProviderDescriptor } from '@/api/standIn'
import { LocalConnectorAuthDialog } from '@/components/plugins/LocalConnectorAuthDialog'
import { useTranslation } from '@/hooks/useTranslation'
import { StandInConnectionHeader } from './StandInConnectionHeader'
import { StandInProcessingSettings } from './StandInProcessingSettings'

type Connection = Pick<
  StandInSourceConnection,
  | 'id'
  | 'name'
  | 'kind'
  | 'profile'
  | 'providerId'
  | 'scope'
  | 'collectionKey'
  | 'configurationSummary'
>

export function StandInSourceConnections({
  role,
  provider,
  api,
  deviceId,
  localDeviceId,
  disabled,
  onChange,
  onReady,
}: {
  role: StandInRole
  provider: ConnectionProviderDescriptor
  api: StandInExecutorApi
  deviceId: string
  localDeviceId: string
  disabled: boolean
  onChange(role: StandInRole): void
  onReady?(): void
}) {
  const { t, i18n } = useTranslation('common')
  const [adding, setAdding] = useState(false)
  const [newPolicy, setNewPolicy] = useState({
    automatic: true,
    askBeforeAct: true,
    immediate: role.id !== '@primary',
  })
  const [kind, setKind] = useState(provider.resourceKinds[0] ?? '')
  const [scope, setScope] = useState<'selected' | 'all'>(
    provider.allResourceKinds?.length ? 'all' : 'selected'
  )
  const [selection, setSelection] = useState<Connection[]>([])
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Connection[]>([])
  const [nextCursor, setNextCursor] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ message: string; code?: unknown } | null>(null)
  const [searched, setSearched] = useState(false)
  const [authOpen, setAuthOpen] = useState(false)
  const latest = useRef({ role, onChange })
  useEffect(() => {
    latest.current = { role, onChange }
  }, [role, onChange])
  const allRows = role.connections ?? []
  const rows = allRows.filter(row => row.providerId === provider.id)
  const prefix =
    provider.id === '@wegent/dsh-connection-dingtalk/dingtalk'
      ? 'stand-in-dingtalk'
      : 'stand-in-connection-' + provider.id
  const updateRows = (next: StandInSourceConnection[]) =>
    onChange({
      ...role,
      connections: [...allRows.filter(row => row.providerId !== provider.id), ...next],
    })
  const searchSequence = useRef(0)
  const failSearch = (sequence: number, cause: unknown) => {
    if (sequence === searchSequence.current)
      setError({
        message: getStandInErrorMessage(cause),
        code: cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined,
      })
  }
  const search = async (cursor?: string) => {
    if (busy || !query.trim()) return
    const sequence = ++searchSequence.current
    setBusy(true)
    setError(null)
    setSearched(false)
    try {
      const result = await api.searchConnectionResources(
        deviceId,
        provider.id,
        kind,
        query.trim(),
        cursor
      )
      if (sequence !== searchSequence.current) return
      setResults(previous =>
        cursor
          ? [
              ...previous,
              ...result.items.filter(
                row =>
                  !previous.some(
                    value =>
                      value.id === row.id &&
                      value.kind === row.kind &&
                      value.profile === row.profile
                  )
              ),
            ]
          : result.items
      )
      setNextCursor(result.hasMore ? result.nextCursor : undefined)
      setSearched(true)
    } catch (cause) {
      failSearch(sequence, cause)
    } finally {
      setBusy(false)
    }
  }
  const identity = (row: Connection) => JSON.stringify([row.profile, row.kind, row.id])
  const isConnected = (row: Connection) =>
    rows.some(
      value => value.profile === row.profile && value.kind === row.kind && value.id === row.id
    )
  const add = (items: Connection[]) => {
    const current = latest.current
    let connections = [...(current.role.connections ?? [])]
    if (items.length && items.every(item => item.scope !== 'all')) {
      const covered = new Set(items.map(item => JSON.stringify([item.profile, item.kind])))
      connections = connections.filter(
        row =>
          row.providerId !== provider.id ||
          row.scope !== 'all' ||
          !covered.has(JSON.stringify([row.profile, row.kind]))
      )
    }
    for (const item of items) {
      const same = (row: StandInSourceConnection) =>
        row.providerId === provider.id && row.profile === item.profile && row.kind === item.kind
      if (item.scope === 'all') connections = connections.filter(row => !same(row))
      if (connections.some(row => same(row) && (row.id === item.id || row.scope === 'all')))
        continue
      connections.push({
        ...item,
        providerId: provider.id,
        policy: { ...newPolicy },
      })
    }
    current.onChange({ ...current.role, connections })
    setSelection([])
    setAdding(false)
  }
  const addAll = async () => {
    if (busy || disabled) return
    const sequence = ++searchSequence.current
    setBusy(true)
    setError(null)
    try {
      const kinds = provider.allResourceKinds ?? []
      const pages = await Promise.all(
        kinds.map(resourceKind =>
          api.searchConnectionResources(deviceId, provider.id, resourceKind, '', undefined, 'all')
        )
      )
      if (sequence !== searchSequence.current) return
      const items = pages.map((page, index) => {
        const item = page.items[0]
        if (
          page.items.length !== 1 ||
          item?.scope !== 'all' ||
          item.id !== '*' ||
          item.kind !== kinds[index] ||
          !item.profile ||
          item.providerId !== provider.id
        )
          throw Object.assign(new Error('Invalid all-resource selection'), {
            code: 'connection_response_invalid',
          })
        return {
          ...item,
          name: provider.allResourceLabels?.[item.kind] ?? t('standIn.workspace.all_resources'),
        }
      })
      if (!items.length || new Set(items.map(item => item.profile)).size !== 1)
        throw Object.assign(new Error('Connection account changed'), {
          code: 'connection_response_invalid',
        })
      add(items)
    } catch (cause) {
      failSearch(sequence, cause)
    } finally {
      setBusy(false)
    }
  }
  const authorization = authOpen && provider.authTarget && (
    <LocalConnectorAuthDialog
      open
      target={provider.authTarget}
      title={t('standIn.workspace.connect_source', { name: provider.displayName })}
      onCancel={() => setAuthOpen(false)}
      onSuccess={() => {
        setAuthOpen(false)
        setError(null)
        onReady?.()
      }}
    />
  )
  const connectedScope = (
    <div className="space-y-2">
      {rows.map(row => (
        <div
          key={`${row.profile}:${row.kind}:${row.id}`}
          className="flex flex-wrap items-center gap-2 border-b border-border/50 py-2"
        >
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm">{row.name}</p>
            <p className="text-xs text-text-muted">
              {provider.resourceLabels?.[row.kind] ?? row.kind}
              {' · '}
              {row.configurationSummary ?? t('standIn.workspace.connection_default_configuration')}
            </p>
          </div>
          {provider.id === '@wegent/dsh-connection-dingtalk/dingtalk' &&
            row.kind === 'group' &&
            row.scope !== 'all' && (
              <label className="flex min-h-11 items-center gap-2 text-sm md:min-h-8">
                {t('standIn.workspace.group_message_scope')}
                <select
                  data-testid={`${prefix}-message-scope-${row.id}`}
                  aria-label={t('standIn.workspace.group_message_scope_for', { name: row.name })}
                  value={row.collectionKey ?? 'mentions'}
                  disabled={disabled}
                  onChange={event => {
                    const allMessages = event.target.value === 'all-messages'
                    updateRows(
                      rows.map(value => {
                        if (value !== row) return value
                        const next = { ...value }
                        if (allMessages) next.collectionKey = 'all-messages'
                        else delete next.collectionKey
                        next.configurationSummary = t(
                          allMessages
                            ? 'standIn.workspace.group_all_messages'
                            : 'standIn.workspace.group_mentions'
                        )
                        return next
                      })
                    )
                  }}
                  className="min-h-11 rounded-md border border-border bg-background px-2 text-sm text-text-primary md:min-h-8 [&>option]:bg-background [&>option]:text-text-primary"
                >
                  <option value="mentions">{t('standIn.workspace.group_mentions')}</option>
                  <option value="all-messages">{t('standIn.workspace.group_all_messages')}</option>
                </select>
              </label>
            )}
          <button
            type="button"
            data-testid={`${prefix}-remove-${row.id}`}
            aria-label={t('standIn.workspace.remove_connection', { name: row.name })}
            disabled={disabled}
            onClick={() => updateRows(rows.filter(value => value !== row))}
            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  )
  if (provider.availability.status === 'auth_required' || error?.code === 'connector_auth_required')
    return (
      <section className="space-y-4" data-testid={`${prefix}-authorization`}>
        <StandInConnectionHeader
          icon={MessageSquare}
          title={provider.displayName}
          description={t('standIn.workspace.message_connection_help')}
        />
        <p role="alert" className="text-sm text-text-muted">
          {t('standIn.errors.connector_auth_required')}
        </p>
        {provider.authTarget && deviceId === localDeviceId ? (
          <button
            type="button"
            data-testid={`${prefix}-connect`}
            disabled={disabled}
            onClick={() => setAuthOpen(true)}
            className="min-h-9 text-sm underline"
          >
            {t('standIn.workspace.connect_source', { name: provider.displayName })}
          </button>
        ) : (
          <p className="text-sm text-text-muted">{t('standIn.workspace.authorize_on_device')}</p>
        )}
        {connectedScope}
        {authorization}
      </section>
    )
  const showAdding = adding || rows.length === 0
  return (
    <section className="space-y-4" data-testid={`${prefix}-connections`}>
      <StandInConnectionHeader
        icon={MessageSquare}
        title={provider.displayName}
        description={t('standIn.workspace.message_connection_help')}
      />
      {connectedScope}
      {!showAdding && (
        <button
          type="button"
          data-testid={`${prefix}-add`}
          disabled={disabled}
          onClick={() => {
            setAdding(value => !value)
            setSelection([])
            setError(null)
          }}
          className="inline-flex min-h-9 items-center gap-2 text-sm text-text-secondary hover:underline"
        >
          <Plus className="h-4 w-4" />
          {t('standIn.workspace.add_connection')}
        </button>
      )}
      {showAdding && (
        <form
          onSubmit={event => {
            event.preventDefault()
            void search()
          }}
          className="space-y-3"
        >
          <div className="flex flex-wrap gap-2">
            {scope === 'selected' && (
              <select
                aria-label={t('standIn.workspace.message_kind')}
                data-testid={`${prefix}-kind`}
                value={kind}
                disabled={busy}
                onChange={event => {
                  searchSequence.current += 1
                  setKind(event.target.value)
                  setScope('selected')
                  setResults([])
                  setNextCursor(undefined)
                  setSearched(false)
                }}
                className="min-h-9 rounded-md border border-border bg-background px-2 text-sm"
              >
                {provider.resourceKinds.map(resourceKind => (
                  <option key={resourceKind} value={resourceKind}>
                    {provider.resourceLabels?.[resourceKind] ?? resourceKind}
                  </option>
                ))}
              </select>
            )}
            {scope === 'selected' && (
              <>
                <input
                  aria-label={t('standIn.workspace.search_connections')}
                  data-testid={`${prefix}-query`}
                  value={query}
                  onChange={event => {
                    searchSequence.current += 1
                    setQuery(event.target.value)
                    setResults([])
                    setNextCursor(undefined)
                    setSearched(false)
                  }}
                  className="min-h-9 min-w-0 flex-1 rounded-md border border-border bg-transparent px-3 text-sm"
                  placeholder={t('standIn.workspace.search_connections')}
                />
                <button
                  type="submit"
                  data-testid={`${prefix}-search`}
                  disabled={disabled || busy || !query.trim()}
                  className="flex min-h-9 items-center gap-1 rounded-md border border-border px-3 text-sm disabled:opacity-50"
                >
                  <Search className="h-4 w-4" />
                  {t('standIn.workspace.search')}
                </button>
              </>
            )}
          </div>
          {Boolean(provider.allResourceKinds?.length) && (
            <fieldset className="flex flex-wrap gap-4" disabled={disabled || busy}>
              <legend className="mb-2 w-full text-sm font-medium">
                {t('standIn.workspace.connection_scope')}
              </legend>
              {(['all', 'selected'] as const).map(value => (
                <label key={value} className="flex min-h-8 items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name={`${prefix}-scope`}
                    data-testid={`${prefix}-scope-${value}`}
                    checked={scope === value}
                    onChange={() => {
                      searchSequence.current += 1
                      setScope(value)
                      setError(null)
                    }}
                  />
                  {value === 'all'
                    ? (provider.allResourceLabel ?? t('standIn.workspace.all_resources'))
                    : t('standIn.workspace.selected_resources')}
                </label>
              ))}
            </fieldset>
          )}
          {scope === 'all' && (
            <div className="space-y-3">
              <p className="text-sm text-text-muted">
                {t('standIn.workspace.all_resources_help')}{' '}
                {new Intl.ListFormat(i18n.language, { style: 'long', type: 'conjunction' }).format(
                  (provider.allResourceKinds ?? []).map(
                    resourceKind =>
                      provider.allResourceLabels?.[resourceKind] ??
                      provider.resourceLabels?.[resourceKind] ??
                      resourceKind
                  )
                )}
              </p>
              <Button
                size="sm"
                type="button"
                data-testid={`${prefix}-add-all`}
                disabled={disabled || busy}
                onClick={() => void addAll()}
                className="h-8"
              >
                {t('standIn.workspace.connect_all')}
              </Button>
            </div>
          )}
          {busy && (
            <p role="status" className="text-sm text-text-muted">
              {t('standIn.loading')}
            </p>
          )}
          {error && (
            <div role="alert" className="space-y-2 text-sm text-error">
              <p>{error.message}</p>
            </div>
          )}
          {scope === 'selected' && searched && !results.length && (
            <p className="text-sm text-text-muted">{t('standIn.workspace.no_connections_found')}</p>
          )}
          {scope === 'selected' && (
            <>
              {results.some(row => !isConnected(row)) && (
                <button
                  type="button"
                  data-testid={`${prefix}-select-results`}
                  disabled={disabled || busy}
                  className="min-h-8 text-sm underline"
                  onClick={() =>
                    setSelection(previous => [
                      ...previous,
                      ...results.filter(
                        row =>
                          !isConnected(row) &&
                          !previous.some(value => identity(value) === identity(row))
                      ),
                    ])
                  }
                >
                  {t('standIn.workspace.select_results')}
                </button>
              )}
              <div className="max-h-52 overflow-y-auto">
                {results.map(row => {
                  const connected = isConnected(row)
                  const selected = selection.some(value => identity(value) === identity(row))
                  return (
                    <button
                      key={identity(row)}
                      type="button"
                      role="checkbox"
                      aria-checked={connected || selected}
                      data-testid={`${prefix}-result-${row.id}`}
                      disabled={disabled || connected}
                      onClick={() =>
                        setSelection(previous =>
                          selected
                            ? previous.filter(value => identity(value) !== identity(row))
                            : [...previous, row]
                        )
                      }
                      className="flex min-h-9 w-full items-center justify-between gap-3 rounded-md px-2 text-left text-sm hover:bg-muted disabled:text-text-muted"
                    >
                      <span>{row.name}</span>
                      <span>
                        {t(
                          connected
                            ? 'standIn.workspace.connected'
                            : selected
                              ? 'standIn.workspace.resource_selected'
                              : 'standIn.workspace.select_resource'
                        )}
                      </span>
                    </button>
                  )
                })}
              </div>
              {nextCursor && (
                <button
                  type="button"
                  data-testid={`${prefix}-search-more`}
                  disabled={busy || disabled}
                  className="min-h-9 text-sm underline"
                  onClick={() => void search(nextCursor)}
                >
                  {t('standIn.workspace.load_more')}
                </button>
              )}
              {selection.length > 0 && (
                <div className="flex items-center gap-3">
                  <Button
                    size="sm"
                    type="button"
                    data-testid={`${prefix}-add-selected`}
                    disabled={disabled || busy}
                    className="min-h-9 rounded-md bg-text-primary px-3 text-sm text-background disabled:opacity-50"
                    onClick={() => add(selection)}
                  >
                    {t('standIn.workspace.add_selected', { count: selection.length })}
                  </Button>
                  <button
                    type="button"
                    data-testid={`${prefix}-clear-selection`}
                    disabled={disabled || busy}
                    className="min-h-9 text-sm underline"
                    onClick={() => setSelection([])}
                  >
                    {t('standIn.workspace.clear_selection')}
                  </button>
                </div>
              )}
            </>
          )}
          <p className="text-xs text-text-muted">{t('standIn.workspace.connection_help')}</p>
        </form>
      )}
      <StandInProcessingSettings
        disabled={disabled}
        rows={
          rows.length
            ? rows.map(row => ({
                key: identity(row),
                name: row.name,
                policy: row.policy,
                outbound: provider.id === '@wegent/dsh-connection-dingtalk/dingtalk',
                testId: `${prefix}-policy-${row.id}`,
                onChange: policy =>
                  updateRows(rows.map(value => (value === row ? { ...value, policy } : value))),
              }))
            : [
                {
                  key: 'new',
                  name: provider.displayName,
                  policy: newPolicy,
                  outbound: provider.id === '@wegent/dsh-connection-dingtalk/dingtalk',
                  testId: `${prefix}-new-policy`,
                  onChange: policy =>
                    setNewPolicy({ ...policy, immediate: policy.immediate ?? false }),
                },
              ]
        }
      />
      {authorization}
    </section>
  )
}
