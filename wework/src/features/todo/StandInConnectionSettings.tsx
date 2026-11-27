import { STAND_IN_DINGTALK_PROVIDER, type StandInRole } from '@/api/personalStandIn'
import type { ConnectionProviderDescriptor, StandInExecutorApi } from '@/api/standIn'
import { SettingsRow, SettingsSwitch } from '@/components/settings/settings-ui'
import {
  AutomationsPage,
  type AutomationNavigationHandle,
} from '@/features/automations/AutomationsPage'
import { CloudConnectionContext } from '@/features/cloud-connection/CloudConnectionContext'
import { useTranslation } from '@/hooks/useTranslation'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import type { CollaborationProject, TagDraftStore } from '@wegent/collaboration'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { Clock, Folder, GitBranch, Mail, MessageSquare } from 'lucide-react'
import {
  useCallback,
  useContext,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type Ref,
} from 'react'
import { StandInConnectionCatalog } from './StandInConnectionCatalog'
import { ConnectionScopeNavigation } from './connectionScopeNavigation'
import { StandInConnectionForm } from './StandInConnectionForm'
import { ConnectionFixedTrigger } from './ConnectionScopeFields'
import { StandInConnectionHeader } from './StandInConnectionHeader'
import { StandInConnections, type StandInProjectNavigationHandle } from './StandInConnections'
import {
  connectionConfigurationChanges,
  createConnectionSettingsModel,
  hasConnectionDraft,
  rebaseConnectionDraft,
} from './standInConnectionSettingsModel'
import { EMAIL_PROVIDER, StandInEmailConnections } from './StandInEmailConnections'
import { GIT_CONNECTION_PREFIX, StandInGitConnections } from './StandInGitConnections'
import { StandInSourceConnections } from './StandInSourceConnections'
import { effectiveProjectSource } from './standInProjects'

export interface StandInConnectionNavigationHandle extends AutomationNavigationHandle {
  /** True means the source editor already confirmed discarding unsaved changes. */
  requestLeave(action: (discarded?: boolean) => void): void
  back(): void
  returnToScopeList(): void
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
  onScheduleEditorOpenChange,
  tagDraft,
  initialCalendar = false,
  onCalendarViewChange,
  onDetailViewChange,
  onDetailTitleChange,
  hideHeading = false,
  showPendingStatus = true,
  savedConfiguration,
  projectScopeConfigured,
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
  onScheduleEditorOpenChange?(open: boolean): void
  tagDraft?: TagDraftStore
  initialCalendar?: boolean
  onCalendarViewChange?(open: boolean): void
  onDetailViewChange?(open: boolean): void
  onDetailTitleChange?(title: string | null, view: string | null, scopeTitle: string | null): void
  hideHeading?: boolean
  showPendingStatus?: boolean
  savedConfiguration?: Pick<StandInRole, 'connections' | 'collaboration' | 'calendar'>
  projectScopeConfigured?: boolean
  ref?: Ref<StandInConnectionNavigationHandle>
  onNavigate?(action: () => void): void
}) {
  const { t, i18n } = useTranslation('common')
  const user = useContext(CloudConnectionContext)?.user
  const weworkAccount = (
    <p className="text-sm">
      {user?.user_name || user?.email || t('standIn.workspace.connection_wework_account')}
    </p>
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
  const { view } = state
  const scopeEditor =
    view === 'projects' ||
    view === 'time' ||
    view === STAND_IN_DINGTALK_PROVIDER ||
    view === EMAIL_PROVIDER ||
    Boolean(view?.startsWith(GIT_CONNECTION_PREFIX))
  const setView = model.setView
  const [scheduleEditorOpen, setScheduleEditorOpen] = useState(false)
  const scheduleEditorChanged = useCallback(
    (open: boolean, dirty: boolean) => {
      setScheduleEditorOpen(open)
      if (model.getSnapshot().view === 'time')
        model.setScopeTitle(open ? t('standIn.workspace.connection_schedule_title') : null)
      model.setScheduleDirty(dirty)
      onScheduleEditorOpenChange?.(open)
    },
    [model, onScheduleEditorOpenChange, t]
  )
  const setEmailDirty = model.setEmailDirty
  const calendarRef = useRef<AutomationNavigationHandle>(null)
  const emailRef = useRef<AutomationNavigationHandle>(null)
  const projectRef = useRef<StandInProjectNavigationHandle>(null)
  const scopeList = useRef<(() => void) | null>(null)
  const wizardStart = useRef<{ view: string; role: StandInRole } | null>(null)
  const scopeNavigation = {
    list: scopeList,
    setTitle(title: string | null) {
      if (title && view) {
        wizardStart.current ??= { view, role }
      } else if (wizardStart.current) {
        const start = wizardStart.current
        wizardStart.current = null
        tagDraft?.set('')
        if (hasConnectionDraft(role, start.role, start.view)) {
          onChange(rebaseConnectionDraft(role, start.role, start.role, start.view))
        }
      }
      model.setScopeTitle(title)
    },
  }
  const requestLeave = (action: (discarded?: boolean) => void) => {
    const editor = calendarRef.current ?? emailRef.current
    if (projectRef.current) projectRef.current.requestLeave(action)
    else if (editor) editor.requestLeave(() => action(false))
    else action(false)
  }
  useImperativeHandle(ref, () => ({
    returnToScopeList() {
      wizardStart.current = null
      scopeList.current?.()
    },
    back() {
      if (scheduleEditorOpen && calendarRef.current?.returnToList) {
        calendarRef.current.returnToList()
        return
      }
      if (scopeList.current) {
        scopeList.current()
        return
      }
      requestLeave(() => {
        if (view && savedConfiguration && hasConnectionDraft(role, savedConfiguration, view)) {
          onChange({ ...role, ...connectionConfigurationChanges(role, savedConfiguration, view) })
        }
        setView(null)
      })
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
  const collaboration = effectiveProjectSource(role.collaboration)
  const calendarPolicy = role.calendar?.policy
  const updatesCurrentScope = hasConnectionDraft(role, savedConfiguration, view)
  const hasScope =
    view === 'projects'
      ? collaboration.allProjects ||
        collaboration.projects.length > 0 ||
        collaboration.includeParticipatingIssues ||
        collaboration.includeIndependentIssues
      : Boolean(view && role.connections?.some(row => row.providerId === view))
  const receiving = view === 'projects' ? collaboration.enabled : role.enabled
  const scopeStatus =
    view && view !== 'time' && !updatesCurrentScope
      ? !hasScope
        ? 'standIn.workspace.connection_not_configured'
        : !receiving
          ? 'standIn.workspace.connection_receiving_paused'
          : 'standIn.workspace.connection_configured'
      : null
  const status =
    updatesCurrentScope && showPendingStatus ? (
      <p
        role="status"
        data-testid="stand-in-connections-pending"
        className="text-sm text-text-secondary"
      >
        {t('standIn.workspace.connection_pending')}
      </p>
    ) : scopeStatus ? (
      <p
        role="status"
        data-testid="stand-in-connection-scope-status"
        className="text-sm text-text-secondary"
      >
        {t(scopeStatus)}
      </p>
    ) : null
  const detailHeader =
    view === 'time'
      ? { icon: Clock, title: timeTitle }
      : view === 'projects'
        ? { icon: Folder, title: projectsTitle }
        : provider
          ? {
              icon:
                provider.id === EMAIL_PROVIDER
                  ? Mail
                  : provider.id.startsWith(GIT_CONNECTION_PREFIX)
                    ? GitBranch
                    : MessageSquare,
              title: provider.displayName,
            }
          : null
  const install = model.install
  return (
    <ConnectionScopeNavigation value={scopeNavigation}>
      <section
        className={view === 'time' ? 'flex min-h-0 flex-1 flex-col gap-3' : 'space-y-3'}
        data-testid="stand-in-connection-settings"
      >
        {scopeEditor && onDetailTitleChange ? null : detailHeader ? (
          <StandInConnectionHeader {...detailHeader}>{status}</StandInConnectionHeader>
        ) : (
          status
        )}
        {scopeEditor &&
          onDetailTitleChange &&
          (updatesCurrentScope ||
            scopeStatus === 'standIn.workspace.connection_receiving_paused') &&
          status}
        {view ? (
          <>
            {view === 'time' && scheduling ? (
              <div
                className="flex min-h-0 flex-1 flex-col gap-4"
                data-testid="stand-in-calendar-connection"
              >
                <StandInConnectionForm
                  compact
                  account={weworkAccount}
                  fillScope={scheduleEditorOpen}
                  scope={
                    <>
                      {!scheduleEditorOpen && (
                        <h4 className="text-sm font-medium">
                          {t('standIn.workspace.connection_schedule_title')}
                        </h4>
                      )}
                      <AutomationsPage
                        ref={calendarRef}
                        onNavigate={onNavigate}
                        embedded
                        standInOwner={scheduling}
                        standInDeviceId={deviceId}
                        onEditorChange={scheduleEditorChanged}
                      />
                    </>
                  }
                  processing={
                    !scheduleEditorOpen && (
                      <div className="space-y-2 border-t border-border pt-2">
                        <ConnectionFixedTrigger
                          label={t('standIn.workspace.connection_trigger')}
                          value={t(
                            calendarPolicy?.automatic === false
                              ? 'standIn.workspace.schedule_paused'
                              : 'standIn.workspace.connection_schedule_trigger'
                          )}
                        />
                        {calendarPolicy?.automatic === false && (
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="text-sm text-text-secondary">
                              {t('standIn.workspace.schedule_paused_help')}
                            </p>
                            <ControlButton
                              variant="outline"
                              size="sm"
                              type="button"
                              data-testid="stand-in-calendar-resume"
                              disabled={disabled}
                              onClick={() =>
                                onChange({
                                  ...role,
                                  calendar: { policy: { ...calendarPolicy, automatic: true } },
                                })
                              }
                            >
                              {t('standIn.workspace.schedule_resume')}
                            </ControlButton>
                          </div>
                        )}
                        <SettingsRow
                          className="px-0"
                          label={t('standIn.workspace.schedule_ask_before_act')}
                          description={t('standIn.workspace.schedule_ask_before_act_help')}
                        >
                          <SettingsSwitch
                            data-testid="stand-in-calendar-policy-ask-before-act"
                            aria-label={t('standIn.workspace.schedule_ask_before_act')}
                            disabled={disabled}
                            checked={calendarPolicy?.askBeforeAct ?? false}
                            onCheckedChange={askBeforeAct =>
                              onChange({
                                ...role,
                                calendar: {
                                  policy: {
                                    automatic: calendarPolicy?.automatic ?? true,
                                    askBeforeAct,
                                  },
                                },
                              })
                            }
                          />
                        </SettingsRow>
                      </div>
                    )
                  }
                />
              </div>
            ) : view === 'projects' ? (
              <StandInConnections
                ref={projectRef}
                account={weworkAccount}
                savedSource={savedConfiguration?.collaboration}
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
                    savedConnections={savedConfiguration?.connections}
                    local={deviceId === localDeviceId}
                    canManageAccounts={Boolean(scheduling)}
                    disabled={disabled || loading}
                    onChange={onChange}
                  />
                ) : provider.id.startsWith(GIT_CONNECTION_PREFIX) ? (
                  <StandInGitConnections
                    userId={scheduling?.userId}
                    key={`${deviceId}:${role.id}:${provider.id}`}
                    provider={provider}
                    role={role}
                    savedConnections={savedConfiguration?.connections}
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
                    savedConnections={savedConfiguration?.connections}
                    api={api}
                    deviceId={deviceId}
                    localDeviceId={localDeviceId}
                    disabled={disabled || loading}
                    onChange={onChange}
                    onReady={() => model.reload()}
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
              savedConfiguration={savedConfiguration}
              projectScopeConfigured={projectScopeConfigured}
              projects={projects}
              providers={providers}
              loading={loading}
              disabled={disabled}
              scheduling={Boolean(scheduling)}
              onSelect={setView}
            />
          </>
        )}
        {loading && view !== 'projects' && (
          <p role="status" className="text-sm text-text-secondary">
            {t('standIn.workspace.loading_connections')}
          </p>
        )}
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
        {visibleError && view !== 'projects' && (
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
    </ConnectionScopeNavigation>
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
