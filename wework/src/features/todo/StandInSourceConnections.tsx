import { useRef, useState } from 'react'
import { Plus, Search, X } from 'lucide-react'
import type { StandInRole, StandInSourceConnection } from '@/api/personalStandIn'
import type { StandInExecutorApi, ConnectionProviderDescriptor } from '@/api/standIn'
import { LocalConnectorAuthDialog } from '@/components/plugins/LocalConnectorAuthDialog'
import { useTranslation } from '@/hooks/useTranslation'
import { StandInHandlingSelect } from './StandInHandlingSelect'

type Connection = Pick<StandInSourceConnection, 'id' | 'name' | 'kind' | 'profile' | 'providerId'>

export function StandInSourceConnections({
  role,
  provider,
  api,
  deviceId,
  localDeviceId,
  disabled,
  onChange,
}: {
  role: StandInRole
  provider: ConnectionProviderDescriptor
  api: StandInExecutorApi
  deviceId: string
  localDeviceId: string
  disabled: boolean
  onChange(role: StandInRole): void
}) {
  const { t } = useTranslation('common')
  const [adding, setAdding] = useState(false)
  const [kind, setKind] = useState(provider.resourceKinds[0] ?? '')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Connection[]>([])
  const [nextCursor, setNextCursor] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searched, setSearched] = useState(false)
  const [authOpen, setAuthOpen] = useState(false)
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
      if (sequence === searchSequence.current) setError(String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section
      className="space-y-3 border-t border-border pt-4"
      data-testid={`${prefix}-connections`}
    >
      <h3 className="font-medium">{provider.displayName}</h3>
      {rows.map(row => (
        <div
          key={`${row.profile}:${row.kind}:${row.id}`}
          className="flex flex-wrap items-center gap-2 border-b border-border/50 py-2"
        >
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm">{row.name}</p>
            <p className="text-xs text-text-muted">
              {provider.resourceLabels?.[row.kind] ?? row.kind}
            </p>
          </div>
          <StandInHandlingSelect
            policy={row.policy}
            disabled={disabled}
            label={t('standIn.workspace.handling_for', { name: row.name })}
            testId={`${prefix}-policy-${row.id}`}
            onChange={policy =>
              updateRows(rows.map(value => (value === row ? { ...value, policy } : value)))
            }
          />
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
      <button
        type="button"
        data-testid={`${prefix}-add`}
        disabled={disabled}
        onClick={() => setAdding(value => !value)}
        className="inline-flex min-h-9 items-center gap-2 text-sm text-text-secondary hover:underline"
      >
        <Plus className="h-4 w-4" />
        {t('standIn.workspace.add_connection')}
      </button>
      {adding && (
        <form
          onSubmit={event => {
            event.preventDefault()
            void search()
          }}
          className="space-y-3"
        >
          <div className="flex flex-wrap gap-2">
            <select
              aria-label={t('standIn.workspace.message_kind')}
              data-testid={`${prefix}-kind`}
              value={kind}
              disabled={busy}
              onChange={event => {
                searchSequence.current += 1
                setKind(event.target.value)
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
          </div>
          {busy && (
            <p role="status" className="text-sm text-text-muted">
              {t('standIn.loading')}
            </p>
          )}
          {error && (
            <div role="alert" className="space-y-2 text-sm text-error">
              <p>{error}</p>
              {error.includes('connector_auth_required') &&
                provider.authTarget &&
                deviceId === localDeviceId && (
                  <button
                    type="button"
                    data-testid={`${prefix}-connect`}
                    onClick={() => setAuthOpen(true)}
                    className="min-h-9 underline"
                  >
                    {t('standIn.workspace.connect_source', { name: provider.displayName })}
                  </button>
                )}
            </div>
          )}
          {searched && !results.length && (
            <p className="text-sm text-text-muted">{t('standIn.workspace.no_connections_found')}</p>
          )}
          <div className="max-h-52 overflow-y-auto">
            {results.map(row => {
              const selected = rows.some(
                value =>
                  value.profile === row.profile && value.id === row.id && value.kind === row.kind
              )
              return (
                <button
                  key={`${row.profile}:${row.kind}:${row.id}`}
                  type="button"
                  data-testid={`${prefix}-result-${row.id}`}
                  disabled={disabled || selected}
                  onClick={() =>
                    updateRows([
                      ...rows,
                      {
                        ...row,
                        providerId: provider.id,
                        policy: { automatic: true, askBeforeAct: true },
                      },
                    ])
                  }
                  className="flex min-h-9 w-full items-center justify-between rounded-md px-2 text-left text-sm hover:bg-muted disabled:text-text-muted"
                >
                  <span>{row.name}</span>
                  <span>
                    {t(selected ? 'standIn.workspace.connected' : 'standIn.workspace.add')}
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
          <p className="text-xs text-text-muted">{t('standIn.workspace.connection_help')}</p>
        </form>
      )}
      {authOpen && provider.authTarget && (
        <LocalConnectorAuthDialog
          open
          target={provider.authTarget!}
          title={t('standIn.workspace.connect_source', { name: provider.displayName })}
          onCancel={() => setAuthOpen(false)}
          onSuccess={() => {
            setAuthOpen(false)
            void search()
          }}
        />
      )}
    </section>
  )
}
