import { WORKSPACE_NAVIGATION_EVENT, type WorkspaceNavigationDetail } from '@/lib/navigation'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { useStandInOpened } from '@/telemetry/useStandInOpened'
import {
  useContext,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ComponentProps,
  type Ref,
  type ReactNode,
} from 'react'
import {
  Brain,
  Check,
  CircleAlert,
  FileCheck,
  HelpCircle,
  MessageSquare,
  Plus,
  Settings,
  UserRound,
} from 'lucide-react'
import { createPortal } from 'react-dom'
import { StandInIcon } from '@wegent/collaboration'
import {
  roleIncludesProject,
  standInRoleName,
  subscribePersonalStandIn,
} from '@/api/personalStandIn'
import type { StandInProposal } from '@/api/standIn'
import { WorkbenchContext } from '@/features/workbench/workbenchContexts'
import { standInOrigin, standInState } from '@/features/notifications/standInNotifications'
import type { RuntimeTaskAddress } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import { isDesktopRuntime } from '@/lib/runtime-environment'
import { usePersonalStandIn } from './usePersonalStandIn'
import { StandInSettingsPage, type StandInSettingsHandle } from './StandInSettingsPage'
import { StandInConversation } from './StandInConversation'
import { StandInWorkList } from './StandInWorkList'
import { standInWorkRole } from './standInWork'
import { StandInMemoryPanel } from './StandInMemoryPanel'
import { StandInPrimaryProfile } from './StandInPrimaryProfile'
import { StandInProcessingNotice } from './StandInProcessingNotice'
import { StandInOnboarding } from './StandInOnboarding'
import { StandInProposalCard } from './StandInProposalCard'
import { StandInReviewDialog } from './StandInReviewDialog'
import { useStandInProcessingStatus } from './useStandInProcessingStatus'
import { inboxRuntimeItem, useStandInInbox } from './useStandInInbox'

type SettingsProps = ComponentProps<typeof StandInSettingsPage>

function roleTabClass(selected: boolean) {
  return `inline-flex min-h-8 shrink-0 items-center gap-2 rounded-lg px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${selected ? 'bg-text-primary font-medium text-background' : 'text-text-secondary hover:bg-muted'}`
}

/** Hosts personal conversations, work and settings on the selected Executor. */
export function StandInOverviewPage({
  onOpenTask,
  initialPrimaryProfile = false,
  initialWorkView = 'work',
  settingsRequestKey,
  active = true,
  ref,
  onSelectLocation,
  initialSelectedRoleId,
  headerActions,
  localDeviceId,
  entryRequestKey,
  entryRoute = '/stand-in',
  ...props
}: Omit<SettingsProps, 'ref'> & {
  onOpenTask?(address: RuntimeTaskAddress): Promise<void> | void
  initialPrimaryProfile?: boolean
  initialWorkView?: 'work' | 'scheduled'
  settingsRequestKey?: string
  active?: boolean
  ref?: Ref<Pick<StandInSettingsHandle, 'requestLeave'>>
  onSelectLocation?(deviceId: string, roleId?: string, openSettings?: boolean): void
  initialSelectedRoleId?: string
  headerActions?: ReactNode
  localDeviceId?: string
  entryRequestKey?: number
  entryRoute?: string
}) {
  const { t } = useTranslation('common')
  const workbench = useContext(WorkbenchContext)
  const state = usePersonalStandIn(
    props.services,
    props.userId,
    props.initialDeviceId,
    localDeviceId
  )
  const { saved, setDraft, reload } = state
  const [roleId, setRoleId] = useState<string | undefined>(
    props.initialProfileId === '@primary'
      ? undefined
      : (props.initialProfileId ?? initialSelectedRoleId)
  )
  const [chatting, setChatting] = useState(false)
  const [calendarRequest, setCalendarRequest] = useState(initialWorkView === 'scheduled' ? 1 : 0)
  const [profile, setProfile] = useState<'primary' | 'role' | 'create' | 'memory' | null>(
    initialWorkView === 'scheduled'
      ? props.initialProfileId && props.initialProfileId !== '@primary'
        ? 'role'
        : 'primary'
      : initialPrimaryProfile || props.initialProfileId === '@primary'
        ? 'primary'
        : props.initialProfileId
          ? 'role'
          : null
  )
  const [proposal, setProposal] = useState<StandInProposal | null>(null)
  const [review, setReview] = useState<'proposal' | 'status' | null>(null)
  const [guideOpen, setGuideOpen] = useState(false)
  const [exampleDraft, setExampleDraft] = useState<{ id: number; text: string }>()
  const exampleSequence = useRef(0)
  const [proposalError, setProposalError] = useState<string | null>(null)
  const [resolving, setResolving] = useState(false)
  const panelRef = useRef<StandInSettingsHandle>(null)
  useImperativeHandle(ref, () => ({
    requestLeave: action => (panelRef.current ? panelRef.current.requestLeave(action) : action()),
  }))
  const previousSettingsRequest = useRef(settingsRequestKey)
  useEffect(() => {
    if (previousSettingsRequest.current === settingsRequestKey) return
    previousSettingsRequest.current = settingsRequestKey
    if (!settingsRequestKey) return
    const targetRole = props.initialProfileId === '@primary' ? undefined : props.initialProfileId
    const targetPanel = props.initialProfileId === '@primary' ? 'primary' : 'role'
    if (profile === targetPanel && roleId === targetRole) return
    const openSettings = () => {
      setRoleId(targetRole)
      setProfile(targetPanel)
    }
    if (panelRef.current) panelRef.current.requestLeave(openSettings)
    else openSettings()
  }, [settingsRequestKey, props.initialProfileId, profile, roleId])
  const requestNavigation = useCallback(
    (route: string) => {
      const [pathname, search] = route.split('?')
      if (pathname !== '/stand-in') return
      if (!search) {
        const openPrimary = () => {
          setRoleId(undefined)
          setChatting(false)
          setCalendarRequest(0)
          setProfile(null)
          reload()
        }
        if (panelRef.current) panelRef.current.requestLeave(openPrimary)
        else openPrimary()
        return
      }
      if (new URLSearchParams(search).get('view') !== 'scheduled') return
      const openView = () => {
        setCalendarRequest(value => value + 1)
        setProfile(roleId ? 'role' : 'primary')
      }
      // Preserve settings drafts and guard every request, including the same URL.
      if (panelRef.current) panelRef.current.requestLeave(openView)
      else openView()
    },
    [roleId, reload]
  )
  const previousEntryRequest = useRef(entryRequestKey)
  useEffect(() => {
    if (!active || previousEntryRequest.current === entryRequestKey) return
    previousEntryRequest.current = entryRequestKey
    if (entryRequestKey !== undefined) requestNavigation(entryRoute)
  }, [active, entryRequestKey, entryRoute, requestNavigation])
  useEffect(() => {
    if (!active) return
    const onNavigate = (event: Event) => {
      const route = (event as CustomEvent<WorkspaceNavigationDetail>).detail?.contentRoute
      if (!route || (entryRequestKey !== undefined && route !== entryRoute)) return
      requestNavigation(route)
    }
    window.addEventListener(WORKSPACE_NAVIGATION_EVENT, onNavigate)
    return () => window.removeEventListener(WORKSPACE_NAVIGATION_EVENT, onNavigate)
  }, [active, entryRequestKey, entryRoute, requestNavigation])
  const leavePanel = (action: () => void) => {
    if (panelRef.current) panelRef.current.requestLeave(action)
    else action()
  }
  const pressedInPanel = useRef(false)
  const deviceId = saved?.executionDeviceId ?? props.initialDeviceId
  const api = props.services.standInApi
  const processing = useStandInProcessingStatus(
    api,
    props.userId,
    deviceId ?? '',
    active && !!deviceId
  )
  const inbox = useStandInInbox(api, props.userId, deviceId, active)
  useEffect(
    () =>
      subscribePersonalStandIn(value => {
        if (value.userId === props.userId && value.executionDeviceId === deviceId) {
          setDraft(value)
          reload()
        }
      }),
    [props.userId, deviceId, setDraft, reload]
  )
  useEffect(() => {
    if (!active || !api || !deviceId) return
    let current = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const next = await api.proposal(props.userId, deviceId, roleId)
        if (current) {
          setProposal(next)
          setProposalError(null)
        }
      } catch (cause) {
        if (current) setProposalError(getStandInErrorMessage(cause))
      } finally {
        if (current) timer = setTimeout(poll, 3000)
      }
    }
    void poll()
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [active, api, deviceId, props.userId, roleId])
  const roles = state.draft?.roles ?? []
  const role = roles.find(value => value.id === roleId)
  useStandInOpened(
    profile === 'memory' ? 'memory' : profile === 'primary' ? 'settings' : 'overview',
    roleId ? 'role' : 'primary',
    active && profile !== 'role' && profile !== 'create'
  )
  const merged = new Map(
    (workbench?.runtimeTaskReminders.items ?? []).map(item => {
      const origin = standInOrigin(item)
      const project = props.projects.find(
        project =>
          project.id === origin?.cloudProjectId &&
          (project.project_store === 'local' ? 'local' : 'cloud') ===
            (origin?.projectStore === 'local' ? 'local' : 'cloud')
      )
      return [item.task.taskId, { ...item, projectName: project?.name || item.projectName }]
    })
  )
  const visibleInbox = inbox.items.filter(work => work.messageCount > 0 || work.task)
  if (deviceId)
    for (const work of visibleInbox)
      merged.set(work.taskId, inboxRuntimeItem(work, deviceId, merged.get(work.taskId)))
  const items = [...merged.values()]
    .filter(item => standInWorkRole(item) !== null)
    .sort((a, b) => standInState(b).updatedAt.localeCompare(standInState(a).updatedAt))
  const roleItems = roleId ? items.filter(item => standInWorkRole(item) === roleId) : items
  const needsAttention = items.filter(
    item =>
      ['waiting', 'failed'].includes(standInState(item).status) ||
      inbox.items.some(
        work =>
          work.taskId === item.task.taskId && ['needs_grouping', 'failed'].includes(work.status)
      )
  )
  const conversation = roleId ? chatting : !chatting
  const chooseRole = (id?: string) =>
    leavePanel(() => {
      setCalendarRequest(0)
      setRoleId(id)
      setReview(null)
      setChatting(false)
      setProfile(null)
    })
  const overviewError = (profile === 'primary' ? null : state.error) || proposalError || inbox.error
  const currentProposal = proposal && (proposal.roleId ?? undefined) === roleId ? proposal : null
  const roleAttentionCount = needsAttention.filter(
    item => !roleId || standInWorkRole(item) === roleId
  ).length
  const processingIssue = !!(
    processing.error ||
    processing.status?.error ||
    processing.status?.awaitingUser
  )
  const issueCount = inbox.sourceErrors.length + (overviewError ? 1 : 0) + (processingIssue ? 1 : 0)
  const content = (
    <section
      className="relative flex h-full min-h-0 min-w-0 bg-background text-base text-text-primary"
      data-testid="stand-in-overview"
    >
      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-2">
          <nav
            className="min-w-0 flex-1 overflow-x-auto"
            aria-label={t('standIn.workspace.switch_role')}
            data-testid="stand-in-role-selector"
          >
            <div className="flex w-max items-center gap-1" data-testid="stand-in-overview-status">
              <button
                type="button"
                data-testid="stand-in-primary-open"
                aria-current={!roleId ? 'page' : undefined}
                onClick={() => chooseRole()}
                className={roleTabClass(!roleId)}
              >
                <UserRound aria-hidden="true" className="h-4 w-4" />
                {t('standIn.title')}
                {!roleId && <Check aria-hidden="true" className="h-3.5 w-3.5" />}
              </button>
              {roles.map((value, index) => {
                const projects = props.projects.filter(project =>
                  roleIncludesProject(value, {
                    id: project.id,
                    store: project.project_store === 'local' ? 'local' : 'cloud',
                  })
                )
                const scope = [
                  ...projects.map(project => project.name),
                  ...(value.connections ?? []).map(source => source.name),
                ].join(' · ')
                return (
                  <button
                    key={value.id}
                    type="button"
                    data-testid={`stand-in-overview-role-${value.id}`}
                    aria-current={roleId === value.id ? 'page' : undefined}
                    title={
                      scope ||
                      t(value.enabled ? 'standIn.workspace.receiving' : 'standIn.workspace.paused')
                    }
                    onClick={() => chooseRole(value.id)}
                    className={roleTabClass(roleId === value.id)}
                  >
                    <StandInIcon
                      enabled={value.enabled}
                      className={`h-4 w-4 ${roleId === value.id ? '[&_g]:text-background' : ''}`}
                    />
                    <span className="max-w-40 truncate">
                      {standInRoleName(value, index, t('standIn.personal.default_role'))}
                    </span>
                    {roleId === value.id && <Check aria-hidden="true" className="h-3.5 w-3.5" />}
                    <span className="sr-only">{scope}</span>
                    <span className="sr-only">
                      {t(value.enabled ? 'standIn.auto_on' : 'standIn.auto_off')}
                      {t('standIn.personal.connected_selected', { count: projects.length })}
                    </span>
                  </button>
                )
              })}
              <button
                type="button"
                data-testid="stand-in-create-role"
                onClick={() => {
                  setCalendarRequest(0)
                  setProfile('create')
                }}
                className="inline-flex min-h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-sm text-text-secondary hover:bg-muted"
              >
                <Plus className="h-4 w-4" />
                {t('standIn.workspace.create_role')}
              </button>
            </div>
          </nav>
          {currentProposal && state.saved && (
            <button
              type="button"
              data-testid="stand-in-proposal-open"
              onClick={() => setReview('proposal')}
              className="inline-flex min-h-11 items-center gap-2 rounded-md px-2 text-sm hover:bg-muted md:min-h-8"
            >
              <FileCheck aria-hidden="true" className="h-4 w-4" />
              {t('standIn.workspace.pending_configuration')}
            </button>
          )}
          {issueCount > 0 && (
            <button
              type="button"
              data-testid="stand-in-status-open"
              onClick={() => setReview('status')}
              className="inline-flex min-h-11 items-center gap-2 rounded-md px-2 text-sm text-text-secondary hover:bg-muted md:min-h-8"
            >
              <CircleAlert aria-hidden="true" className="h-4 w-4" />
              {t('standIn.workspace.status_issues', { count: issueCount })}
            </button>
          )}
          {
            <button
              type="button"
              data-testid="stand-in-role-chat"
              onClick={() => leavePanel(() => setChatting(value => !value))}
              className="inline-flex min-h-8 items-center gap-2 rounded-md px-2 text-sm hover:bg-muted"
            >
              <MessageSquare className="h-4 w-4" />
              {t(
                conversation
                  ? 'standIn.workspace.work_list'
                  : role
                    ? 'standIn.workspace.role_chat'
                    : 'standIn.title'
              )}
              {conversation && roleAttentionCount > 0 && (
                <span
                  data-testid="stand-in-work-attention-count"
                  className="rounded bg-muted px-1.5 text-xs tabular-nums"
                >
                  {roleAttentionCount}
                </span>
              )}
            </button>
          }
          {api && saved && (
            <button
              type="button"
              data-testid="stand-in-memory-open"
              onClick={() => setProfile('memory')}
              className="inline-flex min-h-8 items-center gap-2 rounded-md px-2 text-sm hover:bg-muted"
            >
              <Brain className="h-4 w-4" />
              {t('standIn.memory.title')}
            </button>
          )}
          <button
            type="button"
            data-testid="stand-in-settings-open"
            disabled={(!state.saved && state.loading) || state.saving}
            onClick={() => {
              setCalendarRequest(0)
              setProfile(role ? 'role' : 'primary')
            }}
            className="inline-flex min-h-8 items-center gap-2 rounded-md px-2 text-sm hover:bg-muted"
          >
            <Settings className="h-4 w-4" />
            {t(role ? 'standIn.workspace.role_profile' : 'standIn.workspace.primary_profile')}
          </button>
          <button
            type="button"
            data-testid="stand-in-guide-open"
            aria-label={t('standIn.onboarding.guide')}
            disabled={!api || !deviceId || state.loading}
            onClick={() => setGuideOpen(true)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-secondary hover:bg-muted disabled:opacity-40"
          >
            <HelpCircle aria-hidden="true" className="h-4 w-4" />
          </button>
          {headerActions}
        </header>
        {state.loading && !state.saved ? (
          <p role="status" className="p-5 text-text-muted">
            {t('standIn.loading')}
          </p>
        ) : state.error && !state.saved ? (
          <div role="alert" className="p-5 text-error">
            <p>{state.error}</p>
            <button
              type="button"
              data-testid="stand-in-overview-retry"
              onClick={reload}
              className="mt-2 underline"
            >
              {t('standIn.reload')}
            </button>
          </div>
        ) : (
          <>
            {deviceId && !profile && processing.status?.error?.code === 'model_unavailable' && (
              <StandInProcessingNotice
                snapshot={processing}
                key={`${props.userId}:${deviceId}`}
                api={api}
                userId={props.userId}
                deviceId={deviceId}
                onOpen={() => setProfile('primary')}
                onOpenTask={
                  onOpenTask
                    ? taskId => {
                        void onOpenTask({ taskId, deviceId, runtime: 'codex' })
                      }
                    : undefined
                }
              />
            )}
            {conversation && api && deviceId ? (
              <StandInConversation
                draftRequest={!roleId ? exampleDraft : undefined}
                onDraftRequestConsumed={id =>
                  setExampleDraft(current => (current?.id === id ? undefined : current))
                }
                active={active && conversation}
                hasPendingWork={!roleId && needsAttention.length > 0}
                key={`${deviceId}:${props.userId}:${roleId ? `role:${roleId}` : 'primary'}`}
                api={api}
                userId={props.userId}
                deviceId={deviceId}
                roleId={roleId}
                onOpenTask={onOpenTask}
              />
            ) : (
              <div className="flex min-h-0 flex-1 flex-col">
                <StandInWorkList
                  active={active && !conversation}
                  key={roleId ? `role:${roleId}` : 'primary'}
                  items={roleItems}
                  inbox={
                    roleId ? visibleInbox.filter(work => work.roleId === roleId) : visibleInbox
                  }
                  api={api}
                  userId={props.userId}
                  deviceId={deviceId}
                  onRefresh={inbox.refresh}
                  onOpenTask={onOpenTask}
                />
              </div>
            )}
          </>
        )}
        <StandInReviewDialog
          open={active && review === 'proposal' && !!currentProposal && !!state.saved}
          title={t('standIn.workspace.pending_configuration')}
          testId="stand-in-proposal-dialog"
          busy={resolving}
          onClose={() => setReview(null)}
        >
          {currentProposal && state.saved && (
            <StandInProposalCard
              proposal={currentProposal}
              projects={props.projects}
              current={state.saved}
              busy={resolving}
              onResolve={async accept => {
                if (!api || !deviceId) return
                setResolving(true)
                try {
                  await api.resolveProposal(props.userId, deviceId, currentProposal.id, accept)
                  setProposal(null)
                  setReview(null)
                  reload()
                } catch (cause) {
                  setProposalError(getStandInErrorMessage(cause))
                } finally {
                  setResolving(false)
                }
              }}
            />
          )}
          {proposalError && (
            <p role="alert" className="mt-3 text-sm text-error">
              {proposalError}
            </p>
          )}
        </StandInReviewDialog>
        <StandInReviewDialog
          open={active && review === 'status'}
          title={t('standIn.workspace.status_details')}
          testId="stand-in-status-dialog"
          onClose={() => setReview(null)}
        >
          {deviceId && processingIssue && (
            <StandInProcessingNotice
              snapshot={processing}
              api={api}
              userId={props.userId}
              deviceId={deviceId}
              onOpen={() => {
                setReview(null)
                setProfile('primary')
              }}
              onOpenTask={
                onOpenTask
                  ? taskId => {
                      setReview(null)
                      void onOpenTask({ taskId, deviceId, runtime: 'codex' })
                    }
                  : undefined
              }
            />
          )}
          {overviewError && (
            <div role="alert" className="mb-4 flex items-center gap-3 text-sm">
              <span className="min-w-0 flex-1">{overviewError}</span>
              <button
                type="button"
                data-testid="stand-in-overview-inline-retry"
                onClick={() => {
                  reload()
                  inbox.refresh()
                }}
                className="min-h-11 shrink-0 rounded-md px-3 hover:bg-muted md:min-h-8"
              >
                {t('standIn.reload')}
              </button>
            </div>
          )}
          <div className="divide-y divide-border">
            {inbox.sourceErrors.map(value => (
              <div
                key={`${value.source.providerId}:${value.source.profile}:${value.source.kind}:${value.source.id}`}
                className="flex items-start gap-3 py-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{value.source.name}</p>
                  <p role="alert" className="mt-1 text-sm text-text-secondary">
                    {getStandInErrorMessage(value.error)}
                  </p>
                </div>
                <button
                  type="button"
                  data-testid={`stand-in-source-retry-${value.source.id}`}
                  className="min-h-11 shrink-0 rounded-md px-3 text-sm hover:bg-muted md:min-h-8"
                  onClick={async () => {
                    try {
                      await api?.retrySource(props.userId, deviceId!, value.source)
                      inbox.refresh()
                    } catch (cause) {
                      setProposalError(getStandInErrorMessage(cause))
                    }
                  }}
                >
                  {t('standIn.reload')}
                </button>
              </div>
            ))}
          </div>
          {!issueCount && (
            <p className="text-sm text-text-secondary">{t('standIn.workspace.status_clear')}</p>
          )}
        </StandInReviewDialog>
        {profile &&
          (profile !== 'primary' || state.draft) &&
          createPortal(
            <div
              className={`fixed inset-x-0 bottom-0 z-modal bg-black/20 text-text-primary ${isDesktopRuntime() ? 'top-[38px]' : 'top-0'}`}
              data-testid="stand-in-profile-backdrop"
              style={{ display: active ? undefined : 'none' }}
              inert={!active}
              onMouseDown={event => {
                pressedInPanel.current = event.target !== event.currentTarget
              }}
              onClick={event => {
                if (event.target === event.currentTarget && !pressedInPanel.current)
                  panelRef.current?.requestClose()
                pressedInPanel.current = false
              }}
            >
              <aside
                role="dialog"
                aria-modal="true"
                aria-label={t(
                  profile === 'memory'
                    ? 'standIn.memory.title'
                    : profile === 'primary'
                      ? 'standIn.workspace.primary_profile'
                      : 'standIn.workspace.role_profile'
                )}
                data-testid="stand-in-profile-panel"
                className="absolute inset-y-0 right-0 z-20 w-full overflow-y-auto border-l border-border bg-background shadow-lg md:max-w-lg"
              >
                {profile === 'memory' && api && saved ? (
                  <StandInMemoryPanel
                    ref={panelRef}
                    key={saved.executionDeviceId}
                    api={api}
                    settings={saved}
                    projects={props.projects.filter(
                      project =>
                        project.project_store !== 'local' ||
                        saved.executionDeviceId === state.currentDeviceId
                    )}
                    onClose={() => setProfile(null)}
                  />
                ) : profile === 'primary' && state.draft ? (
                  <StandInPrimaryProfile
                    ref={panelRef}
                    key={`${state.draft.executionDeviceId}:${calendarRequest}`}
                    initialCalendar={calendarRequest > 0}
                    settings={state.draft}
                    saving={state.saving || state.loading}
                    services={props.services}
                    devices={props.devices}
                    onSelectDevice={device => {
                      if (onSelectLocation) onSelectLocation(device, '@primary', true)
                      else state.setDeviceId(device)
                    }}
                    onClose={() => {
                      setProfile(null)
                      if (initialPrimaryProfile) props.onCancel?.()
                    }}
                    onSave={async value => {
                      if (await state.save(value)) {
                        setProfile(null)
                        if (initialPrimaryProfile) props.onCancel?.()
                      }
                    }}
                    error={state.error}
                    onReload={state.reload}
                    api={api}
                    localDeviceId={state.currentDeviceId}
                    projects={props.projects}
                  />
                ) : (
                  <StandInSettingsPage
                    key={`${profile === 'create' ? '@create' : (roleId ?? '@default')}:${calendarRequest}`}
                    initialCalendar={calendarRequest > 0}
                    {...props}
                    ref={panelRef}
                    initialProfileId={roleId}
                    initialDeviceId={deviceId}
                    initialCreate={profile === 'create'}
                    onDeleted={() => {
                      setRoleId(undefined)
                      setChatting(false)
                      reload()
                      setProfile(null)
                    }}
                    onCancel={() => setProfile(null)}
                    onSaved={value => {
                      if (value.executionDeviceId && value.executionDeviceId !== deviceId) {
                        if (onSelectLocation) onSelectLocation(value.executionDeviceId, value.id)
                        else state.setDeviceId(value.executionDeviceId)
                      } else reload()
                      setProfile(null)
                    }}
                  />
                )}
              </aside>
            </div>,
            document.body
          )}
      </main>
    </section>
  )
  return api ? (
    <StandInOnboarding
      key={`${props.userId}:${deviceId}`}
      api={api}
      userId={props.userId}
      deviceId={deviceId ?? ''}
      active={active}
      configuration={{
        settings: saved,
        loading: state.loading,
        error: state.error,
        projects: props.projects,
        localDeviceId: state.currentDeviceId,
        devices: props.devices,
        onSelectDevice: device => {
          if (onSelectLocation) onSelectLocation(device)
          else state.setDeviceId(device)
        },
        onSave: state.save,
        onReload: state.reload,
      }}
      guideOpen={guideOpen}
      onGuideClose={() => setGuideOpen(false)}
      onExampleSelect={text =>
        leavePanel(() => {
          setRoleId(undefined)
          setChatting(false)
          setProfile(null)
          setGuideOpen(false)
          setExampleDraft({ id: ++exampleSequence.current, text })
        })
      }
      bypass={Boolean(props.initialProfileId || profile || chatting || (!saved && state.error))}
      onClose={props.onCancel}
    >
      {content}
    </StandInOnboarding>
  ) : (
    content
  )
}
