import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { saveMcpServer, type McpConfig, type McpEntry } from '@/api/local/capabilities'
import { CapabilityDialog, fieldClass } from './CapabilityDialog'

export function McpServerDialog({
  entry,
  names,
  onClose,
  onSaved,
}: {
  entry?: McpEntry
  names: string[]
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useTranslation('capabilities')
  const [name, setName] = useState(entry?.name ?? '')
  const [transport, setTransport] = useState(entry?.config?.command ? 'stdio' : 'http')
  const [address, setAddress] = useState(entry?.config?.url ?? '')
  const [command, setCommand] = useState(entry?.config?.command ?? '')
  const [args, setArgs] = useState(JSON.stringify(entry?.config?.args ?? []))
  const [environment, setEnvironment] = useState(JSON.stringify(entry?.config?.env ?? {}, null, 2))
  const [auth, setAuth] = useState(entry?.config?.bearer_token_env_var ? 'bearer' : 'auto')
  const [tokenEnv, setTokenEnv] = useState(entry?.config?.bearer_token_env_var ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function save() {
    setError('')
    if (!/^[a-zA-Z0-9_-]+$/.test(name) || (!entry && names.includes(name))) {
      setError(t('nameInvalid'))
      return
    }
    const config: McpConfig = { ...entry?.config }
    delete config.url
    delete config.command
    delete config.args
    delete config.env
    delete config.bearer_token_env_var
    if (transport === 'http') {
      try {
        const url = new URL(address)
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash)
          throw new Error()
      } catch {
        setError(t('urlInvalid'))
        return
      }
      if (auth === 'bearer' && !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tokenEnv)) {
        setError(t('tokenEnvInvalid'))
        return
      }
      config.url = address.trim()
      if (auth === 'bearer') config.bearer_token_env_var = tokenEnv
    } else {
      if (!command.trim()) {
        setError(t('commandRequired'))
        return
      }
      try {
        const parsedArgs: unknown = JSON.parse(args)
        const parsedEnv: unknown = JSON.parse(environment)
        if (
          !Array.isArray(parsedArgs) ||
          !parsedArgs.every(a => typeof a === 'string') ||
          !parsedEnv ||
          Array.isArray(parsedEnv) ||
          typeof parsedEnv !== 'object' ||
          !Object.entries(parsedEnv).every(
            ([k, v]) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k) && typeof v === 'string'
          )
        )
          throw new Error()
        config.command = command.trim()
        config.args = parsedArgs
        config.env = parsedEnv as Record<string, string>
      } catch {
        setError(t('jsonInvalid'))
        return
      }
      delete config.http_headers
      delete config.env_http_headers
      delete config.auth
    }
    setBusy(true)
    try {
      await saveMcpServer(name, config)
      onSaved()
    } catch {
      setError(t('saveFailed'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <CapabilityDialog
      title={t(entry ? 'editServer' : 'addServer')}
      id="mcp-server-dialog"
      busy={busy}
      onClose={onClose}
    >
      <form
        className="space-y-4"
        onSubmit={e => {
          e.preventDefault()
          void save()
        }}
      >
        <label className="block space-y-2">
          {t('serverName')}
          <input
            required
            autoFocus
            disabled={Boolean(entry) || busy}
            data-testid="mcp-name"
            className={fieldClass}
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="company-knowledge"
          />
        </label>
        <p className="text-xs text-text-muted">{t('serverNameHint')}</p>
        <label className="block space-y-2">
          {t('transport')}
          <select
            className={fieldClass}
            data-testid="mcp-transport"
            disabled={busy}
            value={transport}
            onChange={e => setTransport(e.target.value)}
          >
            <option value="http">{t('http')}</option>
            <option value="stdio">{t('stdio')}</option>
          </select>
        </label>
        {transport === 'http' ? (
          <>
            <label className="block space-y-2">
              {t('serverUrl')}
              <input
                required
                className={fieldClass}
                data-testid="mcp-url"
                disabled={busy}
                value={address}
                onChange={e => setAddress(e.target.value)}
                placeholder="https://mcp.example.internal/knowledge"
              />
            </label>
            <label className="block space-y-2">
              {t('auth')}
              <select
                className={fieldClass}
                data-testid="mcp-auth"
                disabled={busy}
                value={auth}
                onChange={e => setAuth(e.target.value)}
              >
                <option value="auto">{t('authAuto')}</option>
                <option value="bearer">{t('authBearer')}</option>
              </select>
            </label>
            {auth === 'bearer' && (
              <label className="block space-y-2">
                {t('tokenEnv')}
                <input
                  required
                  className={fieldClass}
                  data-testid="mcp-token-env"
                  value={tokenEnv}
                  onChange={e => setTokenEnv(e.target.value)}
                  placeholder="COMPANY_MCP_TOKEN"
                />
                <span className="block text-xs text-text-muted">{t('tokenEnvHint')}</span>
              </label>
            )}
          </>
        ) : (
          <>
            <label className="block space-y-2">
              {t('command')}
              <input
                required
                className={fieldClass}
                data-testid="mcp-command"
                value={command}
                onChange={e => setCommand(e.target.value)}
                placeholder="npx"
              />
            </label>
            <label className="block space-y-2">
              {t('args')}
              <textarea
                className={`${fieldClass} font-mono`}
                data-testid="mcp-args"
                value={args}
                onChange={e => setArgs(e.target.value)}
                placeholder='["-y", "@company/mcp-server"]'
              />
            </label>
            <label className="block space-y-2">
              {t('environment')}
              <textarea
                className={`${fieldClass} font-mono`}
                data-testid="mcp-env"
                value={environment}
                onChange={e => setEnvironment(e.target.value)}
              />
            </label>
          </>
        )}
        <p className="text-sm text-text-secondary">{t('connectHint')}</p>
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
        <footer className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            data-testid="mcp-save-cancel"
            onClick={onClose}
          >
            {t('cancel')}
          </Button>
          <Button size="sm" disabled={busy} data-testid="mcp-save">
            {t(busy ? 'saving' : 'saveConnect')}
          </Button>
        </footer>
      </form>
    </CapabilityDialog>
  )
}
