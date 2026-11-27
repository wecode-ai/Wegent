import { useWorkbenchTaskReminders } from '@/features/workbench/runtimeTaskReminders'
import {
  standInConversationTaskId,
  standInRoleName,
  type StandInShareEntry,
  type StandInTeam,
} from '@/api/personalStandIn'
import type { MessageCenterSource } from '@/api/standInMessageCenter'
import { TemporaryChatPanel } from '@/components/layout/workspace-panels/TemporaryChatPanel'
import { Tooltip } from '@/components/ui/tooltip'
import { dingTalkInboxScope } from '@/features/collaboration-exp/stand-in/dingtalkDelegation'
import { standInOrigin, standInState } from '@/features/notifications/standInNotifications'
import { useStableEvent } from '@/features/workbench/useStableEvent'
import { useTranslation } from '@/hooks/useTranslation'
import type { WorkspaceNavigationDetail } from '@/lib/navigation'
import { navigateTo, WORKSPACE_NAVIGATION_EVENT } from '@/lib/navigation'
import { isDesktopRuntime } from '@/lib/runtime-environment'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { findWorkbenchDevice } from '@/lib/workbench-device'
import type { RuntimeTaskAddress } from '@/types/api'
import { DialogSurface } from '@wegent/collaboration/controls/DialogSurface'
import { useDOMEvent, useFocusRequest } from '@wegent/collaboration/dom-events'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { PanelRight, SlidersHorizontal } from 'lucide-react'
import type { ComponentProps, ReactNode, Ref } from 'react'
import {
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { createPortal } from 'react-dom'
import { StandInConversation } from './StandInConversation'
import { StandInDetailsPopover } from './StandInDetailsPopover'
import type { activeStandInBranchRows } from './standInDelegatedBranches'
import type { PersonalAssistantAccount } from '@/api/personalAssistantAccount'
import { StandInGhostRevisionPanel } from './StandInGhostRevisionPanel'
import { StandInImConnections } from './StandInImConnections'
import { StandInMemoryPanel } from './StandInMemoryPanel'
import { createDingTalkMessageCenterApi } from './dingTalkMessageCenterApi'
import { StandInMessageCenterHost } from './StandInMessageCenterHost'
import { StandInOnboarding } from './StandInOnboarding'
import { createStandInOverviewSource, standInOverviewSourceKey } from './standInOverviewSource'
import { StandInPrimaryProfile } from './StandInPrimaryProfile'
import { standInProcessingFailure } from './standInProcessingFailure'
import { StandInProcessingNotice } from './StandInProcessingNotice'
import { StandInProposalCard } from './StandInProposalCard'
import { StandInReviewDialog } from './StandInReviewDialog'
import { StandInNavigation } from './StandInRoleSelector'
import type { StandInSettingsShortcut } from './StandInSettingsLayout'
import type { StandInSettingsHandle } from './StandInSettingsPage'
import { StandInSettingsPage } from './StandInSettingsPage'
import { StandInTeamAndShareControls } from './StandInTeamAndShareControls'
import { mergeStandInWorkItems, standInWorkRole } from './standInWork'
import { StandInWorkList } from './StandInWorkList'
import { usePersonalStandIn } from './usePersonalStandIn'
import { useStandInInbox } from './useStandInInbox'
import { useStandInProcessingStatus } from './useStandInProcessingStatus'
import { resolveAssistantExecutionDevice } from './personalAssistantDeviceSettings'
import type { StandInRoleLocation } from './useStandInRoleDirectory'

type SettingsProps = ComponentProps<typeof StandInSettingsPage>

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
  primarySettingsActions,
  directoryError,
  isKnownAssistantDevice,
  localDeviceId,
  entryRequestKey,
  entryRoute = '/stand-in',
  primaryDeviceId,
  roleLocations,
  workspaceView,
  onWorkspaceViewChange,
  account,
  onBindDevice,
  onSelectAssistantDevice,
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
  primarySettingsActions?: ReactNode
  directoryError?: string
  isKnownAssistantDevice?: (id: string) => boolean
  localDeviceId?: string
  entryRequestKey?: number
  entryRoute?: string
  primaryDeviceId?: string
  roleLocations?: StandInRoleLocation[]
  workspaceView: 'conversation' | 'messages'
  onWorkspaceViewChange(view: 'conversation' | 'messages'): void
  account?: PersonalAssistantAccount
  onBindDevice?(roleId: string, device: string): Promise<void>
  onSelectAssistantDevice?(deviceId: string): Promise<void>
}) {
  const { t } = useTranslation('common')
  const { items: taskReminderItems } = useWorkbenchTaskReminders()
  const state = usePersonalStandIn(
    props.services,
    props.userId,
    props.initialDeviceId,
    localDeviceId
  )
  const { saved, reload } = state
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
  const messageCenterSettingsTrigger = useRef<HTMLButtonElement>(null)
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
  const [review, setReview] = useState<{ proposalId: string } | 'status' | 'work' | null>(null)
  const [guideOpen, setGuideOpen] = useState(false)
  const [imDialogOpen, setImDialogOpen] = useState(false)
  const panelRef = useRef<StandInSettingsHandle>(null)
  useImperativeHandle(ref, () => ({
    requestLeave: action => (panelRef.current ? panelRef.current.requestLeave(action) : action()),
  }))
  const deviceId = state.loadedDeviceId ?? props.initialDeviceId ?? saved?.executionDeviceId
  const api = props.services.standInApi
  const [selectedTeam, setSelectedTeam] = useState<{ owner: string; id: string } | null>(null)
  const teamOwner = JSON.stringify([props.userId, deviceId])
  const [selectedShare, setSelectedShare] = useState<{
    owner: string
    entry: StandInShareEntry
  } | null>(null)
  const shared = selectedShare?.owner === teamOwner ? selectedShare.entry : undefined
  const sharedScope = shared
    ? (`shared:${shared.owner_user_id}:${shared.resource_kind}:${shared.source_id}` as const)
    : undefined
  const team =
    selectedTeam?.owner === teamOwner
      ? saved?.teams?.find(team => team.id === selectedTeam.id)
      : undefined
  const teamScope = team ? (`team:${team.id}` as const) : undefined
  const teamLead = team?.leadId === '@primary' ? undefined : team?.leadId
  const openTeam = (team: StandInTeam) => {
    onWorkspaceViewChange('conversation')
    setSelectedShare(null)
    setSelectedTeam({ owner: teamOwner, id: team.id })
    setDetailsTarget(null)
  }
  const processing = useStandInProcessingStatus(
    api,
    props.userId,
    deviceId ?? '',
    active && !!deviceId
  )
  const inbox = useStandInInbox(
    api,
    props.userId,
    deviceId,
    active,
    dingTalkInboxScope(saved?.primary?.delegation)
  )

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
      refreshInbox: inbox.refresh,
      rememberProfileTrigger,
      requestLeave: (action: () => void) =>
        panelRef.current ? panelRef.current.requestLeave(action) : action(),
      closeReview: () => setReview(null),
      closeDetails: () => setDetailsTarget(null),
      clearConversationSelection: () => {
        setSelectedTeam(null)
        setSelectedShare(null)
      },
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
  const conversationRole = shared ? undefined : team ? teamLead : roleId
  const conversationScope = sharedScope ?? teamScope
  const showingMessageCenter = Boolean(
    api && !roleId && !team && !shared && workspaceView === 'messages'
  )
  const definition = account?.definitions.find(entry => entry.roleId === (roleId ?? '@primary'))
  const boundDevice = definition?.bot.spec?.execution_policy?.environment_id
  const conversationDevice =
    !conversationScope && definition && deviceId && isKnownAssistantDevice
      ? resolveAssistantExecutionDevice(
          boundDevice,
          account?.definitions.find(entry => entry.roleId === '@primary')?.bot.spec
            ?.execution_policy?.environment_id,
          primaryDeviceId ?? deviceId,
          isKnownAssistantDevice
        )
      : (!conversationScope && boundDevice) || deviceId
  const conversationUser = props.userId
  const [bindingPending, setBindingPending] = useState(false)
  const [bindingError, setBindingError] = useState('')

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
  const openMessageCenterSettings = (
    source: MessageCenterSource | undefined,
    trigger: HTMLElement
  ) => {
    rememberProfileTrigger(trigger)
    setCalendarRequest(0)
    setProfile('primary', source ?? true)
  }
  const focusTarget = useMemo(
    () => ({
      get current() {
        return profileTrigger.current?.isConnected
          ? profileTrigger.current
          : (messageCenterSettingsTrigger.current ?? detailsTrigger.current)
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
  const openAssistantDialog = (open: () => void) =>
    leavePanel(() => {
      setReview(null)
      setProfile(null)
      setDetailsAnchor(null)
      open()
    })
  const openMessageCenter = () =>
    leavePanel(() => {
      onWorkspaceViewChange('messages')
      setSelectedTeam(null)
      setSelectedShare(null)
      setRoleId(undefined)
      setDetailsAnchor(null)
      setProfile(null)
      if (primaryDeviceId && deviceId !== primaryDeviceId && onSelectLocation) {
        onSelectLocation(primaryDeviceId)
      }
    })
  const openMemory = useStableEvent(() => leavePanel(() => openProfile('memory')))
  const [delegationPanelScope, setDelegationPanelScope] = useState<string | null>(null)
  const detailsScope = JSON.stringify([
    props.userId,
    deviceId,
    conversationRole,
    conversationScope,
    active,
  ])
  const delegationPanelOpen = delegationPanelScope === detailsScope
  const detailsAnchor = detailsTarget?.scope === detailsScope ? detailsTarget.anchor : null
  const rolesById = new Map(state.draft?.roles.map(role => [role.id, role]))
  const retiredRoles = new Set(account?.retiredRoleIds)
  const roles = [
    ...(roleLocations?.map(entry => {
      const role = rolesById.get(entry.role.id)
      rolesById.delete(entry.role.id)
      return role ? { ...entry.role, name: role.name, prompt: role.prompt } : entry.role
    }) ?? []),
    ...rolesById.values(),
  ]
  const role =
    roleLocations?.find(entry => entry.role.id === roleId && entry.deviceId === deviceId)?.role ??
    state.draft?.roles.find(value => value.id === roleId)
  const visibleInbox = inbox.items.filter(work => work.messageCount > 0 || work.task)
  const items = mergeStandInWorkItems(taskReminderItems, inbox.items, deviceId, props.projects)
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
  const conversationTaskId = standInConversationTaskId(props.userId, roleId)
  const roleItems = items.filter(item => {
    if (roleId && standInWorkRole(item) !== roleId) return false
    const origin = item.task.runtimeHandle?.origin as
      | { roleDelegation?: { ancestors?: string[] } }
      | undefined
    return origin?.roleDelegation?.ancestors?.[0] !== conversationTaskId
  })
  const chooseRole = (id?: string, executionDevice?: string) =>
    leavePanel(() => {
      onWorkspaceViewChange('conversation')
      setSelectedTeam(null)
      setSelectedShare(null)
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
  const viewedProposalId = typeof review === 'object' ? review?.proposalId : undefined
  const closeReview = () => {
    setReview(null)
    detailsTrigger.current?.focus()
  }
  const openProposal = (proposalId: string) => {
    setDetailsAnchor(null)
    setReview({ proposalId })
  }
  const proposalFailureMessage =
    (proposalSaveError?.id === currentProposal?.id ? proposalSaveError?.message : null) ||
    proposalError
  const overviewError =
    (profile === 'primary' ? null : state.error) || proposalFailureMessage || inbox.error
  const visibleProfileError = !state.saved ? state.error : undefined
  const visibleOverviewError = detailsAnchor ? overviewError : undefined
  const visibleProposalError =
    state.saved && !team && !shared && !viewedProposalId ? proposalFailureMessage : undefined
  const showDirectoryError =
    directoryError &&
    directoryError !== visibleProfileError &&
    directoryError !== visibleOverviewError &&
    directoryError !== visibleProposalError
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
  const device = findWorkbenchDevice(props.devices, deviceId) ?? undefined
  const messageCenterApi = useMemo(
    () => api && createDingTalkMessageCenterApi(api, { deviceName: device?.name }),
    [api, device?.name]
  )
  const processingFailure = standInProcessingFailure(
    processing.status,
    processing.error,
    props.userId,
    t
  )
  const processingError =
    processingFailure.summary ??
    processingFailure.message ??
    (processing.status?.awaitingUser ? t('standIn.processing.needs_input') : null)
  const shortcuts: StandInSettingsShortcut[] = []
  if (active && deviceId && (profile === 'primary' || profile === 'role')) {
    shortcuts.push({
      id: 'im',
      testId: 'stand-in-im-channels-toggle',
      containerTestId: 'stand-in-im-channels',
      label: t('standIn.im.title'),
      description: t('standIn.im.settings_help'),
      content: (
        <StandInImConnections
          services={props.services}
          devices={props.devices}
          deviceId={deviceId}
          roleId={profile === 'role' ? roleId : undefined}
          name={
            profile === 'role' && role
              ? standInRoleName(
                  role,
                  Math.max(0, roles.indexOf(role)),
                  t('standIn.personal.unnamed_assistant')
                )
              : t('standIn.personal.default_role')
          }
          onOpenChange={setImDialogOpen}
        />
      ),
    })
  }
  if (api && saved) {
    shortcuts.push({
      id: 'memory',
      testId: 'stand-in-memory-open',
      label: t('standIn.memory.title'),
      description: t('standIn.memory.settings_help'),
      onClick: openMemory,
    })
    const savedRole = roleId ? saved.roles.find(item => item.id === roleId) : undefined
    if (!roleId || savedRole) {
      const reportDeviceId = savedRole?.executionDeviceId || saved.executionDeviceId
      shortcuts.push({
        id: 'revision',
        testId: 'stand-in-ghost-revision-open',
        label: t('standIn.workspace.learning_report.title'),
        content: (
          <StandInGhostRevisionPanel
            key={JSON.stringify([saved.userId, reportDeviceId, saved.version, roleId])}
            api={api}
            userId={saved.userId}
            deviceId={reportDeviceId}
            roleId={roleId}
            identityName={
              savedRole
                ? standInRoleName(
                    savedRole,
                    saved.roles.indexOf(savedRole),
                    t('standIn.personal.unnamed_assistant')
                  )
                : t('standIn.personal.default_role')
            }
            requestLeave={leavePanel}
            pendingProposal={
              deviceId === reportDeviceId && currentProposal?.id.startsWith('ghost:')
                ? {
                    id: currentProposal.id,
                    open: () =>
                      leavePanel(() => {
                        setProfile(null)
                        openProposal(currentProposal.id)
                      }),
                  }
                : undefined
            }
          />
        ),
      })
    }
  }
  const renderDetails =
    detailsAnchor && active
      ? (activeBranches: ReturnType<typeof activeStandInBranchRows>) => (
          <StandInDetailsPopover
            key={`${props.userId}:${deviceId}:${roleId ?? '@primary'}`}
            anchor={detailsAnchor}
            name={
              role
                ? standInRoleName(
                    role,
                    Math.max(0, roles.indexOf(role)),
                    t('standIn.personal.unnamed_assistant')
                  )
                : t('standIn.personal.default_role')
            }
            enabled={role ? role.enabled : saved?.primary?.enabled !== false}
            device={props.devices.find(item => item.device_id === conversationDevice) ?? device}
            items={roleItems.filter(
              item =>
                !(item.task.runtimeHandle?.origin as Record<string, unknown> | undefined)
                  ?.inboxStatus
            )}
            activeDelegations={activeBranches}
            inbox={visibleInbox}
            sourceErrors={inbox.sourceErrors}
            overviewError={overviewError}
            processingError={processingError}
            onClose={() => {
              setDetailsAnchor(null)
              detailsAnchor.focus()
            }}
            onSettings={() => {
              setDetailsAnchor(null)
              setCalendarRequest(0)
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
              currentProposal && state.saved ? () => openProposal(currentProposal.id) : undefined
            }
            onOpenTask={onOpenTask}
          />
        )
      : undefined
  const conversationAvailable = api && deviceId && (state.saved || (!state.loading && !state.error))
  const content = (resumeSetup?: ReactNode) => (
    <section
      className="relative flex h-full min-h-0 min-w-0 bg-background text-base text-text-primary"
      data-testid="stand-in-overview"
    >
      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-start gap-2 border-b border-border px-5 py-2">
          <StandInNavigation
            conversationName={shared ? `${shared.name} · ${shared.owner_name}` : team?.name}
            messageCenter={
              api ? { onOpen: openMessageCenter, selected: showingMessageCenter } : undefined
            }
            roles={roles}
            projects={props.projects}
            roleId={roleId}
            deviceId={deviceId}
            retiredRoles={retiredRoles}
            matchDevice={!!roleLocations}
            chooseRole={chooseRole}
            onCreate={trigger =>
              leavePanel(() => {
                setCalendarRequest(0)
                openProfile('create', trigger)
              })
            }
          />
          {api && saved && (
            <StandInTeamAndShareControls
              key={teamOwner}
              active={active}
              api={api}
              settings={saved}
              roles={roles}
              selected={team}
              beforeOpen={openAssistantDialog}
              onOpenTeam={openTeam}
              onOpenShare={entry => {
                onWorkspaceViewChange('conversation')
                setSelectedTeam(null)
                setSelectedShare({ owner: teamOwner, entry })
              }}
            />
          )}
          {!shared && !showingMessageCenter && api && deviceId && saved && (
            <Tooltip label={t('standIn.delegation.panel')} side="bottom" align="end">
              <ControlButton
                variant="unstyled"
                type="button"
                data-testid="stand-in-delegation-panel-toggle"
                aria-label={t('standIn.delegation.title')}
                aria-expanded={delegationPanelOpen}
                aria-controls={delegationPanelOpen ? 'stand-in-delegation-panel' : undefined}
                onClick={() => setDelegationPanelScope(delegationPanelOpen ? null : detailsScope)}
                className={`flex h-11 shrink-0 items-center justify-center gap-1 rounded-md hover:bg-muted md:h-8 ${team ? 'px-2' : 'w-11 md:w-8'} ${delegationPanelOpen ? 'bg-muted' : ''}`}
              >
                <PanelRight aria-hidden="true" className="size-4" />
                {team && t('standIn.delegation.title')}
              </ControlButton>
            </Tooltip>
          )}
          {!team && !shared && !showingMessageCenter && (
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
          )}
          {!team && !shared && !showingMessageCenter && (
            <p data-testid="stand-in-role-help" className="w-full text-sm text-text-secondary">
              {t('standIn.workspace.role_help')}
            </p>
          )}
        </header>
        {showDirectoryError && (
          <p role="alert" className="px-5 py-2 text-sm text-error">
            {directoryError}
          </p>
        )}
        {(showingMessageCenter || (!roleId && !team && !shared)) && resumeSetup}
        {showingMessageCenter ? (
          <StandInMessageCenterHost
            api={messageCenterApi}
            scope={
              deviceId && deviceId === state.currentDeviceId
                ? { userId: props.userId, deviceId }
                : null
            }
            onOpenSettings={(source, trigger) => openMessageCenterSettings(source, trigger)}
            settingsTriggerRef={messageCenterSettingsTrigger}
            onOpenComponents={() => navigateTo('/settings/connections')}
          />
        ) : state.loading && !state.saved ? (
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
            {deviceId === primaryDeviceId && headerActions}
          </div>
        ) : (
          <>
            {api && conversationDevice && (team || shared || roleId || !resumeSetup) ? (
              <StandInConversation
                delegationPanelOpen={delegationPanelOpen}
                sidebarTasks={
                  team || shared
                    ? undefined
                    : {
                        items: roleItems,
                        inbox: visibleInbox,
                        onAllActivity: () => setReview('work'),
                      }
                }
                renderDetails={team || shared ? undefined : renderDetails}
                contentFooter={
                  !team && !shared && !viewedProposalId && (proposalCard || proposalFailure) ? (
                    <>
                      {proposalCard}
                      {proposalFailure}
                    </>
                  ) : null
                }
                draftRequest={!team && !shared && !roleId ? exampleDraft : undefined}
                onDraftRequestConsumed={id =>
                  setExampleDraft(current => (current?.id === id ? undefined : current))
                }
                active={active}
                key={JSON.stringify([
                  conversationDevice,
                  standInConversationTaskId(conversationUser, conversationRole, conversationScope),
                ])}
                api={api}
                userId={conversationUser}
                deviceId={conversationDevice}
                roleId={conversationRole}
                scope={conversationScope}
                definition={
                  conversationScope
                    ? undefined
                    : account?.definitions.find(item => item.roleId === (roleId ?? '@primary'))
                }
                settings={
                  conversationDevice !== deviceId
                    ? undefined
                    : conversationRole
                      ? saved?.roles.find(role => role.id === conversationRole)
                      : saved?.primary
                }
                services={props.services}
                onOpenTask={onOpenTask}
              />
            ) : null}
          </>
        )}
        {!conversationAvailable && renderDetails?.([])}
        <StandInReviewDialog
          open={active && review === 'work'}
          title={t('standIn.workspace.details_activity')}
          testId="stand-in-work-dialog"
          onClose={closeReview}
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
          open={active && !!viewedProposalId}
          title={t('standIn.workspace.pending_configuration')}
          testId="stand-in-proposal-dialog"
          busy={resolving}
          onClose={closeReview}
        >
          {currentProposal?.id === viewedProposalId && saved ? (
            <>
              {proposalCard}
              {proposalFailure}
            </>
          ) : (
            <p role="status" className="text-sm text-text-secondary">
              {t('standIn.workspace.proposal_no_longer_pending')}
            </p>
          )}
        </StandInReviewDialog>
        <StandInReviewDialog
          open={active && review === 'status'}
          title={t('standIn.workspace.status_details')}
          testId="stand-in-status-dialog"
          onClose={closeReview}
        >
          {deviceId && processingError && (
            <StandInProcessingNotice
              snapshot={processing}
              api={api}
              userId={props.userId}
              deviceId={deviceId}
              onOpen={() => {
                setReview(null)
                openProfile('primary')
              }}
              onOpenConnectionSettings={() => {
                setReview(null)
                navigateTo('/settings/connections')
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
          {device?.error && (
            <p role="alert" className="mb-4 text-sm text-error">
              {getStandInErrorMessage(device.error)}
            </p>
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
                  <p
                    role={value.error.code === 'dingtalk_delegation_gap' ? 'status' : 'alert'}
                    className="mt-1 text-sm text-text-secondary"
                  >
                    {getStandInErrorMessage(value.error)}
                  </p>
                </div>
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid={`stand-in-source-${value.error.code === 'dingtalk_delegation_gap' ? 'acknowledge' : 'retry'}-${value.source.id}`}
                  className="min-h-11 shrink-0 rounded-md px-3 text-sm hover:bg-muted md:min-h-8"
                  aria-busy={
                    sameOwner && view.retryingSources.has(standInOverviewSourceKey(value.source))
                  }
                  onClick={() => void overview.retrySource(value.source)}
                >
                  {value.error.code === 'dingtalk_delegation_gap'
                    ? t('standIn.dingtalk_delegation.dismiss_gap')
                    : t('standIn.reload')}
                </ControlButton>
              </div>
            ))}
          </div>
          {!inbox.sourceErrors.length && !overviewError && !processingError && !device?.error && (
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
                suspended={imDialogOpen}
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
                    reviewRoleId={roleId ?? '@primary'}
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
                    shortcuts={shortcuts}
                    footerLeading={
                      <>
                        {(!primaryDeviceId || deviceId === primaryDeviceId) && headerActions}
                        {primarySettingsActions}
                      </>
                    }
                    key={`${state.draft.executionDeviceId}:${calendarRequest}`}
                    initialCalendar={calendarRequest > 0}
                    initialConnections={view.openConnectionSettings}
                    settings={state.draft}
                    saving={state.saving || bindingPending}
                    loading={state.loading}
                    services={props.services}
                    devices={props.devices}
                    executionDeviceId={conversationDevice}
                    deviceReadOnly={!!primaryDeviceId && !(definition && onBindDevice)}
                    onSelectDevice={async device => {
                      if (definition && onBindDevice) {
                        setBindingPending(true)
                        setBindingError('')
                        try {
                          await onBindDevice(definition.roleId, device)
                        } catch (error) {
                          setBindingError(getStandInErrorMessage(error))
                        } finally {
                          setBindingPending(false)
                        }
                        return
                      }
                      if (onSelectLocation) onSelectLocation(device, '@primary', true)
                      else state.setDeviceId(device)
                    }}
                    onClose={() => {
                      setProfile(null)
                      if (initialPrimaryProfile) props.onCancel?.()
                    }}
                    onSave={async (value, stayOpen) => {
                      const saved = await state.save(value)
                      if (saved && !stayOpen) {
                        setProfile(null)
                        if (initialPrimaryProfile) props.onCancel?.()
                      }
                      return saved ?? undefined
                    }}
                    error={bindingError || state.error}
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
                    shortcuts={shortcuts}
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
        localDeviceId: localDeviceId ?? state.currentDeviceId,
        devices: props.devices,
        services: props.services,
        executionDeviceId: onSelectAssistantDevice ? deviceId : undefined,
        onSelectDevice: primaryDeviceId
          ? onSelectAssistantDevice
          : device => {
              if (onSelectLocation) onSelectLocation(device)
              else state.setDeviceId(device)
            },
        onSave: state.save,
        onReload: state.reload,
      }}
      guideOpen={guideOpen}
      onGuideClose={() => setGuideOpen(false)}
      onOpenConversation={() => onWorkspaceViewChange('conversation')}
      onExampleSelect={text =>
        leavePanel(() => {
          onWorkspaceViewChange('conversation')
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
    content()
  )
}
