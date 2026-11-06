import { dequal } from 'dequal'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { MessageSquare } from 'lucide-react'
import type { CollaborationProject } from '@wegent/collaboration'
import type { StandInRole } from '@/api/personalStandIn'
import type { ConnectionProviderDescriptor, StandInExecutorApi } from '@/api/standIn'
import { useTranslation } from '@/hooks/useTranslation'
import { StandInProcessingSettings } from './StandInProcessingSettings'
import { StandInConnectionHeader } from './StandInConnectionHeader'
import { StandInConnections } from './StandInConnections'
import { StandInSourceConnections } from './StandInSourceConnections'
import { StandInGitConnections, GIT_CONNECTION_PREFIX } from './StandInGitConnections'
import { StandInEmailConnections, EMAIL_PROVIDER } from './StandInEmailConnections'
import {
  AutomationsPage,
  type AutomationNavigationHandle,
} from '@/features/automations/AutomationsPage'
import { Clock } from 'lucide-react'
import { StandInConnectionCatalog } from './StandInConnectionCatalog'

export interface StandInConnectionNavigationHandle extends AutomationNavigationHandle {
  back(): void
}

export function StandInConnectionSettings({
  role,
  projects,
  api,
  deviceId,
  localDeviceId,
  disabled,
  onChange,
  focusedProjectId,
  scheduling,
  onScheduleDirtyChange,
  initialCalendar = false,
  onCalendarViewChange,
  onDetailViewChange,
  hideHeading = false,
  savedConfiguration,
  ref,
  onNavigate,
}: {
  role: StandInRole
  projects: CollaborationProject[]
  api?: StandInExecutorApi
  deviceId: string
  localDeviceId: string
  disabled: boolean
  onChange(role: StandInRole): void
  focusedProjectId?: string
  scheduling?: { userId: number; roleId: string }
  onScheduleDirtyChange?(dirty: boolean): void
  initialCalendar?: boolean
  onCalendarViewChange?(open: boolean): void
  onDetailViewChange?(open: boolean): void
  hideHeading?: boolean
  savedConfiguration?: Pick<StandInRole, 'connections' | 'collaboration' | 'calendar'>
  ref?: Ref<StandInConnectionNavigationHandle>
  onNavigate?(action: () => void): void
}) {
  const { t, i18n } = useTranslation('common')
  const pending = Boolean(
    savedConfiguration &&
    (!dequal(role.connections ?? [], savedConfiguration.connections ?? []) ||
      !dequal(role.collaboration, savedConfiguration.collaboration) ||
      !dequal(role.calendar, savedConfiguration.calendar))
  )
  const [scheduleDirty, setScheduleDirty] = useState(false)
  const [emailDirty, setEmailDirty] = useState(false)
  const [view, setView] = useState<string | null>(initialCalendar ? 'time' : null)
  const calendarRef = useRef<AutomationNavigationHandle>(null)
  const emailRef = useRef<AutomationNavigationHandle>(null)
  useImperativeHandle(ref, () => ({
    back() {
      const back = () => setView(null)
      if (calendarRef.current) calendarRef.current.requestLeave(back)
      else if (emailRef.current) emailRef.current.requestLeave(back)
      else back()
    },
    requestLeave(action) {
      if (calendarRef.current) calendarRef.current.requestLeave(action)
      else if (emailRef.current) emailRef.current.requestLeave(action)
      else action()
    },
  }))
  useEffect(() => {
    onScheduleDirtyChange?.(scheduleDirty || emailDirty)
  }, [scheduleDirty, emailDirty, onScheduleDirtyChange])
  useEffect(() => {
    onDetailViewChange?.(view !== null)
    return () => onDetailViewChange?.(false)
  }, [view, onDetailViewChange])
  useEffect(() => {
    onCalendarViewChange?.(view === 'time')
    return () => onCalendarViewChange?.(false)
  }, [view, onCalendarViewChange])
  const [catalog, setCatalog] = useState<{
    key: string
    api: StandInExecutorApi
    items: ConnectionProviderDescriptor[]
    error: string | null
    revision: number
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const catalogKey = JSON.stringify([deviceId, i18n.language])
  const currentCatalog = catalog?.key === catalogKey && catalog.api === api ? catalog : null
  const providers = currentCatalog?.items ?? []
  const loading =
    view !== 'time' &&
    (installing || Boolean(api && (!currentCatalog || currentCatalog.revision !== refresh)))
  const visibleError = view === 'time' ? null : (error ?? currentCatalog?.error)
  useEffect(() => {
    if (!api || view === 'time') return
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
            revision: refresh,
          })
      })
      .catch(cause => {
        if (active)
          setCatalog(previous => ({
            key: catalogKey,
            api,
            items: previous?.key === catalogKey && previous.api === api ? previous.items : [],
            error: getStandInErrorMessage(cause),
            revision: refresh,
          }))
      })
    return () => {
      active = false
    }
  }, [api, deviceId, catalogKey, i18n.language, view, refresh])
  const provider = providers.find(item => item.id === view)
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
      setError(getStandInErrorMessage(cause))
    } finally {
      setInstalling(false)
    }
  }
  return (
    <section
      className={view === 'time' ? 'flex min-h-0 flex-1 flex-col gap-3' : 'space-y-3'}
      data-testid="stand-in-connection-settings"
    >
      {pending && (
        <p
          role="status"
          data-testid="stand-in-connections-pending"
          className="text-sm text-text-secondary"
        >
          {t('standIn.workspace.connection_pending')}
        </p>
      )}
      {view ? (
        <>
          {view === 'time' && scheduling ? (
            <div
              className="flex min-h-0 flex-1 flex-col gap-4"
              data-testid="stand-in-calendar-connection"
            >
              <StandInConnectionHeader
                icon={Clock}
                title={t('standIn.workspace.time_connection')}
                description={t('standIn.workspace.calendar_help')}
              />
              <AutomationsPage
                ref={calendarRef}
                onNavigate={onNavigate}
                embedded
                standInOwner={scheduling}
                standInDeviceId={deviceId}
                onDirtyChange={setScheduleDirty}
              />
              {!scheduleDirty && (
                <StandInProcessingSettings
                  disabled={disabled}
                  rows={[
                    {
                      key: 'calendar',
                      name: t('standIn.workspace.time_connection'),
                      testId: 'stand-in-calendar-policy',
                      policy: role.calendar?.policy ?? {
                        automatic: true,
                        askBeforeAct: true,
                        immediate: role.id !== '@primary',
                      },
                      onChange: policy => onChange({ ...role, calendar: { policy } }),
                    },
                  ]}
                />
              )}
            </div>
          ) : view === 'projects' ? (
            <StandInConnections
              role={role}
              projects={projects}
              allowLocalProjects={deviceId === localDeviceId}
              focusedProjectId={focusedProjectId}
              disabled={disabled}
              onChange={onChange}
            />
          ) : provider && api ? (
            <>
              {!['ready', 'auth_required'].includes(provider.availability.status) && (
                <StandInConnectionHeader
                  icon={MessageSquare}
                  title={provider.displayName}
                  description={t('standIn.workspace.message_connection_help')}
                />
              )}
              <ConnectionProviderStatus
                provider={provider}
                disabled={disabled || loading}
                onInstall={() => void install(provider)}
              />
              {provider.id === EMAIL_PROVIDER ? (
                <StandInEmailConnections
                  ref={emailRef}
                  onDirtyChange={setEmailDirty}
                  key={deviceId}
                  role={role}
                  local={deviceId === localDeviceId}
                  disabled={disabled || loading}
                  onChange={onChange}
                />
              ) : provider.id.startsWith(GIT_CONNECTION_PREFIX) ? (
                <StandInGitConnections
                  key={`${deviceId}:${role.id}:${provider.id}`}
                  provider={provider}
                  role={role}
                  api={api}
                  deviceId={deviceId}
                  disabled={disabled || loading}
                  onChange={onChange}
                />
              ) : ['ready', 'auth_required'].includes(provider.availability.status) ? (
                <StandInSourceConnections
                  key={`${deviceId}:${provider.id}`}
                  provider={provider}
                  role={role}
                  api={api}
                  deviceId={deviceId}
                  localDeviceId={localDeviceId}
                  disabled={disabled || loading}
                  onChange={onChange}
                  onReady={() => setRefresh(value => value + 1)}
                />
              ) : null}
              {provider.id !== EMAIL_PROVIDER &&
                !['ready', 'auth_required'].includes(provider.availability.status) && (
                  <UnavailableSourceConnections
                    role={role}
                    providerId={provider.id}
                    disabled={disabled || loading}
                    onChange={onChange}
                  />
                )}
            </>
          ) : (
            <div className="space-y-3">
              {!loading && <p role="status">{t('standIn.workspace.connection_unavailable')}</p>}
              <UnavailableSourceConnections
                role={role}
                providerId={view}
                disabled={disabled || loading}
                onChange={onChange}
              />
            </div>
          )}
        </>
      ) : (
        <>
          {!hideHeading && <h3 className="font-medium">{t('standIn.workspace.connections')}</h3>}
          <StandInConnectionCatalog
            role={role}
            projects={projects}
            providers={providers}
            loading={loading}
            local={deviceId === localDeviceId}
            disabled={disabled}
            scheduling={Boolean(scheduling)}
            onSelect={setView}
          />
        </>
      )}
      {loading && <p role="status">{t('standIn.loading')}</p>}
      {view && !['time', 'projects'].includes(view) && !provider && !loading && !visibleError && (
        <button
          type="button"
          data-testid="stand-in-provider-retry"
          className="min-h-9 text-sm underline"
          onClick={() => setRefresh(value => value + 1)}
        >
          {t('standIn.workspace.connection_retry')}
        </button>
      )}
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
          {provider.availability.code
            ? getStandInErrorMessage({ code: provider.availability.code })
            : t('standIn.workspace.connection_status_' + provider.availability.status, {
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

function UnavailableSourceConnections({
  role,
  providerId,
  disabled,
  onChange,
}: {
  role: StandInRole
  providerId: string
  disabled: boolean
  onChange(role: StandInRole): void
}) {
  const { t } = useTranslation('common')
  const rows = (role.connections ?? []).filter(source => source.providerId === providerId)
  if (!rows.length) return null
  return (
    <section className="space-y-2">
      <h4 className="text-sm font-medium">{t('standIn.workspace.connection_scope')}</h4>
      {rows.map(source => (
        <div
          key={JSON.stringify([source.profile, source.kind, source.id])}
          className="flex items-center gap-2"
        >
          <span className="min-w-0 flex-1 break-words text-sm">
            {source.name}
            <span className="block text-text-muted">
              {source.configurationSummary ??
                t('standIn.workspace.connection_default_configuration')}
            </span>
          </span>
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
            className="min-h-11 shrink-0 px-2 text-sm underline"
          >
            {t('standIn.workspace.remove_connection', { name: source.name })}
          </button>
        </div>
      ))}
    </section>
  )
}
