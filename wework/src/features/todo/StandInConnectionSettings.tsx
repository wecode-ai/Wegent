import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { ChevronRight, Folder, MessageSquare, Plus, type LucideIcon } from 'lucide-react'
import type { CollaborationProject } from '@wegent/collaboration'
import { standInPolicy, type StandInRole } from '@/api/personalStandIn'
import type { ConnectionProviderDescriptor, StandInExecutorApi } from '@/api/standIn'
import { useTranslation } from '@/hooks/useTranslation'
import { StandInProcessingSettings } from './StandInProcessingSettings'
import { StandInConnectionHeader } from './StandInConnectionHeader'
import { StandInConnections } from './StandInConnections'
import { StandInSourceConnections } from './StandInSourceConnections'
import {
  AutomationsPage,
  type AutomationNavigationHandle,
} from '@/features/automations/AutomationsPage'
import { Clock } from 'lucide-react'
import { findStandInProject } from './standInProjects'

export interface StandInConnectionNavigationHandle extends AutomationNavigationHandle {
  back(): void
}

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
  scheduling,
  onScheduleDirtyChange,
  initialCalendar = false,
  onCalendarViewChange,
  onDetailViewChange,
  hideHeading = false,
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
  ref?: Ref<StandInConnectionNavigationHandle>
  onNavigate?(action: () => void): void
}) {
  const { t, i18n } = useTranslation('common')
  const [scheduleDirty, setScheduleDirty] = useState(false)
  const [view, setView] = useState<string | null>(initialCalendar ? 'time' : null)
  const calendarRef = useRef<AutomationNavigationHandle>(null)
  useImperativeHandle(ref, () => ({
    back() {
      const back = () => setView(null)
      if (calendarRef.current) calendarRef.current.requestLeave(back)
      else back()
    },
    requestLeave(action) {
      if (calendarRef.current) calendarRef.current.requestLeave(action)
      else action()
    },
  }))
  useEffect(() => {
    onScheduleDirtyChange?.(scheduleDirty)
  }, [scheduleDirty, onScheduleDirtyChange])
  useEffect(() => {
    onDetailViewChange?.(view !== null)
    return () => onDetailViewChange?.(false)
  }, [view, onDetailViewChange])
  useEffect(() => {
    onCalendarViewChange?.(view === 'time')
    return () => onCalendarViewChange?.(false)
  }, [view, onCalendarViewChange])
  const [adding, setAdding] = useState(false)
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
          name: findStandInProject(projects, ref)?.name ?? ref.id,
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
      setError(getStandInErrorMessage(cause))
    } finally {
      setInstalling(false)
    }
  }
  const showPicker = adding || rows.length === 0
  return (
    <section
      className={view === 'time' ? 'flex min-h-0 flex-1 flex-col gap-3' : 'space-y-3'}
      data-testid="stand-in-connection-settings"
    >
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
              {['ready', 'auth_required'].includes(provider.availability.status) && (
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
              )}
            </>
          ) : (
            <div className="space-y-3">
              {!loading && <p role="status">{t('standIn.workspace.connection_unavailable')}</p>}
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
          <div className="flex items-center justify-end gap-3">
            {!hideHeading && (
              <h3 className="flex-1 font-medium">{t('standIn.workspace.connections')}</h3>
            )}
            {!showPicker && (
              <button
                type="button"
                data-testid="stand-in-add-connection"
                aria-expanded={showPicker}
                disabled={disabled}
                onClick={() => setAdding(value => !value)}
                className="flex min-h-8 items-center gap-1 rounded-md px-2 text-sm hover:bg-muted"
              >
                <Plus aria-hidden="true" className="h-4 w-4" />
                {t('standIn.workspace.add_connection')}
              </button>
            )}
          </div>
          {showPicker && (
            <div className="space-y-1" data-testid="stand-in-connection-type-picker">
              <ConnectionTypeRow
                testId="stand-in-add-projects-connection"
                icon={Folder}
                label={t('standIn.personal.collaboration')}
                disabled={disabled}
                onSelect={() => {
                  setView('projects')
                  setAdding(false)
                }}
              />
              {scheduling && (
                <ConnectionTypeRow
                  testId="stand-in-time-connections"
                  icon={Clock}
                  label={t('standIn.workspace.time_connection')}
                  disabled={disabled}
                  onSelect={() => {
                    setView('time')
                    setAdding(false)
                  }}
                />
              )}
              {providers.map(item => (
                <ConnectionTypeRow
                  key={item.id}
                  testId={`stand-in-add-${item.id === DINGTALK_PROVIDER ? 'dingtalk' : item.id}-connection`}
                  icon={MessageSquare}
                  label={item.displayName}
                  disabled={disabled}
                  onSelect={() => {
                    setView(item.id)
                    setAdding(false)
                  }}
                />
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
                    {!row.policy.automatic
                      ? t('standIn.workspace.connection_handling_disabled')
                      : row.policy.immediate === false
                        ? t('standIn.workspace.processing_background')
                        : t('standIn.workspace.process_immediately')}
                  </span>
                  <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
                </button>
              ))}
            </div>
          ) : null}
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

function ConnectionTypeRow({
  testId,
  icon: Icon,
  label,
  disabled,
  onSelect,
}: {
  testId: string
  icon: LucideIcon
  label: string
  disabled: boolean
  onSelect(): void
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onSelect}
      className="flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-muted disabled:opacity-40"
    >
      <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-text-secondary" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
    </button>
  )
}
