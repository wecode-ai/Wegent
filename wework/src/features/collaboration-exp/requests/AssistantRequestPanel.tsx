import { useEffect, useId, useRef } from 'react'
import { ArrowUpRight, Lock, Plus } from 'lucide-react'
import type {
  AssistantExecutionRequest,
  AssistantRequestAction,
  AssistantRequestsApi,
  CollaborationIssue,
  CollaborationProject,
} from '@wegent/collaboration'
import { getCollaborationIssueActionPermissions } from '@wegent/collaboration'
import { Button } from '@/components/ui/button'
import { useCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { workbenchOwnershipKey } from '@/features/workbench/workbenchOwnership'
import { useTranslation } from '@/hooks/useTranslation'
import type { RuntimeTaskAddress } from '@/types/api'
import { useAssistantRequests } from './useAssistantRequests'
import type { LocalRequestSubmission, RequestComposer } from './assistantRequestScopeStore'

interface Props {
  api: AssistantRequestsApi
  project: CollaborationProject
  issue: CollaborationIssue
  active: boolean
  revision: number
  onExecution(address: RuntimeTaskAddress): void
  openRequest?: { id: string; key: number }
}

const activeStates = new Set(['accepted', 'queued', 'waiting_device', 'running', 'waiting_user'])

export function AssistantRequestPanel(props: Props) {
  const connection = useCloudConnection()
  const { state } = useWorkbench()
  const userId = Number(state.user?.id)
  if (
    !Number.isSafeInteger(userId) ||
    userId !== props.project.current_user_id ||
    userId !== props.issue.assignee_user_id ||
    props.issue.cloud_project_id !== props.project.id ||
    props.project.project_store !== 'backend' ||
    !getCollaborationIssueActionPermissions(props.project, props.issue).canStartWork
  )
    return null
  const accountKey = workbenchOwnershipKey(connection, state.user)
  return (
    <AssistantRequestContent
      key={JSON.stringify([accountKey, props.project.id, props.issue.id, userId])}
      {...props}
      userId={userId}
      accountKey={accountKey}
    />
  )
}

function AssistantRequestContent(props: Props & { userId: number; accountKey: string }) {
  const { t } = useTranslation('collaborationExp')
  const messageId = useId()
  const requests = useAssistantRequests({
    api: props.api,
    projectId: props.project.id,
    issueId: props.issue.id,
    userId: props.userId,
    accountKey: props.accountKey,
    active: props.active,
    revision: props.revision,
  })
  const { composer, message, start } = requests
  const list = requests.list
  const opened = useRef<Props['openRequest']>(undefined)
  const { active, openRequest, onExecution } = props
  useEffect(() => {
    if (!active || requests.failed || !openRequest || opened.current === openRequest) return
    const request = list?.requests.find(request => request.requestId === openRequest.id)
    if (!request?.deviceId || !request.runtimeTaskId) return
    opened.current = openRequest
    onExecution({ deviceId: request.deviceId, taskId: request.runtimeTaskId })
  }, [active, openRequest, onExecution, requests.failed, list])
  if (!list && !requests.failed) return null
  if (list && !list.enabled && list.requests.length === 0 && !requests.submissions.length)
    return null
  return (
    <section
      className="space-y-3 px-4 py-3 max-md:[&_button]:min-h-11 max-md:[&_button]:min-w-11"
      data-testid="assistant-requests"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <Lock size={16} aria-hidden="true" />
          {t('requests.title')}
        </h2>
        {list?.enabled ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={!props.active}
            data-testid="assistant-request-new"
            onClick={() => start({ action: 'new_request' })}
          >
            <Plus size={16} aria-hidden="true" />
            {t('requests.new')}
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-text-secondary">{t('requests.privacy')}</p>
      {requests.failed ? (
        <div role="alert" className="text-sm">
          <p>{t(list ? 'requests.refreshFailed' : 'requests.loadFailed')}</p>
          <Button variant="ghost" data-testid="assistant-requests-retry" onClick={requests.refresh}>
            {t('retry')}
          </Button>
        </div>
      ) : null}
      {requests.submissions.length ? (
        <div className="space-y-2" data-testid="assistant-request-local-submissions">
          {requests.submissions.map(submission => (
            <LocalSubmission
              key={submission.clientId}
              submission={submission}
              disabled={
                !props.active ||
                requests.submissionBusy(submission.clientId) ||
                (!('message' in submission.action) &&
                  'requestId' in submission.action &&
                  requests.busy(submission.action.requestId))
              }
              onRetry={() => requests.retrySubmission(submission.clientId)}
            />
          ))}
        </div>
      ) : null}
      {list?.requests.map(request => (
        <AssistantRequestRow
          key={request.requestId}
          request={request}
          disabled={!props.active}
          busy={requests.busy(request.requestId)}
          enabled={list.enabled}
          onCompose={start}
          onAction={action => void requests.submit(action)}
          onMerge={(target, candidate) =>
            void requests.confirmMerge(request.requestId, target, candidate)
          }
          onExecution={props.onExecution}
        />
      ))}
      {composer ? (
        <form
          className="space-y-2"
          data-testid="assistant-request-composer"
          onSubmit={event => {
            event.preventDefault()
            requests.admit()
          }}
        >
          <label className="block text-sm" htmlFor={messageId}>
            {t(`requests.${composer.action}`)}
          </label>
          <textarea
            id={messageId}
            className="min-h-24 w-full rounded-md border border-border bg-transparent p-2 text-base"
            value={message}
            data-testid="assistant-request-message"
            disabled={!props.active}
            onChange={event => requests.setMessage(event.target.value)}
          />
          <div className="flex gap-2">
            <Button
              type="submit"
              size="sm"
              data-testid="assistant-request-send"
              disabled={
                !message.trim() ||
                !props.active ||
                (composer.action !== 'followup' && !list?.enabled)
              }
            >
              {t('requests.send')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="assistant-request-close-composer"
              onClick={requests.close}
            >
              {t('requests.closeComposer')}
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  )
}

function LocalSubmission(props: {
  submission: LocalRequestSubmission
  disabled: boolean
  onRetry(): void
}) {
  const { t } = useTranslation('collaborationExp')
  const { submission } = props
  const actionLabels = {
    cancel: 'requests.cancel',
    retry: 'retry',
    prepare_merge: 'requests.prepareMerge',
    confirm_merge: 'requests.confirmMerge',
  } as const
  return (
    <div
      className="space-y-1 text-sm"
      data-testid={`assistant-request-local-${submission.clientId}`}
    >
      <p>
        {'message' in submission.action
          ? submission.action.message
          : t(actionLabels[submission.action.action])}
      </p>
      <p className="text-xs text-text-secondary" role="status">
        {t(`requests.localStates.${submission.state}`)}
        {submission.requestId ? ` · ${t('requests.id', { id: submission.requestId })}` : null}
      </p>
      {submission.state === 'failed' || submission.state === 'preserved' ? (
        <>
          {submission.state === 'failed' ? <p role="alert">{t('requests.sendFailed')}</p> : null}
          <Button
            variant="ghost"
            size="sm"
            disabled={props.disabled}
            data-testid={`assistant-request-local-retry-${submission.clientId}`}
            onClick={props.onRetry}
          >
            {t('requests.retrySubmission')}
          </Button>
        </>
      ) : null}
    </div>
  )
}

function AssistantRequestRow(props: {
  request: AssistantExecutionRequest
  disabled: boolean
  busy: boolean
  enabled: boolean
  onCompose(value: RequestComposer): void
  onAction(value: AssistantRequestAction): void
  onMerge(targetRevision: string, candidateRevision: string): void
  onExecution(address: RuntimeTaskAddress): void
}) {
  const { t } = useTranslation('collaborationExp')
  const { request, disabled } = props
  const active = activeStates.has(request.state)
  const canContinue = active || ['completed', 'failed', 'cancelled'].includes(request.state)
  const canRetry = request.state === 'failed' || request.state === 'cancelled'
  return (
    <div className="space-y-1" data-testid={`assistant-request-${request.requestId}`}>
      <p className="truncate text-sm">{request.message}</p>
      <div className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
        <span>{t('requests.id', { id: request.requestId })}</span>
        <span data-testid={`assistant-request-status-${request.requestId}`}>
          {t(`requests.states.${request.state}`, { defaultValue: request.state })}
        </span>
        {request.queuePosition != null ? (
          <span>{t('requests.queuePosition', { position: request.queuePosition })}</span>
        ) : null}
        {request.reasonCode ? (
          <span>
            {t(`requests.reasons.${request.reasonCode}`, {
              defaultValue: t('requests.needsReview'),
            })}
          </span>
        ) : null}
      </div>
      {request.worktree ? (
        <AssistantRequestWorktree
          request={request}
          disabled={disabled || props.busy}
          onMerge={props.onMerge}
          onPrepare={() =>
            props.onAction({ action: 'prepare_merge', requestId: request.requestId })
          }
        />
      ) : null}
      <div className="flex flex-wrap gap-1">
        {request.deviceId && request.runtimeTaskId ? (
          <Button
            variant="ghost"
            size="sm"
            data-testid={`assistant-request-open-${request.requestId}`}
            onClick={() =>
              props.onExecution({ deviceId: request.deviceId, taskId: request.runtimeTaskId })
            }
          >
            <ArrowUpRight size={16} aria-hidden="true" />
            {t('requests.open')}
          </Button>
        ) : null}
        {canContinue ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled || request.state === 'cancelling'}
            data-testid={`assistant-request-continue-${request.requestId}`}
            onClick={() => props.onCompose({ action: 'followup', requestId: request.requestId })}
          >
            {t('requests.continue')}
          </Button>
        ) : null}
        {active ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled || props.busy || request.state === 'cancelling'}
            data-testid={`assistant-request-cancel-${request.requestId}`}
            onClick={() => props.onAction({ action: 'cancel', requestId: request.requestId })}
          >
            {t('requests.cancel')}
          </Button>
        ) : null}
        {props.enabled && request.state !== 'cancelling' ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled || request.state === 'cancelling'}
            data-testid={`assistant-request-replace-${request.requestId}`}
            onClick={() => props.onCompose({ action: 'replace', requestId: request.requestId })}
          >
            {t('requests.replace')}
          </Button>
        ) : null}
        {canRetry ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled || props.busy}
            data-testid={`assistant-request-retry-${request.requestId}`}
            onClick={() => props.onAction({ action: 'retry', requestId: request.requestId })}
          >
            {t('retry')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function AssistantRequestWorktree(props: {
  request: AssistantExecutionRequest
  disabled: boolean
  onMerge(targetRevision: string, candidateRevision: string): void
  onPrepare(): void
}) {
  const { t } = useTranslation('collaborationExp')
  const worktree = props.request.worktree!
  const merge = worktree.merge
  const commands = props.request.commands.filter(
    command => command.executionId === props.request.executionId
  )
  const alreadyApproved = commands.some(
    command =>
      command.action === 'merge' &&
      command.targetRevision === merge?.targetRevision &&
      command.candidateRevision === merge?.candidateRevision &&
      !command.reasonCode
  )
  const failedApproval = [...commands]
    .reverse()
    .find(
      command =>
        command.action === 'merge' &&
        command.acknowledged &&
        command.reasonCode &&
        command.targetRevision === merge?.targetRevision &&
        command.candidateRevision === merge?.candidateRevision
    )
  const preparing = commands.some(
    command => command.action === 'prepare_merge' && !command.acknowledged
  )
  const preparationFailed = [...commands]
    .reverse()
    .find(command => command.action === 'prepare_merge')?.reasonCode
  return (
    <details className="text-xs text-text-secondary">
      <summary
        className="max-md:min-h-11"
        data-testid={`assistant-request-worktree-${props.request.requestId}`}
      >
        {t('requests.worktree')}
      </summary>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt>{t('requests.branch')}</dt>
        <dd className="break-all">{worktree.branch}</dd>
        <dt>{t('requests.baseRevision')}</dt>
        <dd className="break-all">{worktree.baseRevision}</dd>
        <dt>{t('requests.worktreePath')}</dt>
        <dd className="break-all">{worktree.path}</dd>
        {merge ? (
          <>
            <dt>{t('requests.mergeState')}</dt>
            <dd>
              {t(`requests.mergeStates.${merge.state}`, {
                defaultValue: t('requests.needsReview'),
              })}
            </dd>
            <dt>{t('requests.targetRevision')}</dt>
            <dd className="break-all">{merge.targetRevision}</dd>
            {merge.observedTargetRevision ? (
              <>
                <dt>{t('requests.observedTargetRevision')}</dt>
                <dd className="break-all">{merge.observedTargetRevision}</dd>
              </>
            ) : null}
            {merge.candidateRevision ? (
              <>
                <dt>{t('requests.candidateRevision')}</dt>
                <dd className="break-all">{merge.candidateRevision}</dd>
              </>
            ) : null}
            {merge.conflictFiles.length ? (
              <>
                <dt>{t('requests.conflicts')}</dt>
                <dd className="whitespace-pre-wrap break-all">{merge.conflictFiles.join('\n')}</dd>
              </>
            ) : null}
          </>
        ) : null}
      </dl>
      {failedApproval ? (
        <p role="status" data-testid={`assistant-request-merge-error-${props.request.requestId}`}>
          {t('requests.mergeFailed')} <code className="break-all">{failedApproval.reasonCode}</code>
        </p>
      ) : null}
      {merge?.targetWorktreeDirty ? <p>{t('requests.targetWorktreeDirty')}</p> : null}
      {preparationFailed ? (
        <p role="status">
          {t('requests.mergeCheckFailed')} <code className="break-all">{preparationFailed}</code>
        </p>
      ) : null}
      {props.request.state === 'completed' ? (
        <Button
          size="sm"
          variant="ghost"
          data-testid={`assistant-request-prepare-merge-${props.request.requestId}`}
          disabled={props.disabled || preparing}
          onClick={props.onPrepare}
        >
          {t(preparing ? 'requests.preparingMerge' : 'requests.prepareMerge')}
        </Button>
      ) : null}
      {merge?.state === 'awaiting_confirmation' && merge.candidateRevision ? (
        <Button
          size="sm"
          variant="ghost"
          data-testid={`assistant-request-confirm-merge-${props.request.requestId}`}
          disabled={props.disabled || alreadyApproved}
          onClick={() => props.onMerge(merge.targetRevision, merge.candidateRevision!)}
        >
          {t(alreadyApproved ? 'requests.mergeApproved' : 'requests.confirmMerge')}
        </Button>
      ) : null}
    </details>
  )
}
