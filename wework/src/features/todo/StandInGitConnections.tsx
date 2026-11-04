import { useEffect, useMemo, useRef, useState } from 'react'
import { GitBranch, Plus, RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type { StandInRole, StandInSourceConnection } from '@/api/personalStandIn'
import type { ConnectionProviderDescriptor, StandInExecutorApi } from '@/api/standIn'
import { GithubCliAuthDialog } from '@/components/plugins/GithubCliAuthDialog'
import { GITHUB_CLI_TARGET } from '@/api/local/githubCli'
import type {
  LocalConnectorAuthResult,
  LocalConnectorAuthTarget,
  LocalConnectorAuthTransport,
} from '@/api/local/localConnectorAuth'
import { StandInConnectionHeader } from './StandInConnectionHeader'
import { StandInProcessingSettings } from './StandInProcessingSettings'

export const GIT_CONNECTION_PREFIX = '@wegent/dsh-connection-git/'
type Resource = Pick<StandInSourceConnection, 'id' | 'name' | 'profile' | 'kind' | 'providerId'>
type Subscription = {
  id: string
  active: boolean
  generation: string
  deviceId: string
  gapBefore: number
  lastReceivedAt?: string | null
  pendingCount?: number
  source?: { provider: string; profile?: string; repositoryId: string; repositoryPath: string }
}

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
  const [setup, setSetup] = useState<{ url: string; secret: string; repository: string }[]>([])
  const [showSecret, setShowSecret] = useState(false)
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([])
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
  const refresh = async () => {
    const result = await api.gitConnection(deviceId, { channel: 'webhooks', operation: 'list' })
    setSubscriptions(result.items as Subscription[])
  }
  useEffect(() => {
    let active = true
    api
      .gitConnection(deviceId, { channel: 'webhooks', operation: 'list' })
      .then(result => {
        if (active) setSubscriptions(result.items as Subscription[])
      })
      .catch(() => {
        /* Personal connections remain available without cloud. */
      })
    return () => {
      active = false
    }
  }, [api, deviceId])
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
      const additions: StandInSourceConnection[] = []
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
          policy: {
            automatic: true,
            askBeforeAct: true,
            immediate: role.id !== '@primary',
          },
        }
        additions.push(connection)
        const latest = current.current
        const updated = {
          ...latest.role,
          connections: [...(latest.role.connections ?? []), connection],
        }
        current.current = { ...latest, role: updated }
        latest.onChange(updated)
      }
      setSelection([])
      if (additions.some(row => row.subscriptionId)) await refresh()
    } catch (cause) {
      report(cause)
    } finally {
      setBusy(false)
    }
  }
  const remove = (row: StandInSourceConnection) => {
    onChange({ ...role, connections: (role.connections ?? []).filter(value => value !== row) })
  }
  const takeover = async (subscription: Subscription) => {
    if (!subscription.source?.profile) return
    ++sequence.current
    setBusy(true)
    setError(undefined)
    try {
      const source: StandInSourceConnection = {
        providerId: provider.id,
        id: subscription.source.repositoryId,
        name: subscription.source.repositoryPath,
        kind: 'repository',
        profile: subscription.source.profile,
        subscriptionId: subscription.id,
        generation: subscription.generation,
        pendingTakeover: true,
        resumePending: true,
        policy: { automatic: true, askBeforeAct: true, immediate: role.id !== '@primary' },
      }
      const latest = current.current
      latest.onChange({
        ...latest.role,
        connections: [
          ...(latest.role.connections ?? []).filter(
            row =>
              !(
                row.providerId === provider.id &&
                row.profile === source.profile &&
                row.kind === source.kind &&
                row.id === source.id
              )
          ),
          source,
        ],
      })
    } catch (cause) {
      report(cause)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="space-y-4" data-testid={`stand-in-git-${platform}`}>
      <StandInConnectionHeader
        icon={GitBranch}
        title={provider.displayName}
        description={t('standIn.git.description')}
      />
      <Button
        variant="ghost"
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
      {rows.length > 0 && (
        <h4 className="text-sm font-medium">{t('standIn.git.selected_connections')}</h4>
      )}
      {rows.map(row => {
        const subscription = subscriptions.find(value => value.id === row.subscriptionId)
        return (
          <div
            key={`${row.profile}:${row.kind}:${row.id}`}
            className="flex items-center gap-2 border-b border-border/50 py-2"
          >
            <div className="min-w-0 flex-1">
              <p className="break-all text-sm">{row.name}</p>
              <p className="text-xs text-text-muted">
                {t(`standIn.git.${row.kind}`)} · {profileInstance(row.profile)}
              </p>
              {row.kind === 'repository' && (!row.subscriptionId || row.pendingTakeover) && (
                <p className="text-xs font-medium">
                  {t(
                    row.pendingTakeover && subscription?.deviceId !== deviceId
                      ? 'standIn.git.pending_takeover'
                      : 'standIn.git.pending_connection'
                  )}
                </p>
              )}
              {row.subscriptionId && !row.pendingTakeover && (
                <p className="text-xs text-text-muted">
                  {t(
                    subscription?.gapBefore
                      ? 'standIn.git.gap'
                      : subscription?.active
                        ? subscription.lastReceivedAt
                          ? 'standIn.git.webhook_verified'
                          : 'standIn.git.webhook_pending'
                        : 'standIn.git.webhook_unavailable'
                  )}
                </p>
              )}
              {subscription?.pendingCount !== undefined && (
                <p className="text-xs text-text-muted">
                  {t('standIn.git.pending', { count: subscription.pendingCount })}
                </p>
              )}
            </div>
            {row.kind === 'repository' && row.subscriptionId && !row.pendingTakeover && (
              <Button
                variant="ghost"
                disabled={disabled || busy}
                data-testid={`stand-in-git-setup-${row.id}`}
                onClick={() => {
                  const request = ++sequence.current
                  setBusy(true)
                  setError(undefined)
                  void api
                    .gitConnection(deviceId, {
                      channel: 'webhooks',
                      operation: 'setup',
                      subscriptionId: row.subscriptionId,
                      generation: row.generation,
                    })
                    .then(result => {
                      if (request === sequence.current) {
                        setShowSecret(false)
                        setSetup([
                          {
                            url: String(result.callbackUrl),
                            secret: String(result.secret),
                            repository: row.name,
                          },
                        ])
                      }
                    })
                    .catch(report)
                    .finally(() => setBusy(false))
                }}
              >
                {t('standIn.git.configure')}
              </Button>
            )}
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
        )
      })}
      <p className="text-xs text-text-muted">{t('standIn.git.permissions')}</p>
      {rows.some(row => row.subscriptionId) && (
        <p className="text-xs text-text-muted">{t('standIn.git.disconnect_help')}</p>
      )}
      {subscriptions.some(
        subscription =>
          subscription.active &&
          !rows.some(row => row.subscriptionId === subscription.id) &&
          subscription.source?.provider === platform &&
          subscription.source.profile
      ) && <h4 className="text-sm font-medium">{t('standIn.git.available_connections')}</h4>}
      {subscriptions
        .filter(
          subscription =>
            subscription.active &&
            !rows.some(row => row.subscriptionId === subscription.id) &&
            subscription.source?.provider === platform &&
            subscription.source.profile
        )
        .map(subscription => (
          <div key={subscription.id} className="space-y-1 border-b border-border/50 py-2">
            <p className="text-sm">{subscription.source?.repositoryPath}</p>
            <p className="break-all text-xs text-text-muted">
              {t('standIn.git.receiving_device', {
                device:
                  subscription.deviceId === deviceId
                    ? t('standIn.git.selected_device')
                    : subscription.deviceId,
              })}
            </p>
            <p className="text-xs text-text-muted">{t('standIn.git.takeover_help')}</p>
            <Button
              variant="ghost"
              disabled={disabled || busy}
              data-testid={`stand-in-git-takeover-${subscription.id}`}
              onClick={() => void takeover(subscription)}
            >
              {t(subscription.deviceId === deviceId ? 'standIn.git.reuse' : 'standIn.git.takeover')}
            </Button>
          </div>
        ))}
      {platform === 'gitlab' && (
        <label className="block space-y-1 text-sm">
          {t('standIn.git.instance')}
          <input
            data-testid="stand-in-git-instance"
            className="block min-h-9 w-full rounded-md border border-input bg-background px-3"
            value={instance}
            disabled={disabled || busy}
            onChange={event => {
              setInstance(event.target.value)
              setItems([])
              setSelection([])
              setCursor(undefined)
            }}
          />
        </label>
      )}
      <label className="block space-y-1 text-sm">
        {t('standIn.git.scope')}
        <select
          data-testid="stand-in-git-kind"
          className="block min-h-9 w-full rounded-md border border-input bg-background px-3"
          value={kind}
          disabled={disabled || busy}
          onChange={event => {
            setKind(event.target.value)
            setItems([])
            setSelection([])
            setCursor(undefined)
          }}
        >
          <option className="bg-background text-foreground" value="personal">
            {t('standIn.git.personal')}
          </option>
          <option className="bg-background text-foreground" value="repository">
            {t('standIn.git.repository')}
          </option>
        </select>
      </label>
      <div className="flex gap-2">
        {kind === 'repository' && (
          <label className="min-w-0 flex-1 space-y-1 text-sm">
            {t('standIn.git.search')}
            <input
              aria-label={t('standIn.git.search')}
              data-testid="stand-in-git-query"
              className="min-h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3"
              value={query}
              disabled={disabled || busy}
              onChange={event => {
                setQuery(event.target.value)
                setItems([])
                setSelection([])
                setCursor(undefined)
              }}
            />
          </label>
        )}
        <Button
          disabled={disabled || busy}
          data-testid="stand-in-git-search"
          onClick={() => void search()}
        >
          {t(kind === 'personal' ? 'standIn.git.check_account' : 'standIn.git.search')}
        </Button>
      </div>
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
      {setup.length > 0 && (
        <div
          className="space-y-2 rounded-md border border-border p-3"
          data-testid="stand-in-git-webhook-setup"
        >
          {setup.map(setup => (
            <div className="space-y-2" key={setup.url}>
              <p className="text-sm">{t('standIn.git.setup', { repository: setup.repository })}</p>
              <label className="block text-sm">
                {t('standIn.git.callback')}
                <input
                  readOnly
                  value={setup.url}
                  data-testid="stand-in-git-callback"
                  className="block min-h-9 w-full rounded-md border border-input bg-background px-2"
                />
              </label>
              <label className="block text-sm">
                {t('standIn.git.secret')}
                <input
                  type={showSecret ? 'text' : 'password'}
                  readOnly
                  value={setup.secret}
                  data-testid="stand-in-git-secret"
                  className="block min-h-9 w-full rounded-md border border-input bg-background px-2"
                />
              </label>
            </div>
          ))}
          <p className="text-xs text-text-muted">{t('standIn.git.setup_help')}</p>
          <Button
            variant="ghost"
            data-testid="stand-in-git-reveal-secret"
            onClick={() => setShowSecret(value => !value)}
          >
            {t(showSecret ? 'standIn.git.mask_secret' : 'standIn.git.reveal_secret')}
          </Button>
          <Button
            variant="ghost"
            data-testid="stand-in-git-hide-secret"
            onClick={() => {
              setSetup([])
              setShowSecret(false)
            }}
          >
            {t('standIn.git.hide_secret')}
          </Button>
        </div>
      )}
      {rows.some(row => row.subscriptionId) && (
        <Button
          variant="ghost"
          disabled={busy}
          data-testid="stand-in-git-refresh"
          onClick={() => {
            setError(undefined)
            void refresh().catch(report)
          }}
        >
          <RefreshCw className="mr-1 h-4 w-4" />
          {t('standIn.git.refresh')}
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
