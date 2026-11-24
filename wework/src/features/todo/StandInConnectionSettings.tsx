import {
  STAND_IN_DINGTALK_PROVIDER,
  type StandInDingTalkDelegation,
  type StandInRole,
} from '@/api/personalStandIn'
import type { ConnectionProviderDescriptor, StandInExecutorApi } from '@/api/standIn'
import {
  AutomationsPage,
  type AutomationNavigationHandle,
} from '@/features/automations/AutomationsPage'
import { useTranslation } from '@/hooks/useTranslation'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import type { CollaborationProject, TagDraftStore } from '@wegent/collaboration'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { dequal } from 'dequal'
import { Clock, MessageSquare } from 'lucide-react'
import {
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type Ref,
} from 'react'
import { StandInConnectionCatalog } from './StandInConnectionCatalog'
import { StandInConnectionHeader } from './StandInConnectionHeader'
import { StandInConnections, type StandInProjectNavigationHandle } from './StandInConnections'
import { createConnectionSettingsModel } from './standInConnectionSettingsModel'
import { EMAIL_PROVIDER, StandInEmailConnections } from './StandInEmailConnections'
import { GIT_CONNECTION_PREFIX, StandInGitConnections } from './StandInGitConnections'
import { StandInProcessingSettings } from './StandInProcessingSettings'
import { StandInSourceConnections } from './StandInSourceConnections'

export interface StandInConnectionNavigationHandle extends AutomationNavigationHandle {
  /** True means the source editor already confirmed discarding unsaved changes. */
  requestLeave(action: (discarded?: boolean) => void): void
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
  tagDraft,
  initialCalendar = false,
  onCalendarViewChange,
  onDetailViewChange,
  onDetailTitleChange,
  hideHeading = false,
  savedConfiguration,
  projectScopeConfigured,
  ref,
  onNavigate,
  renderDingTalkDelegation,
  dingTalkDelegation,
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
  tagDraft?: TagDraftStore
  initialCalendar?: boolean
  onCalendarViewChange?(open: boolean): void
  onDetailViewChange?(open: boolean): void
  onDetailTitleChange?(title: string | null): void
  hideHeading?: boolean
  savedConfiguration?: Pick<StandInRole, 'connections' | 'collaboration' | 'calendar'>
  projectScopeConfigured?: boolean
  ref?: Ref<StandInConnectionNavigationHandle>
  onNavigate?(action: () => void): void
  renderDingTalkDelegation?(provider: ConnectionProviderDescriptor): ReactNode
  dingTalkDelegation?: StandInDingTalkDelegation
}) {
  const { t, i18n } = useTranslation('common')
  const pending = Boolean(
    savedConfiguration &&
    (!dequal(role.connections ?? [], savedConfiguration.connections ?? []) ||
      !dequal(role.collaboration, savedConfiguration.collaboration) ||
      !dequal(role.calendar, savedConfiguration.calendar))
  )
  const timeTitle = t('standIn.workspace.time_connection')
  const projectsTitle = t('standIn.personal.collaboration')
  const unavailableTitle = t('standIn.workspace.connection_unavailable')
  const input = useMemo(
    () => ({
      api,
      deviceId,
      locale: i18n.language,
      timeTitle,
      projectsTitle,
      unavailableTitle,
      onScheduleDirtyChange,
      onCalendarViewChange,
      onDetailViewChange,
      onDetailTitleChange,
    }),
    [
      api,
      deviceId,
      i18n.language,
      timeTitle,
      projectsTitle,
      unavailableTitle,
      onScheduleDirtyChange,
      onCalendarViewChange,
      onDetailViewChange,
      onDetailTitleChange,
    ]
  )
  const [model] = useState(() => createConnectionSettingsModel(input, initialCalendar))
  const subscribe = useCallback(
    (listener: () => void) => model.subscribe(listener, input),
    [model, input]
  )
  const state = useSyncExternalStore(subscribe, model.getSnapshot, model.getSnapshot)
  const { view, scheduleDirty } = state
  const setView = model.setView
  const setScheduleDirty = model.setScheduleDirty
  const setEmailDirty = model.setEmailDirty
  const calendarRef = useRef<AutomationNavigationHandle>(null)
  const emailRef = useRef<AutomationNavigationHandle>(null)
  const projectRef = useRef<StandInProjectNavigationHandle>(null)
  const requestLeave = (action: (discarded?: boolean) => void) => {
    const editor = calendarRef.current ?? emailRef.current
    if (projectRef.current) projectRef.current.requestLeave(action)
    else if (editor) editor.requestLeave(() => action(false))
    else action(false)
  }
  useImperativeHandle(ref, () => ({
    back() {
      const back = () => setView(null)
      requestLeave(back)
    },
    requestLeave(action) {
      requestLeave(action)
    },
  }))
  const matches = state.api === api && state.deviceId === deviceId && state.locale === i18n.language
  const providers = matches ? state.providers : []
  const loading = view !== 'time' && (matches ? state.loading : Boolean(api))
  const visibleError = matches ? state.error : null
  const provider = providers.find(item => item.id === view)
  const install = model.install
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
                  sessionScope="schedule"
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
              ref={projectRef}
              tagDraft={tagDraft}
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
                  ownerApi={api}
                  userId={scheduling?.userId}
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
                  userId={scheduling?.userId}
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
                  onReady={() => model.reload()}
                  delegatedDingTalk={
                    role.id === '@primary' && provider.id === STAND_IN_DINGTALK_PROVIDER
                  }
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
              {provider.id === STAND_IN_DINGTALK_PROVIDER &&
                renderDingTalkDelegation?.(provider)}
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
            projectScopeConfigured={projectScopeConfigured}
            projects={projects}
            providers={providers}
            dingTalkDelegation={dingTalkDelegation}
            loading={loading}
            disabled={disabled}
            scheduling={Boolean(scheduling)}
            onSelect={setView}
          />
        </>
      )}
      {loading && <p role="status">{t('standIn.loading')}</p>}
      {view && !['time', 'projects'].includes(view) && !provider && !loading && !visibleError && (
        <ControlButton
          variant="unstyled"
          type="button"
          data-testid="stand-in-provider-retry"
          className="min-h-11 min-w-11 text-sm underline md:min-h-9"
          onClick={() => model.reload()}
        >
          {t('standIn.workspace.connection_retry')}
        </ControlButton>
      )}
      {visibleError && (
        <div role="alert">
          <p>{visibleError}</p>
          <ControlButton
            variant="unstyled"
            type="button"
            disabled={loading}
            data-testid="stand-in-connections-retry"
            onClick={() => {
              model.reload()
            }}
            className="min-h-11 min-w-11 text-sm underline md:min-h-9"
          >
            {t('standIn.workspace.connection_retry')}
          </ControlButton>
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
        <p className="px-2 text-xs text-text-secondary">
          {provider.availability.code
            ? getStandInErrorMessage({ code: provider.availability.code })
            : t('standIn.workspace.connection_status_' + provider.availability.status, {
                defaultValue: t('standIn.workspace.connection_unavailable'),
              })}
        </p>
      )}
      {provider.availability.status === 'dependency_missing' && (
        <ControlButton
          variant="unstyled"
          type="button"
          data-testid={`stand-in-install-dependencies-${provider.id}`}
          disabled={disabled}
          onClick={onInstall}
          className="min-h-11 min-w-11 px-2 text-sm underline md:min-h-9"
        >
          {t('standIn.workspace.install_dependencies')}
        </ControlButton>
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
          <ControlButton
            variant="unstyled"
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
          </ControlButton>
        </div>
      ))}
    </section>
  )
}
