import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronRight, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { useTranslation } from '@/hooks/useTranslation'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import {
  listMcpServers,
  getCachedMcpServers,
  reloadMcpServers,
  saveMcpServer,
  loginMcpServer,
  type McpEntry,
} from '@/api/local/capabilities'
import { McpServerDialog } from './McpServerDialog'

export function McpPanel() {
  const { t } = useTranslation('capabilities')
  const cachedResult = getCachedMcpServers()
  const [entries, setEntries] = useState<McpEntry[]>(() => cachedResult?.entries ?? [])
  const [loading, setLoading] = useState(() => !cachedResult)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [editing, setEditing] = useState<McpEntry | 'new' | null>(null)
  const [removing, setRemoving] = useState<McpEntry | null>(null)
  const [expandedServers, setExpandedServers] = useState<Set<string>>(() => new Set())
  const requestId = useRef(0)
  const refresh = useCallback(
    async (reload = false) => {
      const id = ++requestId.current
      let reloadFailed = false
      try {
        if (reload) {
          await reloadMcpServers().catch(() => {
            reloadFailed = true
          })
        }
        const result = await listMcpServers(progress => {
          if (id === requestId.current) setEntries(progress.entries)
        })
        if (id !== requestId.current) return
        setEntries(result.entries)
        setError(reloadFailed ? t('reloadFailed') : result.statusError ? t('statusFailed') : '')
      } catch {
        if (id === requestId.current) setError(t('loadFailed'))
      } finally {
        if (id === requestId.current) setLoading(false)
      }
    },
    [t]
  )
  useEffect(() => {
    void refresh()
    return () => {
      requestId.current += 1
    }
  }, [refresh])
  async function update(entry: McpEntry, remove = false) {
    if (!entry.config) return
    setBusy(true)
    setError('')
    try {
      await saveMcpServer(
        entry.name,
        remove ? null : { ...entry.config, enabled: entry.config.enabled === false }
      )
      setRemoving(null)
      await refresh(true)
    } catch {
      setError(t('updateFailed'))
      setRemoving(null)
    } finally {
      setBusy(false)
    }
  }
  async function login(name: string) {
    setBusy(true)
    setError('')
    try {
      const url = await loginMcpServer(name)
      await invokeDesktopHost('shell.openExternal', { url })
      setNotice(t('loginOpened'))
    } catch {
      setError(t('loginFailed'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section
      data-testid="mcp-panel"
      className="mx-auto flex h-full min-h-0 w-full max-w-[1120px] flex-col px-5 py-6 md:px-10"
    >
      <header className="mb-6 flex items-center justify-between gap-3">
        <div>
          <h2 className="plugin-market-title">{t('mcpServers')}</h2>
          <p className="mt-1 text-sm text-text-secondary">{t('mcpDescription')}</p>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={loading || busy}
            data-testid="mcp-refresh"
            aria-label={t('refresh')}
            onClick={() => {
              setLoading(true)
              void refresh(true)
            }}
          >
            <RefreshCw className={loading ? 'animate-spin' : ''} />
          </Button>
          <Button
            size="sm"
            data-testid="mcp-add"
            disabled={busy || loading}
            onClick={() => setEditing('new')}
          >
            {t('addServer')}
          </Button>
        </div>
      </header>
      {error && (
        <p role="alert" className="mb-3 text-sm text-red-600">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mb-3 text-sm text-text-secondary">
          {notice}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-auto divide-y divide-border" aria-busy={loading}>
        {!loading && !entries.length && (
          <p className="py-12 text-center text-text-secondary">{t('noServers')}</p>
        )}
        {entries.map((entry, index) => {
          const tools = Object.entries(entry.status?.tools ?? {})
          const expanded = expandedServers.has(entry.name)
          const disabled =
            entry.config?.enabled === false || entry.status?.runtimeStatus === 'disabled'
          const connected = Boolean(
            entry.status?.serverInfo || Object.keys(entry.status?.tools ?? {}).length
          )
          const needsLogin =
            entry.status?.authStatus === 'notLoggedIn' ||
            entry.status?.runtimeStatus === 'authenticationRequired'
          const status =
            entry.status?.runtimeStatus === 'failed'
              ? 'connectionFailed'
              : entry.status?.runtimeStatus === 'starting'
                ? 'connecting'
                : disabled
                  ? 'disabled'
                  : connected
                    ? 'connected'
                    : needsLogin
                      ? 'needsLogin'
                      : loading && !entry.status
                        ? 'loadingStatus'
                        : 'notReady'
          return (
            <div key={entry.name} data-testid={`mcp-row-${index}`} className="py-4">
              <div className="flex flex-wrap items-center gap-3">
                <h3 className="min-w-0 flex-1 truncate text-base font-medium">{entry.name}</h3>
                <span
                  className={`text-xs ${status === 'connected' ? 'text-green-600' : 'text-text-secondary'}`}
                >
                  {t(status)}
                </span>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  {!disabled && needsLogin && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      data-testid={`mcp-login-${index}`}
                      onClick={() => void login(entry.name)}
                    >
                      {t('login')}
                    </Button>
                  )}
                  {entry.config && !entry.status?.pluginId ? (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy || loading}
                        data-testid={`mcp-toggle-${index}`}
                        aria-pressed={!disabled}
                        onClick={() => void update(entry)}
                      >
                        {t(disabled ? 'enable' : 'disable')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        data-testid={`mcp-edit-${index}`}
                        onClick={() => setEditing(entry)}
                      >
                        {t('edit')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        data-testid={`mcp-remove-${index}`}
                        onClick={() => setRemoving(entry)}
                      >
                        {t('remove')}
                      </Button>
                    </>
                  ) : (
                    <span className="text-xs text-text-muted">{t('managedByPlugin')}</span>
                  )}
                </div>
              </div>
              <div className="mt-2 text-sm">
                <button
                  type="button"
                  data-testid={`mcp-tools-${index}`}
                  aria-expanded={expanded}
                  aria-controls={`mcp-tool-list-${index}`}
                  className="inline-flex min-h-6 items-center gap-1 rounded px-1 text-xs text-text-secondary transition-colors hover:bg-muted/50 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                  onClick={() =>
                    setExpandedServers(current => {
                      const next = new Set(current)
                      if (next.has(entry.name)) next.delete(entry.name)
                      else next.add(entry.name)
                      return next
                    })
                  }
                >
                  <ChevronRight
                    className={`size-3.5 transition-transform ${expanded ? 'rotate-90' : ''}`}
                    aria-hidden="true"
                  />
                  {t('toolsCount', { count: tools.length })}
                </button>
                {expanded && (
                  <div
                    id={`mcp-tool-list-${index}`}
                    className="mt-2 max-h-96 overflow-y-auto rounded-xl border border-border/50 bg-surface/40 p-1"
                  >
                    {tools.map(([key, tool], toolIndex) => (
                      <div
                        key={key}
                        data-testid={`mcp-tool-${index}-${toolIndex}`}
                        className="grid gap-2 rounded-lg px-3 py-2.5 transition-colors hover:bg-muted/50 sm:grid-cols-[minmax(180px,0.42fr)_minmax(0,1fr)] sm:gap-4"
                      >
                        <code className="min-w-0 self-start break-all rounded-md bg-muted/70 px-2 py-1 text-code text-text-primary">
                          {tool.name}
                        </code>
                        <p className="whitespace-pre-wrap break-words text-sm leading-5 text-text-secondary">
                          {tool.description || t('noToolDescription')}
                        </p>
                      </div>
                    ))}
                    {!tools.length && (
                      <p className="px-3 py-3 text-sm text-text-secondary">{t('noTools')}</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
      <p className="mt-4 text-xs text-text-muted">{t('mcpScopeHint')}</p>
      {editing && (
        <McpServerDialog
          entry={editing === 'new' ? undefined : editing}
          names={entries.map(e => e.name)}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            setNotice(t('saved'))
            setBusy(true)
            void refresh(true).finally(() => setBusy(false))
          }}
        />
      )}
      <ConfirmDialog
        open={Boolean(removing)}
        title={t('removeServer')}
        description={t('removeServerConfirm', { name: removing?.name })}
        cancelLabel={t('cancel')}
        confirmLabel={t('remove')}
        confirmTestId="mcp-remove-confirm"
        destructive
        pending={busy}
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          if (removing) void update(removing, true)
        }}
      />
    </section>
  )
}
