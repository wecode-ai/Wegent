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
import { Check, Plus, SlidersHorizontal, UserRound } from 'lucide-react'
import { StandInSettingsEntry } from './StandInSettingsLayout'
import { createPortal } from 'react-dom'
import { StandInIcon } from '@wegent/collaboration'
import {
  roleIncludesProject,
  standInRoleName,
  subscribePersonalStandIn,
  standInConversationTaskId,
  type PersonalStandInSettings,
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
import { TemporaryChatPanel } from '@/components/layout/workspace-panels/TemporaryChatPanel'
import { StandInDetailsPopover } from './StandInDetailsPopover'
import { StandInScheduleDialog } from './StandInScheduleDialog'
import { Tooltip } from '@/components/ui/tooltip'
import { StandInWorkList } from './StandInWorkList'
import { mergeStandInWorkItems, standInWorkRole } from './standInWork'
import { StandInMemoryPanel } from './StandInMemoryPanel'
import { StandInPrimaryProfile } from './StandInPrimaryProfile'
import { StandInProcessingNotice } from './StandInProcessingNotice'
import { StandInOnboarding } from './StandInOnboarding'
import { StandInProposalCard } from './StandInProposalCard'
import { StandInReviewDialog } from './StandInReviewDialog'
import { useStandInProcessingStatus } from './useStandInProcessingStatus'
import { useStandInInbox } from './useStandInInbox'
import type { StandInRoleLocation } from './useStandInRoleDirectory'

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
  const [roleId, setRoleId] = useState<string | undefined>(
    props.initialProfileId === '@primary'
      ? undefined
      : (props.initialProfileId ?? initialSelectedRoleId)
  )
  const [detailsTarget, setDetailsTarget] = useState<{ anchor: HTMLElement; scope: string } | null>(
    null
  )
  const setDetailsAnchor = (anchor: null) => setDetailsTarget(anchor)
  const detailsTrigger = useRef<HTMLButtonElement>(null)
  const [calendarRequest, setCalendarRequest] = useState(initialWorkView === 'scheduled' ? 1 : 0)
  const [scheduleTarget, setScheduleTarget] = useState<{ id: string; scope: string }>()
  const scheduleTrigger = useRef<HTMLElement | null>(null)
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
  const [resolvedProposal, setResolvedProposal] = useState<{
    proposal: StandInProposal
    previous: PersonalStandInSettings
    result: 'accepted' | 'rejected'
  } | null>(null)
  const settledProposalIds = useRef(new Set<string>())
  const resolvingProposal = useRef(false)
  const [review, setReview] = useState<'proposal' | 'status' | 'work' | null>(null)
  const [guideOpen, setGuideOpen] = useState(false)
  const [exampleDraft, setExampleDraft] = useState<{ id: number; text: string }>()
  const exampleSequence = useRef(0)
  const [proposalError, setProposalError] = useState<string | null>(null)
  const [proposalSaveError, setProposalSaveError] = useState<{
    id: string
    message: string
  } | null>(null)
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
  const deviceId = state.loadedDeviceId ?? props.initialDeviceId ?? saved?.executionDeviceId
  const requestNavigation = useCallback(
    (route: string) => {
      const [pathname, search] = route.split('?')
      if (pathname !== '/stand-in') return
      if (!search) {
        const openPrimary = () => {
          if (primaryDeviceId && primaryDeviceId !== deviceId && onSelectLocation) {
            onSelectLocation(primaryDeviceId)
            return
          }
          setRoleId(undefined)
          setDetailsAnchor(null)
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
    [roleId, reload, primaryDeviceId, deviceId, onSelectLocation]
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
  const detailsScope = JSON.stringify([props.userId, deviceId, roleId, active])
  const selectedScheduleId = scheduleTarget?.scope === detailsScope ? scheduleTarget.id : undefined
  const setSelectedScheduleId = (id?: string) =>
    setScheduleTarget(id ? { id, scope: detailsScope } : undefined)
  const detailsAnchor = detailsTarget?.scope === detailsScope ? detailsTarget.anchor : null
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
          setProposal(next && !settledProposalIds.current.has(next.id) ? next : null)
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
  const roles = roleLocations?.map(entry => entry.role) ?? state.draft?.roles ?? []
  const role =
    roleLocations?.find(entry => entry.role.id === roleId && entry.deviceId === deviceId)?.role ??
    state.draft?.roles.find(value => value.id === roleId)
  useStandInOpened(
    profile === 'memory' ? 'memory' : profile === 'primary' ? 'settings' : 'overview',
    roleId ? 'role' : 'primary',
    active && profile !== 'role' && profile !== 'create'
  )
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
  const resolveProposal = async (accept: boolean) => {
    if (!api || !deviceId || !currentProposal || !saved || resolvingProposal.current) return
    resolvingProposal.current = true
    setResolving(true)
    setProposalSaveError(null)
    try {
      const applied = await api.resolveProposal(props.userId, deviceId, currentProposal.id, accept)
      settledProposalIds.current.add(currentProposal.id)
      setResolvedProposal({
        proposal: {
          ...currentProposal,
          settings: accept ? applied : currentProposal.settings,
          status: accept ? 'accepted' : 'rejected',
        },
        previous: saved,
        result: accept ? 'accepted' : 'rejected',
      })
      setProposal(null)
      setReview(null)
      reload()
    } catch (cause) {
      setProposalSaveError({ id: currentProposal.id, message: getStandInErrorMessage(cause) })
    } finally {
      resolvingProposal.current = false
      setResolving(false)
    }
  }
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
          onClick={() => leavePanel(() => setProfile('memory'))}
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
                const selected =
                  roleId === value.id && (!roleLocations || value.executionDeviceId === deviceId)
                return (
                  <button
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
                  </button>
                )
              })}
              <Tooltip label={t('standIn.workspace.create_role')} side="bottom">
                <button
                  type="button"
                  data-testid="stand-in-create-role"
                  aria-label={t('standIn.workspace.create_role')}
                  onClick={() =>
                    leavePanel(() => {
                      setCalendarRequest(0)
                      setSelectedScheduleId(undefined)
                      setProfile('create')
                    })
                  }
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-muted md:h-8 md:w-8"
                >
                  <Plus aria-hidden="true" className="h-4 w-4" />
                </button>
              </Tooltip>
            </div>
          </nav>
          <Tooltip label={t('standIn.workspace.details_title')} side="bottom" align="end">
            <button
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
            </button>
          </Tooltip>
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
              scheduleTrigger.current = trigger
              setSelectedScheduleId(schedule.id)
            }}
            name={role?.name || t('standIn.title')}
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
              setProfile(role ? 'role' : 'primary')
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
              window.requestAnimationFrame(() =>
                (scheduleTrigger.current?.isConnected
                  ? scheduleTrigger.current
                  : detailsTrigger.current
                )?.focus({ preventScroll: true })
              )
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
            onOpenTask={
              onOpenTask
                ? async address => {
                    await onOpenTask(address)
                    setReview(null)
                  }
                : undefined
            }
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
                    onBack={() => setProfile(roleId ? 'role' : 'primary')}
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
                    saving={state.saving || state.loading}
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
          setExampleDraft({ id: ++exampleSequence.current, text })
        })
      }
      bypass={Boolean(props.initialProfileId || profile || (!saved && state.error))}
      onClose={props.onCancel}
    >
      {content}
    </StandInOnboarding>
  ) : (
    content
  )
}
