import { useEffect, useMemo, useRef, useState } from 'react'
import { GitBranch, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type { StandInRole, StandInSourceConnection } from '@/api/personalStandIn'
import type { ConnectionProviderDescriptor, StandInExecutorApi } from '@/api/standIn'
import { GithubCliAuthDialog } from '@/components/plugins/GithubCliAuthDialog'
import { GITHUB_CLI_TARGET, isGithubCliTarget } from '@/api/local/githubCli'
import { isGitlabCliTarget } from '@/api/local/gitlabCli'
import type {
  LocalConnectorAuthResult,
  LocalConnectorAuthTarget,
  LocalConnectorAuthTransport,
} from '@/api/local/localConnectorAuth'
import { StandInConnectionHeader } from './StandInConnectionHeader'
import { StandInProcessingSettings } from './StandInProcessingSettings'

export const GIT_CONNECTION_PREFIX = '@wegent/dsh-connection-git/'
const fieldClassName =
  'block h-11 w-full min-w-0 rounded-md border border-border bg-background px-3 text-sm text-text-primary outline-none transition-colors focus-visible:border-focus focus-visible:ring-2 focus-visible:ring-focus/20 disabled:opacity-50 md:h-9'

type Resource = Pick<StandInSourceConnection, 'id' | 'name' | 'profile' | 'kind' | 'providerId'>
export function StandInGitConnections({
  role,
  provider,
  api,
  deviceId,
  disabled,
  onChange,
}: {
  role: StandInRole
  provider: ConnectionProviderDescriptor
  api: StandInExecutorApi
  deviceId: string
  disabled: boolean
  onChange(role: StandInRole): void
}) {
  const { t } = useTranslation('common')
  const platform = provider.id.slice(GIT_CONNECTION_PREFIX.length)
  const [instance, setInstance] = useState(`https://${platform}.com`)
  const [kind, setKind] = useState('personal')
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<Resource[]>([])
  const [selection, setSelection] = useState<Resource[]>([])
  const [cursor, setCursor] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [auth, setAuth] = useState<LocalConnectorAuthTarget>()
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
  const current = useRef({ role, onChange })
  const sequence = useRef(0)
  useEffect(() => {
    current.current = { role, onChange }
  }, [role, onChange])
  useEffect(
    () => () => {
      sequence.current += 1
    },
    []
  )
  const rows = (role.connections ?? []).filter(row => row.providerId === provider.id)
  const report = (cause: unknown) => {
    const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined
    setError(
      t(`standIn.git.errors.${String(code)}`, { defaultValue: t('standIn.git.request_failed') })
    )
  }
  const search = async (page?: string) => {
    const address = instanceOrigin(instance)
    if (!address) {
      setError(t('standIn.git.invalid_instance'))
      return
    }
    const request = ++sequence.current
    setBusy(true)
    setError(undefined)
    try {
      const result = await api.searchConnectionResources(
        deviceId,
        provider.id,
        kind,
        JSON.stringify({ instance: address, search: query }),
        page
      )
      if (request !== sequence.current) return
      const availability = result.availability
      if (availability && availability.status !== 'ready') {
        setItems([])
        setSelection([])
        setCursor(undefined)
        if (availability.status !== 'auth_required') {
          report(availability)
          return
        }
        setError(t('standIn.git.errors.connector_auth_required'))
        const target = availability.authTarget
        if (target && platform === 'github' && isGithubCliTarget(target)) {
          setAuth(GITHUB_CLI_TARGET)
        } else if (
          target &&
          platform === 'gitlab' &&
          isGitlabCliTarget(target) &&
          instanceOrigin(target.instance!) === address
        ) {
          const native = (await api.gitConnection(deviceId, {
            channel: 'authTarget',
            instance: address,
          })) as unknown as LocalConnectorAuthTarget
          if (request !== sequence.current) return
          if (
            !isGitlabCliTarget(native) ||
            native.pluginKey !== target.pluginKey ||
            native.connectorSlug !== target.connectorSlug ||
            instanceOrigin(native.instance!) !== address
          )
            throw new Error('Invalid authorization target')
          setAuth(native)
        }
        return
      }
      setItems(previous => (page ? [...previous, ...result.items] : result.items))
      setCursor(result.hasMore ? result.nextCursor : undefined)
    } catch (cause) {
      if (request === sequence.current) report(cause)
    } finally {
      if (request === sequence.current) setBusy(false)
    }
  }
  const add = async () => {
    ++sequence.current
    setBusy(true)
    setError(undefined)
    try {
      for (const item of selection) {
        if (
          (current.current.role.connections ?? []).some(
            row =>
              row.providerId === item.providerId &&
              row.profile === item.profile &&
              row.kind === item.kind &&
              row.id === item.id
          )
        )
          continue
        const connection: StandInSourceConnection = {
          ...item,
          transport: 'cli',
          policy: {
            automatic: true,
            askBeforeAct: true,
            immediate: role.id !== '@primary',
          },
        }
        const latest = current.current
        const updated = {
          ...latest.role,
          connections: [...(latest.role.connections ?? []), connection],
        }
        current.current = { ...latest, role: updated }
        latest.onChange(updated)
      }
      setSelection([])
    } catch (cause) {
      report(cause)
    } finally {
      setBusy(false)
    }
  }
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
                setError(undefined)
                setInstance(event.target.value)
                setItems([])
                setSelection([])
                setCursor(undefined)
              }}
            />
          </label>
        )}
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-medium">{t('standIn.git.account')}</p>
            <p className="text-xs leading-relaxed text-text-muted">
              {t('standIn.git.account_help')}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-11 shrink-0 md:h-9"
            disabled={disabled || busy}
            data-testid="stand-in-git-login"
            onClick={() => {
              if (platform === 'github') {
                setAuth(GITHUB_CLI_TARGET)
                return
              }
              const address = instanceOrigin(instance)
              if (!address) {
                setError(t('standIn.git.invalid_instance'))
                return
              }
              setBusy(true)
              void api
                .gitConnection(deviceId, { channel: 'authTarget', instance: address })
                .then(target => setAuth(target as unknown as LocalConnectorAuthTarget))
                .catch(report)
                .finally(() => setBusy(false))
            }}
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
            <p className="text-xs text-text-muted">
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
            setError(undefined)
            setKind(event.target.value)
            setItems([])
            setSelection([])
            setCursor(undefined)
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
                setError(undefined)
                setQuery(event.target.value)
                setItems([])
                setSelection([])
                setCursor(undefined)
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
        <p className="text-xs leading-relaxed text-text-muted">
          {t(kind === 'personal' ? 'standIn.git.personal_help' : 'standIn.git.repository_help')}
        </p>
      </div>
      <p className="text-xs leading-relaxed text-text-muted">{t('standIn.git.permissions')}</p>
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
          onCancel={() => setAuth(undefined)}
          onSuccess={() => {
            setAuth(undefined)
            setError(undefined)
          }}
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

function instanceOrigin(address: string): string | null {
  try {
    const url = new URL(address)
    return url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !address.includes('?') &&
      !address.includes('#')
      ? url.origin
      : null
  } catch {
    return null
  }
}
