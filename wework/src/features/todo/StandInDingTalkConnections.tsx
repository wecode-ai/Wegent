import { useState } from 'react'
import { Plus, Search, X } from 'lucide-react'
import type { StandInRole, StandInDingTalkConnection } from '@/api/personalStandIn'
import type { StandInExecutorApi } from '@/api/standIn'
import { LocalConnectorAuthDialog } from '@/components/plugins/LocalConnectorAuthDialog'
import { useTranslation } from '@/hooks/useTranslation'
import { StandInHandlingSelect } from './StandInHandlingSelect'

type Connection = Pick<StandInDingTalkConnection, 'id' | 'name' | 'kind' | 'profile'>

export function StandInDingTalkConnections({
  role,
  api,
  deviceId,
  localDeviceId,
  disabled,
  onChange,
}: {
  role: StandInRole
  api: StandInExecutorApi
  deviceId: string
  localDeviceId: string
  disabled: boolean
  onChange(role: StandInRole): void
}) {
  const { t } = useTranslation('common')
  const [adding, setAdding] = useState(false)
  const [kind, setKind] = useState<'group' | 'direct'>('group')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Connection[]>([])
  const [nextCursor, setNextCursor] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searched, setSearched] = useState(false)
  const [authOpen, setAuthOpen] = useState(false)
  const rows = role.dingtalk ?? []
  const search = async (cursor?: string) => {
    if (busy || !query.trim()) return
    setBusy(true)
    setError(null)
    setSearched(false)
    try {
      const result = await api.searchDingTalk(deviceId, kind, query.trim(), cursor)
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
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section
      className="space-y-3 border-t border-border pt-4"
      data-testid="stand-in-dingtalk-connections"
    >
      <h3 className="font-medium">{t('standIn.workspace.dingtalk')}</h3>
      {rows.map(row => (
        <div
          key={`${row.profile}:${row.kind}:${row.id}`}
          className="flex flex-wrap items-center gap-2 border-b border-border/50 py-2"
        >
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm">{row.name}</p>
            <p className="text-xs text-text-muted">
              {t(
                row.kind === 'group'
                  ? 'standIn.workspace.group_mentions'
                  : 'standIn.workspace.direct_messages'
              )}
            </p>
          </div>
          <StandInHandlingSelect
            policy={row.policy}
            disabled={disabled}
            label={t('standIn.workspace.handling_for', { name: row.name })}
            testId={`stand-in-dingtalk-policy-${row.id}`}
            onChange={policy =>
              onChange({
                ...role,
                dingtalk: rows.map(value => (value === row ? { ...value, policy } : value)),
              })
            }
          />
          <button
            type="button"
            data-testid={`stand-in-dingtalk-remove-${row.id}`}
            aria-label={t('standIn.workspace.remove_connection', { name: row.name })}
            disabled={disabled}
            onClick={() => onChange({ ...role, dingtalk: rows.filter(value => value !== row) })}
            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
      <button
        type="button"
        data-testid="stand-in-dingtalk-add"
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
              data-testid="stand-in-dingtalk-kind"
              value={kind}
              disabled={busy}
              onChange={event => {
                setKind(event.target.value as 'group' | 'direct')
                setResults([])
                setNextCursor(undefined)
                setSearched(false)
              }}
              className="min-h-9 rounded-md border border-border bg-background px-2 text-sm"
            >
              <option value="group">{t('standIn.workspace.group_mentions')}</option>
              <option value="direct">{t('standIn.workspace.direct_messages')}</option>
            </select>
            <input
              aria-label={t('standIn.workspace.search_connections')}
              data-testid="stand-in-dingtalk-query"
              value={query}
              onChange={event => {
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
              data-testid="stand-in-dingtalk-search"
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
              {error.includes('connector_auth_required') && deviceId === localDeviceId && (
                <button
                  type="button"
                  data-testid="stand-in-dingtalk-connect"
                  onClick={() => setAuthOpen(true)}
                  className="min-h-9 underline"
                >
                  {t('standIn.workspace.connect_dingtalk')}
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
                  data-testid={`stand-in-dingtalk-result-${row.id}`}
                  disabled={disabled || selected}
                  onClick={() =>
                    onChange({
                      ...role,
                      dingtalk: [
                        ...rows,
                        { ...row, policy: { automatic: true, askBeforeAct: true } },
                      ],
                    })
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
              data-testid="stand-in-dingtalk-search-more"
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
      {authOpen && (
        <LocalConnectorAuthDialog
          open
          target={{ pluginKey: 'dingtalk', connectorSlug: 'dingtalk' }}
          title={t('standIn.workspace.connect_dingtalk')}
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
