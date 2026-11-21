import {
  roleSelectsProject,
  standInConversationTaskId,
  standInRoleName,
} from '@/api/personalStandIn'
import { TemporaryChatPanel } from '@/components/layout/workspace-panels/TemporaryChatPanel'
import { Tooltip } from '@/components/ui/tooltip'
import { standInOrigin, standInState } from '@/features/notifications/standInNotifications'
import { WorkbenchContext } from '@/features/workbench/workbenchContexts'
import { useTranslation } from '@/hooks/useTranslation'
import type { WorkspaceNavigationDetail } from '@/lib/navigation'
import { WORKSPACE_NAVIGATION_EVENT } from '@/lib/navigation'
import { isDesktopRuntime } from '@/lib/runtime-environment'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import type { RuntimeTaskAddress } from '@/types/api'
import { StandInIcon } from '@wegent/collaboration'
import { DialogSurface } from '@wegent/collaboration/controls/DialogSurface'
import { useDOMEvent, useFocusRequest } from '@wegent/collaboration/dom-events'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { Check, Plus, SlidersHorizontal, UserRound } from 'lucide-react'
import type { ComponentProps, ReactNode, Ref } from 'react'
import {
  useCallback,
  useContext,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { createPortal } from 'react-dom'
import { StandInConversation } from './StandInConversation'
import { StandInDetailsPopover } from './StandInDetailsPopover'
import { StandInMemoryPanel } from './StandInMemoryPanel'
import { StandInOnboarding } from './StandInOnboarding'
import { createStandInOverviewSource, standInOverviewSourceKey } from './standInOverviewSource'
import { StandInPrimaryProfile } from './StandInPrimaryProfile'
import { StandInProcessingNotice } from './StandInProcessingNotice'
import { StandInProposalCard } from './StandInProposalCard'
import { StandInReviewDialog } from './StandInReviewDialog'
import { StandInScheduleDialog } from './StandInScheduleDialog'
import { StandInSettingsEntry } from './StandInSettingsLayout'
import type { StandInSettingsHandle } from './StandInSettingsPage'
import { StandInSettingsPage } from './StandInSettingsPage'
import { mergeStandInWorkItems, standInWorkRole } from './standInWork'
import { StandInWorkList } from './StandInWorkList'
import { usePersonalStandIn } from './usePersonalStandIn'
import { useStandInInbox } from './useStandInInbox'
import { useStandInProcessingStatus } from './useStandInProcessingStatus'
import type { StandInRoleLocation } from './useStandInRoleDirectory'

type SettingsProps = ComponentProps<typeof StandInSettingsPage>

function roleTabClass(selected: boolean) {
  return `inline-flex min-h-11 shrink-0 items-center gap-2 rounded-lg px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus md:min-h-8 ${selected ? 'bg-text-primary font-medium text-background' : 'text-text-secondary hover:bg-muted'}`
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
  primaryDeviceId,
  roleLocations,
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
  primaryDeviceId?: string
  roleLocations?: StandInRoleLocation[]
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
  const [overview] = useState(() =>
    createStandInOverviewSource({
      roleId:
        props.initialProfileId === '@primary'
          ? undefined
          : (props.initialProfileId ?? initialSelectedRoleId),
      profile:
        initialWorkView === 'scheduled'
          ? props.initialProfileId && props.initialProfileId !== '@primary'
            ? 'role'
            : 'primary'
          : initialPrimaryProfile || props.initialProfileId === '@primary'
            ? 'primary'
            : props.initialProfileId
              ? 'role'
              : null,
      calendarRequest: initialWorkView === 'scheduled' ? 1 : 0,
      settingsRequestKey,
      entryRequestKey,
    })
  )
  const [detailsTarget, setDetailsTarget] = useState<{ anchor: HTMLElement; scope: string } | null>(
    null
  )
  const setDetailsAnchor = (anchor: null) => setDetailsTarget(anchor)
  const detailsTrigger = useRef<HTMLButtonElement>(null)
  const [scheduleTarget, setScheduleTarget] = useState<{ id: string; scope: string }>()
  const scheduleTrigger = useRef<HTMLElement | null>(null)
  const [scheduleFocusRequest, setScheduleFocusRequest] = useState<{ scope: string }>()
  const profileTrigger = useRef<HTMLElement | null>(null)
  const rememberProfileTrigger = useCallback(
    (trigger?: HTMLElement) => {
      if (trigger) profileTrigger.current = trigger
      else if (overview.getSnapshot().profile === null)
        profileTrigger.current =
          document.activeElement instanceof HTMLElement && document.activeElement !== document.body
            ? document.activeElement
            : null
    },
    [overview]
  )
  const {
    setRoleId,
    setProfile,
    setCalendarRequest,
    setExampleDraft,
    resolveProposal,
    requestNavigation,
  } = overview
  const [review, setReview] = useState<'proposal' | 'status' | 'work' | null>(null)
  const [guideOpen, setGuideOpen] = useState(false)
  const panelRef = useRef<StandInSettingsHandle>(null)
  useImperativeHandle(ref, () => ({
    requestLeave: action => (panelRef.current ? panelRef.current.requestLeave(action) : action()),
  }))
  const deviceId = state.loadedDeviceId ?? props.initialDeviceId ?? saved?.executionDeviceId
  const api = props.services.standInApi
  const processing = useStandInProcessingStatus(
    api,
    props.userId,
    deviceId ?? '',
    active && !!deviceId
  )
  const inbox = useStandInInbox(api, props.userId, deviceId, active)
  const observation = useMemo(
    () => ({
      api,
      userId: props.userId,
      deviceId,
      active,
      saved,
      settingsRequestKey,
      initialProfileId: props.initialProfileId,
      entryRequestKey,
      entryRoute,
      primaryDeviceId,
      onSelectLocation,
      onOpenTask,
      reload,
      setDraft,
      refreshInbox: inbox.refresh,
      rememberProfileTrigger,
      requestLeave: (action: () => void) =>
        panelRef.current ? panelRef.current.requestLeave(action) : action(),
      closeReview: () => setReview(null),
      closeDetails: () => setDetailsTarget(null),
    }),
    [
      api,
      props.userId,
      deviceId,
      active,
      saved,
      settingsRequestKey,
      props.initialProfileId,
      entryRequestKey,
      entryRoute,
      primaryDeviceId,
      onSelectLocation,
      onOpenTask,
      reload,
      setDraft,
      inbox.refresh,
      rememberProfileTrigger,
    ]
  )
  const subscribe = useCallback(
    (listener: () => void) => overview.subscribe(observation, listener),
    [overview, observation]
  )
  const view = useSyncExternalStore(subscribe, overview.getSnapshot, overview.getSnapshot)
  const { roleId, profile, calendarRequest, exampleDraft } = view
  const sameOwner = view.api === api && view.userId === props.userId && view.deviceId === deviceId
  const proposal = sameOwner ? view.proposal : null
  const resolvedProposal = sameOwner ? view.resolvedProposal : null
  const proposalError = sameOwner ? view.proposalError : null
  const proposalSaveError = sameOwner ? view.proposalSaveError : null
  const resolving = sameOwner && view.resolving
  const openProfile = (target: NonNullable<typeof profile>, trigger?: HTMLElement) => {
    rememberProfileTrigger(trigger)
    setProfile(target)
  }
  const focusTarget = useMemo(
    () => ({
      get current() {
        return profileTrigger.current?.isConnected ? profileTrigger.current : detailsTrigger.current
      },
    }),
    []
  )
  useFocusRequest(focusTarget, view.focusRequest, {
    enabled: active && profile === null && view.focusRequest > 0,
  })
  useDOMEvent<CustomEvent<WorkspaceNavigationDetail>>(
    'window',
    WORKSPACE_NAVIGATION_EVENT,
    event => {
      const route = event.detail?.contentRoute
      if (route && (entryRequestKey === undefined || route === entryRoute)) requestNavigation(route)
    },
    { enabled: active }
  )
  const leavePanel = (action: () => void) => {
    if (panelRef.current) panelRef.current.requestLeave(action)
    else action()
  }
  const detailsScope = JSON.stringify([props.userId, deviceId, roleId, active])
  const selectedScheduleId = scheduleTarget?.scope === detailsScope ? scheduleTarget.id : undefined
  const setSelectedScheduleId = (id?: string) =>
    setScheduleTarget(id ? { id, scope: detailsScope } : undefined)
  const detailsAnchor = detailsTarget?.scope === detailsScope ? detailsTarget.anchor : null
  const scheduleFocusTarget = useMemo(
    () => ({
      get current() {
        return scheduleTrigger.current?.isConnected
          ? scheduleTrigger.current
          : detailsTrigger.current
      },
    }),
    []
  )
  useFocusRequest(scheduleFocusTarget, scheduleFocusRequest, {
    enabled:
      Boolean(detailsAnchor) && scheduleFocusRequest?.scope === detailsScope && !selectedScheduleId,
    animationFrame: true,
    preventScroll: true,
  })
  const roles = roleLocations?.map(entry => entry.role) ?? state.draft?.roles ?? []
  const role =
    roleLocations?.find(entry => entry.role.id === roleId && entry.deviceId === deviceId)?.role ??
    state.draft?.roles.find(value => value.id === roleId)
  const visibleInbox = inbox.items.filter(work => work.messageCount > 0 || work.task)
  const items = mergeStandInWorkItems(
    workbench?.runtimeTaskReminders.items ?? [],
    inbox.items,
    deviceId,
    props.projects
  )
    .filter(
      item =>
        standInWorkRole(item) !== null &&
        (item.address.deviceId === deviceId ||
          (roleId &&
            role?.previousExecutionDevices?.includes(item.address.deviceId) &&
            standInOrigin(item)?.userId === props.userId &&
            standInWorkRole(item) === roleId))
    )
    .sort((a, b) => standInState(b).updatedAt.localeCompare(standInState(a).updatedAt))
  const roleItems = roleId ? items.filter(item => standInWorkRole(item) === roleId) : items
  const chooseRole = (id?: string, executionDevice?: string) =>
    leavePanel(() => {
      const target =
        executionDevice ??
        (id
          ? (roleLocations?.find(entry => entry.role.id === id)?.deviceId ??
            roles.find(role => role.id === id)?.executionDeviceId)
          : primaryDeviceId)
      if (target && target !== deviceId && onSelectLocation) {
        onSelectLocation(target, id)
        return
      }
      setCalendarRequest(0)
      setRoleId(id)
      setReview(null)
      setDetailsAnchor(null)
      setProfile(null)
    })
  const currentProposal = proposal && (proposal.roleId ?? undefined) === roleId ? proposal : null
  const proposalFailureMessage =
    (proposalSaveError?.id === currentProposal?.id ? proposalSaveError?.message : null) ||
    proposalError
  const overviewError =
    (profile === 'primary' ? null : state.error) || proposalFailureMessage || inbox.error
  const currentResult =
    resolvedProposal &&
    resolvedProposal.previous.userId === props.userId &&
    resolvedProposal.previous.executionDeviceId === deviceId &&
    (resolvedProposal.proposal.roleId ?? undefined) === roleId
      ? resolvedProposal
      : null
  const proposalCard =
    currentProposal && saved ? (
      <StandInProposalCard
        proposal={currentProposal}
        projects={props.projects}
        current={saved}
        busy={resolving}
        onResolve={resolveProposal}
      />
    ) : currentResult ? (
      <StandInProposalCard
        proposal={currentResult.proposal}
        projects={props.projects}
        current={currentResult.previous}
        result={currentResult.result}
        busy={false}
        onResolve={resolveProposal}
      />
    ) : null
  const proposalFailure = proposalFailureMessage && (
    <p role="alert" className="mb-3 text-sm text-error">
      {proposalFailureMessage}
    </p>
  )
  const processingIssue = !!(
    processing.error ||
    processing.status?.error ||
    processing.status?.awaitingUser
  )
  const management = (
    <section data-testid="stand-in-settings-tools" className="mt-6">
      {api && saved && (
        <StandInSettingsEntry
          testId="stand-in-memory-open"
          label={t('standIn.memory.title')}
          disabled={false}
          onClick={() => leavePanel(() => openProfile('memory'))}
        />
      )}
    </section>
  )
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
              <ControlButton
                variant="unstyled"
                type="button"
                data-testid="stand-in-primary-open"
                aria-current={!roleId ? 'page' : undefined}
                onClick={() => chooseRole()}
                className={roleTabClass(!roleId)}
              >
                <UserRound aria-hidden="true" className="h-4 w-4" />
                {t('standIn.title')}
                {!roleId && <Check aria-hidden="true" className="h-3.5 w-3.5" />}
              </ControlButton>
              {roles.map((value, index) => {
                const projects = props.projects.filter(project =>
                  roleSelectsProject(value, {
                    id: project.id,
                    store: project.project_store === 'local' ? 'local' : 'cloud',
                  })
                )
                const scope = [
                  ...projects.map(project => project.name),
                  ...(value.connections ?? []).map(source => source.name),
                ].join(' · ')
                const selected =
                  roleId === value.id && (!roleLocations || value.executionDeviceId === deviceId)
                return (
                  <ControlButton
                    variant="unstyled"
                    key={`${value.migrationSource ?? value.executionDeviceId}:${value.id}`}
                    type="button"
                    data-testid={`stand-in-overview-role-${value.id}${roles.filter(role => role.id === value.id).length > 1 ? `-${value.executionDeviceId}` : ''}`}
                    aria-current={selected ? 'page' : undefined}
                    title={
                      scope ||
                      t(value.enabled ? 'standIn.workspace.receiving' : 'standIn.workspace.paused')
                    }
                    onClick={() => chooseRole(value.id, value.executionDeviceId)}
                    className={roleTabClass(selected)}
                  >
                    <StandInIcon
                      enabled={value.enabled}
                      className={`h-4 w-4 ${selected ? '[&_g]:text-background' : ''}`}
                    />
                    <span className="max-w-40 truncate">
                      {standInRoleName(value, index, t('standIn.personal.default_role'))}
                    </span>
                    {selected && <Check aria-hidden="true" className="h-3.5 w-3.5" />}
                    <span className="sr-only">{scope}</span>
                    <span className="sr-only">
                      {t(value.enabled ? 'standIn.auto_on' : 'standIn.auto_off')}
                      {t('standIn.personal.connected_selected', { count: projects.length })}
                    </span>
                  </ControlButton>
                )
              })}
              <Tooltip label={t('standIn.workspace.create_role')} side="bottom">
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid="stand-in-create-role"
                  aria-label={t('standIn.workspace.create_role')}
                  onClick={event => {
                    const trigger = event.currentTarget
                    leavePanel(() => {
                      setCalendarRequest(0)
                      setSelectedScheduleId(undefined)
                      openProfile('create', trigger)
                    })
                  }}
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-muted md:h-8 md:w-8"
                >
                  <Plus aria-hidden="true" className="h-4 w-4" />
                </ControlButton>
              </Tooltip>
            </div>
          </nav>
          <Tooltip label={t('standIn.workspace.details_title')} side="bottom" align="end">
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid="stand-in-details-open"
              ref={detailsTrigger}
              aria-label={t('standIn.workspace.details_title')}
              aria-haspopup="dialog"
              aria-expanded={!!detailsAnchor}
              disabled={(!state.saved && state.loading) || state.saving}
              onClick={event => {
                const anchor = event.currentTarget
                setDetailsTarget(detailsAnchor ? null : { anchor, scope: detailsScope })
              }}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md hover:bg-muted md:h-8 md:w-8"
            >
              <SlidersHorizontal aria-hidden="true" className="h-4 w-4" />
            </ControlButton>
          </Tooltip>
          <p data-testid="stand-in-role-help" className="w-full text-sm text-text-secondary">
            {t('standIn.workspace.role_help')}
          </p>
        </header>
        {state.loading && !state.saved ? (
          <p role="status" className="p-5 text-text-secondary">
            {t('standIn.loading')}
          </p>
        ) : state.error && !state.saved ? (
          <div role="alert" className="p-5 text-error">
            <p>{state.error}</p>
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid="stand-in-overview-retry"
              onClick={reload}
              className="mt-2 min-h-11 min-w-11 underline md:min-h-8"
            >
              {t('standIn.reload')}
            </ControlButton>
          </div>
        ) : (
          <>
            {api && deviceId ? (
              <StandInConversation
                contentFooter={
                  review !== 'proposal' && (proposalCard || proposalFailure) ? (
                    <>
                      {proposalCard}
                      {proposalFailure}
                    </>
                  ) : null
                }
                draftRequest={!roleId ? exampleDraft : undefined}
                onDraftRequestConsumed={id =>
                  setExampleDraft(current => (current?.id === id ? undefined : current))
                }
                active={active}
                key={`${deviceId}:${props.userId}:${roleId ? `role:${roleId}` : 'primary'}`}
                api={api}
                userId={props.userId}
                deviceId={deviceId}
                roleId={roleId}
                settings={roleId ? saved?.roles.find(role => role.id === roleId) : saved?.primary}
                services={props.services}
                onOpenTask={onOpenTask}
              />
            ) : null}
          </>
        )}
        {detailsAnchor && active && (
          <StandInDetailsPopover
            key={`${props.userId}:${deviceId}:${roleId ?? '@primary'}`}
            anchor={detailsAnchor}
            userId={props.userId}
            roleId={roleId}
            automationApi={props.services.automationApi}
            imConnections={
              deviceId
                ? {
                    services: props.services,
                    devices: props.devices,
                    deviceId,
                    roleId,
                  }
                : undefined
            }
            suspended={!!selectedScheduleId}
            onSchedule={(schedule, trigger) => {
              setScheduleFocusRequest(undefined)
              scheduleTrigger.current = trigger
              setSelectedScheduleId(schedule.id)
            }}
            name={
              role
                ? standInRoleName(
                    role,
                    Math.max(0, roles.indexOf(role)),
                    t('standIn.personal.default_role')
                  )
                : t('standIn.title')
            }
            configuration={role ?? saved?.primary}
            projects={props.projects}
            enabled={role ? role.enabled : saved?.primary?.enabled !== false}
            device={props.devices.find(
              device => device.device_id === deviceId || device.app_device_id === deviceId
            )}
            conversation={
              deviceId
                ? { deviceId, taskId: standInConversationTaskId(props.userId, roleId) }
                : undefined
            }
            items={roleItems.filter(
              item =>
                !(item.task.runtimeHandle?.origin as Record<string, unknown> | undefined)
                  ?.inboxStatus
            )}
            inbox={visibleInbox}
            sourceErrors={inbox.sourceErrors}
            error={
              overviewError ||
              processing.error ||
              processing.status?.error?.message ||
              (processing.status?.awaitingUser ? t('standIn.personal.activity_waiting') : null)
            }
            onClose={() => {
              setDetailsAnchor(null)
              detailsAnchor.focus()
            }}
            onSettings={() => {
              setDetailsAnchor(null)
              setCalendarRequest(0)
              setSelectedScheduleId(undefined)
              openProfile(role ? 'role' : 'primary')
            }}
            onGuide={() => {
              setDetailsAnchor(null)
              setGuideOpen(true)
            }}
            onAllActivity={() => {
              setDetailsAnchor(null)
              setReview('work')
            }}
            renderActivity={item => (
              <TemporaryChatPanel
                key={item.key}
                currentProject={null}
                source={null}
                instanceId={`stand-in-activity:${item.address.deviceId}:${item.address.taskId}`}
                testId="stand-in-activity-conversation"
                initialAddress={item.address}
                sendEphemeral={false}
                showExecutionTools={false}
                readOnly
                expanded
                active={active}
                onOpenRuntimeTask={onOpenTask}
              />
            )}
            onStatus={() => {
              setDetailsAnchor(null)
              setReview('status')
            }}
            onProposal={
              currentProposal && state.saved
                ? () => {
                    setDetailsAnchor(null)
                    setReview('proposal')
                  }
                : undefined
            }
            onOpenTask={onOpenTask}
          />
        )}
        {selectedScheduleId && detailsAnchor && active && deviceId && (
          <StandInScheduleDialog
            key={`${detailsScope}:${selectedScheduleId}`}
            id={selectedScheduleId}
            userId={props.userId}
            roleId={roleId ?? '@primary'}
            deviceId={deviceId}
            onClose={() => {
              setSelectedScheduleId(undefined)
              setScheduleFocusRequest({ scope: detailsScope })
            }}
          />
        )}
        <StandInReviewDialog
          open={active && review === 'work'}
          title={t('standIn.workspace.details_activity')}
          testId="stand-in-work-dialog"
          onClose={() => {
            setReview(null)
            detailsTrigger.current?.focus()
          }}
        >
          <StandInWorkList
            active={active && review === 'work'}
            items={roleItems}
            inbox={roleId ? visibleInbox.filter(work => work.roleId === roleId) : visibleInbox}
            api={api}
            userId={props.userId}
            deviceId={deviceId}
            onRefresh={inbox.refresh}
            onNavigate={navigate => {
              setReview(null)
              navigate()
            }}
            onOpenTask={onOpenTask ? overview.openTask : undefined}
            onRestoreTask={
              props.services.runtimeWorkApi
                ? async address => {
                    await props.services.runtimeWorkApi!.unarchiveConversation(address)
                  }
                : undefined
            }
          />
        </StandInReviewDialog>
        <StandInReviewDialog
          open={active && review === 'proposal' && !!currentProposal && !!state.saved}
          title={t('standIn.workspace.pending_configuration')}
          testId="stand-in-proposal-dialog"
          busy={resolving}
          onClose={() => {
            setReview(null)
            detailsTrigger.current?.focus()
          }}
        >
          {proposalCard}
          {proposalFailure}
        </StandInReviewDialog>
        <StandInReviewDialog
          open={active && review === 'status'}
          title={t('standIn.workspace.status_details')}
          testId="stand-in-status-dialog"
          onClose={() => {
            setReview(null)
            detailsTrigger.current?.focus()
          }}
        >
          {deviceId && processingIssue && (
            <StandInProcessingNotice
              snapshot={processing}
              api={api}
              userId={props.userId}
              deviceId={deviceId}
              onOpen={() => {
                setReview(null)
                openProfile('primary')
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
          {props.devices
            .filter(device => device.device_id === deviceId || device.app_device_id === deviceId)
            .map(device =>
              device.error ? (
                <p key={device.device_id} role="alert" className="mb-4 text-sm text-error">
                  {getStandInErrorMessage(device.error)}
                </p>
              ) : null
            )}
          {overviewError && (
            <div role="alert" className="mb-4 flex items-center gap-3 text-sm">
              <span className="min-w-0 flex-1">{overviewError}</span>
              <ControlButton
                variant="unstyled"
                type="button"
                data-testid="stand-in-overview-inline-retry"
                onClick={() => {
                  reload()
                  inbox.refresh()
                }}
                className="min-h-11 shrink-0 rounded-md px-3 hover:bg-muted md:min-h-8"
              >
                {t('standIn.reload')}
              </ControlButton>
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
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid={`stand-in-source-retry-${value.source.id}`}
                  className="min-h-11 shrink-0 rounded-md px-3 text-sm hover:bg-muted md:min-h-8"
                  aria-busy={
                    sameOwner && view.retryingSources.has(standInOverviewSourceKey(value.source))
                  }
                  onClick={() => void overview.retrySource(value.source)}
                >
                  {t('standIn.reload')}
                </ControlButton>
              </div>
            ))}
          </div>
          {!inbox.sourceErrors.length && !overviewError && !processingIssue && (
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
                overview.pressPanel(event.target !== event.currentTarget)
              }}
              onClick={event => {
                const outside = overview.consumeBackdropClick()
                if (event.target === event.currentTarget && outside)
                  panelRef.current?.requestClose()
              }}
            >
              <DialogSurface
                onClose={() => panelRef.current?.requestClose()}
                render={
                  <aside
                    aria-label={t(
                      profile === 'memory'
                        ? 'standIn.memory.title'
                        : profile === 'primary'
                          ? 'standIn.workspace.primary_profile'
                          : 'standIn.workspace.role_profile'
                    )}
                    data-testid="stand-in-profile-panel"
                    className="absolute inset-y-0 right-0 z-20 w-full overflow-y-auto border-l border-border bg-background shadow-lg md:max-w-lg"
                  />
                }
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
                    onBack={() => openProfile(roleId ? 'role' : 'primary')}
                    parentLabel={t(
                      roleId
                        ? 'standIn.workspace.role_profile'
                        : 'standIn.workspace.primary_profile'
                    )}
                  />
                ) : profile === 'primary' && state.draft ? (
                  <StandInPrimaryProfile
                    ref={panelRef}
                    management={management}
                    footerLeading={
                      !primaryDeviceId || deviceId === primaryDeviceId ? headerActions : undefined
                    }
                    key={`${state.draft.executionDeviceId}:${calendarRequest}`}
                    initialCalendar={calendarRequest > 0}
                    settings={state.draft}
                    saving={state.saving}
                    loading={state.loading}
                    services={props.services}
                    devices={props.devices}
                    deviceReadOnly={!!primaryDeviceId}
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
                    management={management}
                    footerLeading={
                      !primaryDeviceId || deviceId === primaryDeviceId ? headerActions : undefined
                    }
                    ref={panelRef}
                    initialProfileId={roleId}
                    initialDeviceId={
                      profile === 'create'
                        ? (localDeviceId ?? deviceId)
                        : (role?.executionDeviceId ?? deviceId)
                    }
                    initialCreate={profile === 'create'}
                    onDeleted={() => {
                      setRoleId(undefined)
                      setDetailsAnchor(null)
                      if (primaryDeviceId && primaryDeviceId !== deviceId && onSelectLocation)
                        onSelectLocation(primaryDeviceId)
                      else reload()
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
              </DialogSurface>
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
        onSelectDevice: primaryDeviceId
          ? undefined
          : device => {
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
          setDetailsAnchor(null)
          setProfile(null)
          setGuideOpen(false)
          overview.draftExample(text)
        })
      }
      bypass={Boolean(
        props.initialProfileId ||
        profile ||
        (roleId && primaryDeviceId && primaryDeviceId !== deviceId) ||
        (!saved && state.error)
      )}
      onClose={props.onCancel}
    >
      {content}
    </StandInOnboarding>
  ) : (
    content
  )
}
