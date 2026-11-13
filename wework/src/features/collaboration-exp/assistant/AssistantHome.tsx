import { useState } from 'react'
import { ArrowUpRight, CircleHelp, LoaderCircle } from 'lucide-react'
import { issueNeedsUser, pendingIssueHumanRequests } from '@wegent/collaboration'
import type { StandInRole } from '@/api/personalStandIn'
import type { RuntimeTaskAddress } from '@/types/api'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { StandInProposalCard } from '@/features/todo/StandInProposalCard'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import {
  selectAssistantSummary,
  selectTaskRows,
  type ExperiencePrivateConversation,
} from '../model'
import { AssistantComposer } from './AssistantComposer'
import { AssistantTeam } from './AssistantTeam'
import { RecentDiscussions } from './RecentDiscussions'
import { useExperienceTeamState } from './useExperienceTeamState'
import { TeamRelay } from './TeamRelay'
import { AssistantWorkSnapshot } from './AssistantWorkSnapshot'
import { selectAssistantConversations } from './assistantConversationIdentity'
import type { AssistantHomeProps } from './types'

export function AssistantHome({
  active,
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
  const [teamOpen, setTeamOpen] = useState(false)
  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(null)
  const [resolving, setResolving] = useState(false)
  const [error, setError] = useState<string | null>(null)
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
      await services.standInApi.personalSave(
        ownerId,
        { ...source.settings, roles: source.settings.roles.filter(item => item.id !== role.id) },
        source.deviceId
      )
      source.refresh()
      setError(null)
      return true
    } catch (cause) {
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
      className="experience-assistant-home flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
      data-testid="collaboration-exp-assistant-home"
    >
      <div
        className="scrollbar-soft min-h-0 flex-1 overflow-x-hidden overflow-y-auto pb-4"
        data-testid="collaboration-exp-assistant-summary"
      >
        <p className="experience-assistant-introduction px-4 pt-4 text-sm text-text-secondary">
          {t('assistant.introduction')}
        </p>
        <TeamRelay
          nodes={snapshot.team}
          ready={ready}
          managementAvailable={Boolean(active && source.settings && source.deviceId)}
          onManage={() => setTeamOpen(value => !value)}
          manageTestId="collaboration-exp-assistant-team-toggle"
          expanded={teamOpen}
        />
        {(source.settings || work.length > 0) && (
          <AssistantWorkSnapshot
            snapshot={snapshot}
            ready={ready}
            onOpen={item => {
              if (item.address) openWork(item.address, item.title)
            }}
          />
        )}
        {source.loading && (
          <p role="status" className="px-4 py-3 text-sm text-text-muted">
            {t('assistant.loading')}
          </p>
        )}
        {(sourceError || error) && (
          <div role="alert" className="px-4 py-3 text-sm text-error">
            {error ?? sourceError}
            <button
              type="button"
              data-testid="collaboration-exp-assistant-retry"
              onClick={() => {
                setError(null)
                refresh()
              }}
              className="ml-2 min-h-11 underline md:min-h-8"
            >
              {t('assistant.retry')}
            </button>
          </div>
        )}
        {teamOpen && active && source.settings && (
          <AssistantTeam
            settings={source.settings}
            projects={projects}
            onConfigure={configure}
            onDelete={deleteRole}
          />
        )}
        <section data-testid="collaboration-exp-assistant-decisions" className="py-2">
          <h2 className="px-4 py-2 text-sm font-medium text-text-secondary">
            {t('assistant.needsDecision')}
          </h2>
          {summary.pendingDecisions.map(decision => (
            <button
              type="button"
              key={decision.id}
              data-testid={`collaboration-exp-assistant-proposal-${decision.id}`}
              onClick={() => {
                const proposal = source.proposals?.find(proposal => proposal.id === decision.id)
                if (proposal && proposal.settings.executionDeviceId !== source.deviceId)
                  configure(proposal.roleId ?? undefined, proposal.settings.executionDeviceId)
                else setSelectedProposalId(decision.id)
              }}
              className="experience-assistant-decision"
              data-state="waiting"
            >
              <CircleHelp
                aria-hidden="true"
                className="experience-assistant-decision-icon size-4 shrink-0"
              />
              <span className="min-w-0 flex-1">
                <span className="experience-assistant-decision-title block break-words">
                  {decision.summary}
                </span>
                <span className="mt-1 block text-xs text-text-muted">
                  {t('assistant.reviewProposal')}
                </span>
              </span>
              <ArrowUpRight aria-hidden="true" className="size-4 shrink-0 text-text-muted" />
            </button>
          ))}
          {pendingTasks.map(task => {
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
              <button
                type="button"
                key={task.key}
                data-testid={`collaboration-exp-assistant-pending-${task.key}`}
                onClick={() => onOpenIssue?.(task.project, task.id)}
                disabled={!onOpenIssue}
                className="experience-assistant-decision"
                data-state="waiting"
              >
                <CircleHelp
                  aria-hidden="true"
                  className="experience-assistant-decision-icon size-4 shrink-0"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{task.title}</span>
                  {question && (
                    <span className="experience-assistant-decision-title mt-1 block text-sm text-text-secondary">
                      {question}
                    </span>
                  )}
                  <span className="mt-1 block text-xs text-text-muted">
                    {task.project.name} · {t('assistant.openTask')}
                  </span>
                </span>
                <ArrowUpRight aria-hidden="true" className="size-4 shrink-0 text-text-muted" />
              </button>
            )
          })}
          {!summary.pendingDecisions.length && !pendingTasks.length && source.proposalsReady && (
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
        <RecentDiscussions conversations={summary.recentDiscussions} onOpen={openConversation} />
        <section data-testid="collaboration-exp-assistant-progress" className="py-2">
          <h2 className="px-4 py-2 text-sm font-medium text-text-secondary">
            {t('assistant.recentProgress')}
          </h2>
          {work.slice(0, 6).map(item => {
            const status =
              snapshot.items.find(
                row => row.key === JSON.stringify([item.address.deviceId, item.address.taskId])
              )?.state ?? 'unknown'
            return (
              <button
                type="button"
                key={item.key}
                data-testid={`collaboration-exp-assistant-work-${item.task.taskId}`}
                className="flex min-h-11 w-full items-center gap-3 px-4 py-3 text-left hover:bg-text-primary/[0.025]"
                onClick={() => openWork(item.address, item.task.title)}
              >
                {status === 'running' ? (
                  <LoaderCircle
                    aria-hidden="true"
                    className="size-4 shrink-0 motion-safe:animate-spin"
                  />
                ) : (
                  <ArrowUpRight aria-hidden="true" className="size-4 shrink-0 text-text-muted" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{item.task.title}</span>
                  <span className="mt-1 block text-xs text-text-muted">
                    {t(`assistant.status.${status}`)}
                    {item.projectName ? ` · ${item.projectName}` : ''}
                  </span>
                </span>
              </button>
            )
          })}
          {!work.length && source.inboxReady && (
            <p className="px-4 py-3 text-sm text-text-muted">{t('assistant.noProgress')}</p>
          )}
        </section>
      </div>
      <div
        className="shrink-0 border-t border-border px-4 pb-3 pt-3"
        data-testid="collaboration-exp-assistant-composer"
      >
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
