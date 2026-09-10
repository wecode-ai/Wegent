import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { useTranslation } from '@/hooks/useTranslation'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import {
  listMcpServers,
  reloadMcpServers,
  saveMcpServer,
  loginMcpServer,
  type McpEntry,
} from '@/api/local/capabilities'
import { McpServerDialog } from './McpServerDialog'

export function McpPanel() {
  const { t } = useTranslation('capabilities')
  const [entries, setEntries] = useState<McpEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [editing, setEditing] = useState<McpEntry | 'new' | null>(null)
  const [removing, setRemoving] = useState<McpEntry | null>(null)
  const refresh = useCallback(
    (reload = false) => {
      let reloadFailed = false
      return (reload ? reloadMcpServers() : Promise.resolve())
        .catch(() => {
          reloadFailed = true
        })
        .then(() => listMcpServers())
        .then(result => {
          setEntries(result.entries)
          setError(reloadFailed ? t('reloadFailed') : result.statusError ? t('statusFailed') : '')
        })
        .catch(() => setError(t('loadFailed')))
        .finally(() => setLoading(false))
    },
    [t]
  )
  useEffect(() => {
    void refresh()
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
          <h2 className="heading-medium">{t('mcpServers')}</h2>
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
                      : 'notReady'
          return (
            <div key={entry.name} data-testid={`mcp-row-${index}`} className="py-4">
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-medium">{entry.name}</span>
                <span
                  className={`text-sm ${status === 'connected' ? 'text-green-600' : 'text-text-secondary'}`}
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
              <details className="mt-3 text-sm">
                <summary
                  data-testid={`mcp-tools-${index}`}
                  className="cursor-pointer text-text-secondary"
                >
                  {t('toolsCount', { count: Object.keys(entry.status?.tools ?? {}).length })}
                </summary>
                <div className="mt-2 space-y-3 rounded-lg bg-muted/40 p-3">
                  {Object.entries(entry.status?.tools ?? {}).map(([key, tool]) => (
                    <div key={key}>
                      <p className="font-medium">{tool.name}</p>
                      <p className="text-sm text-text-secondary">{tool.description}</p>
                    </div>
                  ))}
                  {!Object.keys(entry.status?.tools ?? {}).length && <p>{t('noTools')}</p>}
                </div>
              </details>
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
