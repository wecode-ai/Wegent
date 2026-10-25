import { useEffect, useState } from 'react'
import { ArrowLeft, ChevronRight, Folder, MessageSquare, Plus } from 'lucide-react'
import type { CollaborationProject } from '@wegent/collaboration'
import { standInPolicy, type StandInHandlingPolicy, type StandInRole } from '@/api/personalStandIn'
import type { ConnectionProviderDescriptor, StandInExecutorApi } from '@/api/standIn'
import { useTranslation } from '@/hooks/useTranslation'
import { StandInConnections } from './StandInConnections'
import { StandInSourceConnections } from './StandInSourceConnections'

const DINGTALK_PROVIDER = '@wegent/dsh-connection-dingtalk/dingtalk'

export function StandInConnectionSettings({
  role,
  projects,
  api,
  deviceId,
  localDeviceId,
  disabled,
  onChange,
  focusedProjectId,
}: {
  role: StandInRole
  projects: CollaborationProject[]
  api?: StandInExecutorApi
  deviceId: string
  localDeviceId: string
  disabled: boolean
  onChange(role: StandInRole): void
  focusedProjectId?: string
}) {
  const { t, i18n } = useTranslation('common')
  const [view, setView] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [catalog, setCatalog] = useState<{
    key: string
    api: StandInExecutorApi
    items: ConnectionProviderDescriptor[]
    error: string | null
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const catalogKey = JSON.stringify([deviceId, i18n.language, refresh])
  const currentCatalog = catalog?.key === catalogKey && catalog.api === api ? catalog : null
  const providers = currentCatalog?.items ?? []
  const loading = installing || Boolean(api && !currentCatalog)
  const visibleError = error ?? currentCatalog?.error
  useEffect(() => {
    if (!api) return
    let active = true
    void api
      .connectionProviders(deviceId)
      .then(result => {
        if (active)
          setCatalog({
            key: catalogKey,
            api,
            items: result.items.map(item => ({ ...item, ...item.locales?.[i18n.language] })),
            error: null,
          })
      })
      .catch(cause => {
        if (active) setCatalog({ key: catalogKey, api, items: [], error: String(cause) })
      })
    return () => {
      active = false
    }
  }, [api, deviceId, catalogKey, i18n.language])
  const provider = providers.find(item => item.id === view)
  const policyLabel = (policy: StandInHandlingPolicy) =>
    t(
      !policy.automatic
        ? 'standIn.workspace.policy_manual'
        : policy.askBeforeAct
          ? 'standIn.workspace.policy_confirm'
          : 'standIn.workspace.policy_automatic'
    )
  const source = role.collaboration
  const projectRows = !source.enabled
    ? []
    : source.allProjects
      ? [
          {
            key: 'all-projects',
            name: t('standIn.personal.all_projects'),
            detail: t('standIn.workspace.project_scope_summary', {
              count: source.excludedProjects.length,
            }),
            policy: standInPolicy(role),
            view: 'projects',
          },
        ]
      : source.projects.map(ref => ({
          key: `project-${ref.store}-${ref.id}`,
          name:
            projects.find(
              project =>
                project.id === ref.id &&
                (project.project_store === 'local' ? 'local' : 'cloud') === ref.store
            )?.name ?? ref.id,
          detail: t('standIn.personal.collaboration'),
          policy: standInPolicy(role, ref),
          view: 'projects',
        }))
  const rows = [
    ...projectRows,
    ...(role.connections ?? []).map(connection => ({
      key: `${connection.providerId === DINGTALK_PROVIDER ? 'dingtalk' : connection.providerId}-${connection.profile}-${connection.kind}-${connection.id}`,
      name: connection.name,
      detail:
        providers.find(item => item.id === connection.providerId)?.displayName ??
        t('standIn.workspace.connection_unavailable'),
      policy: connection.policy,
      view: connection.providerId,
    })),
  ]
  const install = async (item: ConnectionProviderDescriptor) => {
    if (!api) return
    setInstalling(true)
    setError(null)
    try {
      await api.installConnectionDependencies(
        deviceId,
        item.id,
        item.dependencies
          .filter(dependency => dependency.status === 'missing')
          .map(dependency => dependency.alias)
      )
      setRefresh(value => value + 1)
    } catch (cause) {
      setError(String(cause))
    } finally {
      setInstalling(false)
    }
  }
  return (
    <section className="space-y-3" data-testid="stand-in-connection-settings">
      {view ? (
        <>
          <button
            type="button"
            data-testid="stand-in-connections-back"
            disabled={disabled}
            className="flex min-h-8 items-center gap-2 text-sm text-text-secondary hover:text-text-primary disabled:opacity-40"
            onClick={() => setView(null)}
          >
            <ArrowLeft aria-hidden="true" className="h-4 w-4" />
            {t('standIn.workspace.back_to_connections')}
          </button>
          {view === 'projects' ? (
            <StandInConnections
              role={role}
              projects={projects}
              focusedProjectId={focusedProjectId}
              disabled={disabled}
              onChange={onChange}
            />
          ) : provider && api ? (
            <>
              <ConnectionProviderStatus
                provider={provider}
                disabled={disabled || loading}
                onInstall={() => void install(provider)}
              />
              <StandInSourceConnections
                key={`${deviceId}:${provider.id}`}
                provider={provider}
                role={role}
                api={api}
                deviceId={deviceId}
                localDeviceId={localDeviceId}
                disabled={disabled}
                onChange={onChange}
              />
            </>
          ) : (
            <div className="space-y-3">
              <p role="status">{t('standIn.workspace.connection_unavailable')}</p>
              {(role.connections ?? [])
                .filter(source => source.providerId === view)
                .map(source => (
                  <div
                    key={JSON.stringify([source.profile, source.kind, source.id])}
                    className="flex items-center gap-2"
                  >
                    <span className="min-w-0 flex-1 truncate">{source.name}</span>
                    <button
                      type="button"
                      disabled={disabled}
                      data-testid={`stand-in-disconnect-${source.providerId}-${source.id}`}
                      onClick={() =>
                        onChange({
                          ...role,
                          connections: (role.connections ?? []).filter(row => row !== source),
                        })
                      }
                      className="min-h-9 px-2 text-sm underline"
                    >
                      {t('standIn.workspace.remove_connection', { name: source.name })}
                    </button>
                  </div>
                ))}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3">
            <h3 className="font-medium">{t('standIn.workspace.connections')}</h3>
            <button
              type="button"
              data-testid="stand-in-add-connection"
              aria-expanded={adding}
              disabled={disabled}
              onClick={() => setAdding(value => !value)}
              className="flex min-h-8 items-center gap-1 rounded-md px-2 text-sm hover:bg-muted"
            >
              <Plus aria-hidden="true" className="h-4 w-4" />
              {t('standIn.workspace.add_connection')}
            </button>
          </div>
          {adding && (
            <div
              className="rounded-lg border border-border p-1"
              data-testid="stand-in-connection-type-picker"
            >
              <button
                type="button"
                data-testid="stand-in-add-projects-connection"
                disabled={disabled}
                onClick={() => {
                  setView('projects')
                  setAdding(false)
                }}
                className="flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-muted"
              >
                <Folder aria-hidden="true" className="h-4 w-4" />
                {t('standIn.personal.collaboration')}
              </button>
              {providers.map(item => (
                <div key={item.id}>
                  <button
                    type="button"
                    data-testid={`stand-in-add-${item.id === DINGTALK_PROVIDER ? 'dingtalk' : item.id}-connection`}
                    disabled={disabled}
                    onClick={() => {
                      setView(item.id)
                      setAdding(false)
                    }}
                    className="flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-muted disabled:opacity-40"
                  >
                    <MessageSquare aria-hidden="true" className="h-4 w-4" />
                    <span className="flex-1">{item.displayName}</span>
                    <ChevronRight aria-hidden="true" className="h-4 w-4" />
                  </button>
                  <ConnectionProviderStatus
                    provider={item}
                    disabled={disabled || loading}
                    onInstall={() => void install(item)}
                  />
                </div>
              ))}
            </div>
          )}
          {rows.length ? (
            <div className="divide-y divide-border" data-testid="stand-in-connected-list">
              {rows.map(row => (
                <button
                  key={row.key}
                  type="button"
                  data-testid={`stand-in-connection-${row.key}`}
                  disabled={disabled}
                  onClick={() => setView(row.view)}
                  className="flex min-h-14 w-full items-center gap-3 rounded-md px-2 py-3 text-left hover:bg-muted disabled:opacity-40"
                >
                  {row.view === 'projects' ? (
                    <Folder aria-hidden="true" className="h-4 w-4 shrink-0 text-text-secondary" />
                  ) : (
                    <MessageSquare
                      aria-hidden="true"
                      className="h-4 w-4 shrink-0 text-text-secondary"
                    />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{row.name}</span>
                    <span className="mt-1 block text-xs text-text-muted">{row.detail}</span>
                  </span>
                  <span className="max-w-32 text-right text-xs text-text-secondary">
                    {policyLabel(row.policy)}
                  </span>
                  <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
                </button>
              ))}
            </div>
          ) : (
            <p className="py-4 text-sm text-text-muted" data-testid="stand-in-connections-empty">
              {t('standIn.workspace.connections_empty')}
            </p>
          )}
        </>
      )}
      {loading && <p role="status">{t('standIn.loading')}</p>}
      {visibleError && (
        <div role="alert">
          <p>{visibleError}</p>
          <button
            type="button"
            disabled={loading}
            data-testid="stand-in-connections-retry"
            onClick={() => {
              setError(null)
              setRefresh(value => value + 1)
            }}
            className="min-h-9 text-sm underline"
          >
            {t('standIn.workspace.connection_retry')}
          </button>
        </div>
      )}
    </section>
  )
}

function ConnectionProviderStatus({
  provider,
  disabled,
  onInstall,
}: {
  provider: ConnectionProviderDescriptor
  disabled: boolean
  onInstall(): void
}) {
  const { t } = useTranslation('common')
  return (
    <>
      {!['ready', 'auth_required'].includes(provider.availability.status) && (
        <p className="px-2 text-xs text-text-muted">
          {t('standIn.workspace.connection_status_' + provider.availability.status, {
            defaultValue: t('standIn.workspace.connection_unavailable'),
          })}
        </p>
      )}
      {provider.availability.status === 'dependency_missing' && (
        <button
          type="button"
          data-testid={`stand-in-install-dependencies-${provider.id}`}
          disabled={disabled}
          onClick={onInstall}
          className="min-h-9 px-2 text-sm underline"
        >
          {t('standIn.workspace.install_dependencies')}
        </button>
      )}
    </>
  )
}
