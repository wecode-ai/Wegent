import { standInPolicy, type StandInRole } from '@/api/personalStandIn'
import { formatNotificationTime } from '@/features/notifications/notificationTime'
import { StandInProposalCard } from '@/features/todo/StandInProposalCard'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import type { RuntimeTaskAddress } from '@/types/api'
import { issueNeedsUser, pendingIssueHumanRequests } from '@wegent/collaboration'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { ArrowRight, Check, Circle, CircleHelp, LoaderCircle } from 'lucide-react'
import { useState } from 'react'
import {
  selectAssistantDecisions,
  selectAssistantSummary,
  selectTaskRows,
  type ExperiencePrivateConversation,
} from '../model'
import { AssistantComposer } from './AssistantComposer'
import './AssistantExperience.css'
import { AssistantTeam } from './AssistantTeam'
import { AssistantWorkSnapshot } from './AssistantWorkSnapshot'
import { RecentDiscussions } from './RecentDiscussions'
import { TeamRelay } from './TeamRelay'
import { selectAssistantConversations } from './assistantConversationIdentity'
import { experienceAssistantEndpoint } from '../model/assistantEndpoint'
import type { AssistantHomePanel, AssistantHomeProps } from './types'
import { useExperienceTeamState } from './useExperienceTeamState'

export function AssistantHome({
  active,
  panel,
  onPanelChange,
  projects = [],
  conversations = [],
  onOpenIssue,
  onOpenConversation,
}: AssistantHomeProps) {
  const { t } = useTranslation('collaborationExp')
  const { services, state, openRuntimeTask } = useWorkbench()
  const {
    source,
    ownerId,
    work,
    snapshot,
    ready,
    error: sourceError,
    refresh,
  } = useExperienceTeamState(active, projects)
  const [localPanel, setLocalPanel] = useState<AssistantHomePanel>(null)
  const currentPanel = panel === undefined ? localPanel : panel
  const setPanel = (next: AssistantHomePanel) => {
    setLocalPanel(next)
    onPanelChange?.(next)
  }
  const teamOpen = currentPanel === 'team'
  const [allDecisions, setAllDecisions] = useState(false)
  const [allProgress, setAllProgress] = useState(false)
  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(null)
  const [resolving, setResolving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const progressReady =
    state.runtimeWork != null &&
    (state.runtimeWorkLoad.phase === 'ready' || state.runtimeWorkLoad.phase === 'refreshing') &&
    source.inboxReady &&
    !source.inbox.error &&
    source.inbox.sourceErrors.length === 0
  const discussions = new Map(
    conversations.map(conversation => [
      JSON.stringify([conversation.address.deviceId, conversation.address.taskId]),
      conversation,
    ])
  )
  for (const conversation of selectAssistantConversations({
    ownerUserId: ownerId,
    inboxDeviceId: source.deviceId,
    inbox: source.inbox.items,
    runtimeWork: state.runtimeWork,
  })) {
    const key = JSON.stringify([conversation.address.deviceId, conversation.address.taskId])
    if (!discussions.has(key)) discussions.set(key, conversation)
  }
  const summary = selectAssistantSummary({
    viewer: [source.userId, ownerId],
    settings: source.settings,
    proposals: source.proposals,
    inbox: source.inbox.items,
    conversations: [...discussions.values()].sort(
      (a, b) => (Date.parse(b.linkedAt ?? '') || 0) - (Date.parse(a.linkedAt ?? '') || 0)
    ),
  })
  const pendingTasks = selectTaskRows({ projects, viewer: [source.userId, ownerId] }).filter(
    row => row.needsUser
  )
  const decisions = selectAssistantDecisions({
    proposals: summary.pendingDecisions,
    tasks: pendingTasks,
    items: snapshot.items,
    work,
  })
  const homeSnapshot = {
    ...snapshot,
    counts: { ...snapshot.counts, waiting: decisions.length },
  }
  const selectedProposal = source.proposals?.find(
    proposal => proposal.id === selectedProposalId && proposal.settings.userId === ownerId
  )
  const openConversation = (conversation: ExperiencePrivateConversation) => {
    if (onOpenConversation) onOpenConversation(conversation)
    else void openRuntimeTask(conversation.address)
  }
  const openCreatedConversation = (address: RuntimeTaskAddress, title: string) => {
    const key = JSON.stringify([address.deviceId, address.taskId])
    openConversation(
      discussions.get(key) ?? {
        key,
        bindingIds: [],
        sourceNodeIds: [],
        ownerUserId: ownerId,
        address,
        title,
        linkedAt: null,
      }
    )
  }
  const openWork = (address: RuntimeTaskAddress, title: string) => {
    const item = work.find(
      item => item.address.deviceId === address.deviceId && item.address.taskId === address.taskId
    )
    const origin = item?.task.runtimeHandle?.origin as Record<string, unknown> | undefined
    if (
      item &&
      (origin?.type === 'issue_dispatch' ||
        origin?.publicConversation === true ||
        origin?.cloudProjectId ||
        origin?.loopItemId)
    ) {
      void openRuntimeTask(item.address)
      return
    }
    openCreatedConversation(address, title)
  }
  const configure = (roleId?: string, deviceId?: string) => {
    const query = new URLSearchParams({
      profileId: roleId ?? '@primary',
      deviceId:
        deviceId ??
        source.settings?.roles.find(role => role.id === roleId)?.executionDeviceId ??
        source.deviceId ??
        '',
      userId: String(ownerId),
      settingsRequest: String(Date.now()),
    })
    navigateTo(`/stand-in?${query}`)
  }
  const registerAssistant = async (
    roleId: string | undefined,
    roleName: string,
    project: { id: string; store: 'cloud' },
    policy: ReturnType<typeof standInPolicy>
  ) => {
    const shared = services.sharedWorkspaceApi
    if (!shared?.projects.saveAssistantRosterEntry) return false
    const configuredRole = source.settings?.roles.find(role => role.id === roleId)
    const endpoint = experienceAssistantEndpoint(
      state.devices,
      configuredRole?.executionDeviceId ?? source.settings?.executionDeviceId ?? source.deviceId,
      {
        ownerUserId: ownerId,
        roleId: roleId ?? '@primary',
        displayName: roleName,
        capabilities: { attachments: true, cancel: true, trace: true },
      }
    )
    if (!endpoint) {
      setError(t('assistant.deviceUnavailable'))
      return false
    }
    try {
      const current = shared.projects.listAssistantRoster
        ? await shared.projects.listAssistantRoster(project.id)
        : []
      const stale = current.filter(
        entry =>
          entry.userId === ownerId &&
          entry.roleId === (roleId ?? '@primary') &&
          entry.endpointRef !== endpoint.id &&
          entry.enabled
      )
      for (const entry of stale) {
        await shared.projects.saveAssistantRosterEntry(project.id, {
          userId: entry.userId,
          roleId: entry.roleId,
          endpointRef: entry.endpointRef,
          displayName: entry.displayName,
          enabled: false,
          capabilityTags: entry.capabilityTags,
          autonomyPolicy: entry.autonomyPolicy,
          availability: entry.availability,
          version: entry.version,
        })
      }
      const saved = current.find(entry => entry.endpointRef === endpoint.id)
      await shared.projects.saveAssistantRosterEntry(project.id, {
        userId: ownerId,
        roleId: roleId ?? '@primary',
        endpointRef: endpoint.id,
        displayName: roleName,
        enabled: true,
        capabilityTags: configuredRole?.collaboration.tags ?? [],
        autonomyPolicy: policy as unknown as Record<string, unknown>,
        availability: endpoint.availability,
        ...(saved ? { version: saved.version } : {}),
      })
      setError(null)
      return true
    } catch (cause) {
      setError(getStandInErrorMessage(cause))
      return false
    }
  }
  const deleteRole = async (role: StandInRole) => {
    if (
      !source.settings ||
      !active ||
      !source.deviceId ||
      !services.standInApi ||
      !source.settings.roles.some(item => item.id === role.id)
    )
      return false
    try {
      const shared = services.sharedWorkspaceApi
      const entries = (
        await Promise.all(
          projects
            .filter(({ project }) => project.project_store !== 'local')
            .map(async ({ project }) => {
              if (!shared?.projects.listAssistantRoster) return []
              return (await shared.projects.listAssistantRoster(project.id)).filter(
                candidate => candidate.userId === ownerId && candidate.roleId === role.id
              )
            })
        )
      ).flat()
      const disability = await Promise.allSettled(
        entries.map(async entry => {
          if (!shared?.projects.saveAssistantRosterEntry)
            throw new Error('Assistant roster update is unavailable')
          await shared.projects.saveAssistantRosterEntry(entry.projectId, {
            userId: entry.userId,
            roleId: entry.roleId,
            endpointRef: entry.endpointRef,
            displayName: entry.displayName,
            enabled: false,
            capabilityTags: entry.capabilityTags,
            autonomyPolicy: entry.autonomyPolicy,
            availability: entry.availability,
            version: entry.version,
          })
        })
      )
      const failed = disability.find(result => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
      await services.standInApi.personalSave(
        ownerId,
        { ...source.settings, roles: source.settings.roles.filter(item => item.id !== role.id) },
        source.deviceId
      )
      source.refresh()
      setError(null)
      return true
    } catch (cause) {
      source.refresh()
      setError(getStandInErrorMessage(cause))
      return false
    }
  }

  const resolveProposal = async (accept: boolean) => {
    if (
      !selectedProposal ||
      !active ||
      !source.settings ||
      !services.standInApi ||
      !source.deviceId ||
      resolving
    )
      return
    if (
      accept &&
      (selectedProposal.settings.primary?.enabled === false ||
        (source.settings.primary && !selectedProposal.settings.primary))
    ) {
      setError(t('assistant.defaultProtected'))
      return
    }
    setResolving(true)
    try {
      await services.standInApi.resolveProposal(
        ownerId,
        source.deviceId,
        selectedProposal.id,
        accept
      )
      setSelectedProposalId(null)
      source.refresh()
      setError(null)
    } catch (cause) {
      setError(getStandInErrorMessage(cause))
    } finally {
      setResolving(false)
    }
  }

  return (
    <div
      className="experience-assistant-home assistant-home"
      data-testid="collaboration-exp-assistant-home"
    >
      <div
        className="assistant-dashboard-scroll scrollbar-soft"
        data-testid="collaboration-exp-assistant-summary"
      >
        <div className="assistant-dashboard-body">
          <section
            className="assistant-dashboard-intro"
            data-live={ready && snapshot.counts.running > 0}
          >
            <div className="assistant-dashboard-copy">
              <span className="private-eyebrow text-xs">{t('assistant.eyebrow')}</span>
              <h2 className="heading-lg">{t('assistant.headline')}</h2>
              <p className="text-sm">
                {ready
                  ? t('assistant.liveSummary', { ...homeSnapshot.counts })
                  : t('assistant.introduction')}
              </p>
            </div>
            {(source.settings || work.length > 0) && (
              <AssistantWorkSnapshot
                snapshot={homeSnapshot}
                ready={ready}
                onOpen={item => {
                  if (item.address) openWork(item.address, item.title)
                }}
              />
            )}
          </section>
          {currentPanel === 'recent' && (
            <div className="assistant-recent-panel">
              <RecentDiscussions
                conversations={summary.recentDiscussions}
                onOpen={openConversation}
              />
            </div>
          )}
          <TeamRelay
            nodes={snapshot.team}
            announceCounts={false}
            ready={ready}
            managementAvailable={Boolean(active && source.settings && source.deviceId)}
            onManage={() => setPanel(teamOpen ? null : 'team')}
            manageTestId="collaboration-exp-assistant-team-toggle"
            expanded={teamOpen}
          />
          {source.loading && (
            <p role="status" className="px-4 py-3 text-sm text-text-muted">
              {t('assistant.loading')}
            </p>
          )}
          {(sourceError || error) && (
            <div role="alert" className="px-4 py-3 text-sm text-error">
              {error ?? sourceError}
              <ControlButton
                variant="unstyled"
                type="button"
                data-testid="collaboration-exp-assistant-retry"
                onClick={() => {
                  setError(null)
                  refresh()
                }}
                className="ml-2 min-h-11 underline md:min-h-8"
              >
                {t('assistant.retry')}
              </ControlButton>
            </div>
          )}
          {teamOpen && active && source.settings && (
            <AssistantTeam
              settings={source.settings}
              projects={projects}
              onConfigure={configure}
              onDelete={deleteRole}
              onRegister={registerAssistant}
            />
          )}
          <section
            data-testid="collaboration-exp-assistant-decisions"
            className="assistant-dashboard-section assistant-decision-section"
          >
            <div className="assistant-section-heading">
              <h3 className="text-sm font-semibold">
                {t('assistant.needsDecision')}
                <span>{decisions.length}</span>
              </h3>
              {decisions.length > 2 && (
                <ControlButton
                  variant="unstyled"
                  type="button"
                  className="assistant-text-button text-xs"
                  data-testid="collaboration-exp-assistant-all-decisions"
                  aria-expanded={allDecisions}
                  onClick={() => setAllDecisions(!allDecisions)}
                >
                  {t(allDecisions ? 'assistant.showLess' : 'assistant.allDecisions')}
                  <ArrowRight size={14} aria-hidden="true" />
                </ControlButton>
              )}
            </div>
            <div className="assistant-decision-grid">
              {decisions.slice(0, allDecisions ? undefined : 2).map(entry => {
                if (entry.kind === 'proposal') {
                  const decision = entry.proposal
                  return (
                    <ControlButton
                      variant="unstyled"
                      type="button"
                      key={decision.id}
                      data-testid={`collaboration-exp-assistant-proposal-${decision.id}`}
                      onClick={() => {
                        const proposal = source.proposals?.find(
                          proposal => proposal.id === decision.id
                        )
                        if (proposal && proposal.settings.executionDeviceId !== source.deviceId)
                          configure(
                            proposal.roleId ?? undefined,
                            proposal.settings.executionDeviceId
                          )
                        else setSelectedProposalId(decision.id)
                      }}
                      className="experience-assistant-decision assistant-decision-card"
                      data-state="waiting"
                    >
                      <span className="assistant-decision-kicker text-xs">
                        <CircleHelp aria-hidden="true" className="size-4 shrink-0" />
                        <span>{t('assistant.reviewProposal')}</span>
                      </span>
                      <strong className="text-lg">{decision.summary}</strong>
                      <span className="assistant-decision-footer text-xs">
                        <small>{t('assistant.reviewProposal')}</small>
                        <span className="assistant-action-arrow">
                          <ArrowRight size={15} aria-hidden="true" />
                        </span>
                      </span>
                    </ControlButton>
                  )
                }
                if (entry.kind === 'work') {
                  const item = entry.item
                  return (
                    <ControlButton
                      variant="unstyled"
                      type="button"
                      key={item.key}
                      data-testid={`collaboration-exp-assistant-pending-work-${item.key}`}
                      onClick={() => {
                        if (item.address) openWork(item.address, item.title)
                      }}
                      className="experience-assistant-decision assistant-decision-card"
                      data-state="waiting"
                    >
                      <span className="assistant-decision-kicker text-xs">
                        <CircleHelp aria-hidden="true" className="size-4 shrink-0" />
                        <span>{t('assistant.status.waiting')}</span>
                      </span>
                      <strong className="text-lg">{item.title}</strong>
                      <span className="assistant-decision-footer text-xs">
                        <small>{t('assistant.openTask')}</small>
                        <span className="assistant-action-arrow">
                          <ArrowRight size={15} aria-hidden="true" />
                        </span>
                      </span>
                    </ControlButton>
                  )
                }
                const task = entry.task
                const projectSource = projects.find(
                  row =>
                    row.project.id === task.project.id &&
                    row.project.project_store === task.project.store
                )
                const issue = projectSource?.issues.find(issue => issue.id === task.id)
                const question = issue
                  ? pendingIssueHumanRequests(issue).find(request =>
                      issueNeedsUser(
                        { ...issue, human_requests: [request] },
                        projectSource?.project.current_user_id ?? [source.userId, ownerId]
                      )
                    )?.question
                  : null
                return (
                  <ControlButton
                    variant="unstyled"
                    type="button"
                    key={task.key}
                    data-testid={`collaboration-exp-assistant-pending-${task.key}`}
                    onClick={() => onOpenIssue?.(task.project, task.id)}
                    disabled={!onOpenIssue}
                    className="experience-assistant-decision assistant-decision-card"
                    data-state="waiting"
                  >
                    <span className="assistant-decision-kicker text-xs">
                      <CircleHelp aria-hidden="true" className="size-4 shrink-0" />
                      <span>{task.title}</span>
                    </span>
                    <strong className="text-lg">{question ?? task.title}</strong>
                    <p className="text-xs">{task.project.name}</p>
                    <span className="assistant-decision-footer text-xs">
                      <small>{t('assistant.openTask')}</small>
                      <span className="assistant-action-arrow">
                        <ArrowRight size={15} aria-hidden="true" />
                      </span>
                    </span>
                  </ControlButton>
                )
              })}
            </div>
            {!decisions.length && source.proposalsReady && (
              <p className="px-4 py-3 text-sm text-text-muted">{t('assistant.noDecisions')}</p>
            )}
            {selectedProposal && source.settings && (
              <div className="px-4">
                <StandInProposalCard
                  proposal={selectedProposal}
                  current={source.settings}
                  busy={resolving}
                  projects={projects.map(row => row.project)}
                  onResolve={resolveProposal}
                />
              </div>
            )}
          </section>
          <section
            data-testid="collaboration-exp-assistant-progress"
            className="assistant-dashboard-section assistant-progress-section"
            aria-busy={active && !progressReady && !sourceError}
          >
            <div className="assistant-section-heading">
              <h3 className="text-sm font-semibold">{t('assistant.recentProgress')}</h3>
              {work.length > 6 && (
                <ControlButton
                  variant="unstyled"
                  type="button"
                  className="assistant-text-button text-xs"
                  data-testid="collaboration-exp-assistant-all-progress"
                  aria-expanded={allProgress}
                  onClick={() => setAllProgress(!allProgress)}
                >
                  {t(allProgress ? 'assistant.showLess' : 'assistant.allProgress')}
                  <ArrowRight size={14} aria-hidden="true" />
                </ControlButton>
              )}
            </div>
            <div className="assistant-recent-progress">
              {work.slice(0, allProgress ? undefined : 6).map(item => {
                const status =
                  snapshot.items.find(
                    row => row.key === JSON.stringify([item.address.deviceId, item.address.taskId])
                  )?.state ?? 'unknown'
                const StatusIcon =
                  status === 'running'
                    ? LoaderCircle
                    : status === 'completed'
                      ? Check
                      : status === 'waiting'
                        ? CircleHelp
                        : Circle
                const rawTime =
                  item.task.recencyAt ??
                  item.task.updatedAt ??
                  item.task.completedAt ??
                  item.task.createdAt
                const time = rawTime == null ? null : new Date(rawTime)
                const validTime =
                  time && Number.isFinite(time.getTime()) && time.getTime() > 0 ? time : null
                return (
                  <ControlButton
                    variant="unstyled"
                    type="button"
                    key={item.key}
                    data-testid={`collaboration-exp-assistant-work-${item.task.taskId}`}
                    data-state={status}
                    onClick={() => openWork(item.address, item.task.title)}
                  >
                    <StatusIcon
                      aria-hidden="true"
                      className={`size-4 shrink-0 text-text-muted ${status === 'running' ? 'motion-safe:animate-spin' : ''}`}
                    />
                    <span className="assistant-progress-copy">
                      <strong className="text-sm">{item.task.title}</strong>
                      <small className="text-xs">
                        {t(`assistant.status.${status}`)}
                        {item.projectName ? ` · ${item.projectName}` : ''}
                      </small>
                    </span>
                    {validTime && (
                      <time dateTime={validTime.toISOString()} title={validTime.toLocaleString()}>
                        {formatNotificationTime(validTime.getTime())}
                      </time>
                    )}
                    <span className="assistant-progress-arrow">
                      <ArrowRight size={14} aria-hidden="true" />
                    </span>
                  </ControlButton>
                )
              })}
            </div>
            {!work.length && progressReady && (
              <p className="px-4 py-3 text-sm text-text-muted">{t('assistant.noProgress')}</p>
            )}
            {active && !work.length && !progressReady && !sourceError && (
              <p role="status" className="px-4 py-3 text-sm text-text-muted">
                {t('assistant.progressLoading')}
              </p>
            )}
          </section>
        </div>
      </div>
      <div className="assistant-chat-input-dock" data-testid="collaboration-exp-assistant-composer">
        {source.settings && (
          <AssistantComposer
            active={active}
            settings={source.settings}
            onCreated={openCreatedConversation}
          />
        )}
      </div>
    </div>
  )
}

export type { AssistantHomeProps } from './types'
