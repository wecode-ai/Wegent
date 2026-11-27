import { LOCAL_USER } from '@/api/local/localSession'
import { CloudConnectionContext } from '@/features/cloud-connection/CloudConnectionContext'
import { useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import { IssueCommentChildAction } from '@wegent/collaboration'
import { useContext } from 'react'
import { IssueAssignmentReceiptStatus } from './IssueAssignmentReceipts'
import { IssueHumanRequests } from './IssueHumanRequests'
import { IssueManagerEvent } from './IssueManagerEvent'
import { IssueReplyContext } from './IssueReplyContext'
import { issueReplyCopy } from './issueReplyCopy'
import { IssueTimelineActions } from './IssueTimelineActions'
import { boundCardSessionAddress } from './taskActivityHelpers'

import { issueActivityRole } from './issueActivityRole'

import {
  IssueActivityFeed,
  IssueActivityThread,
  IssueActivityTimelineRows,
} from '@wegent/collaboration'

import { IssueActivityTools } from '@wegent/collaboration/issue-detail/IssueActivityTools'

import { copyTextToClipboard } from '@/lib/clipboard'

import type { ProjectChatMessage } from '@/api/backend/projectChatSocket'

import { cn } from '@/lib/utils'

import { ChatInput } from '@/components/chat/ChatInput'
import { ConversationQueuePanel } from '@/components/chat/ConversationQueuePanel'
import { DESKTOP_MESSAGE_LIST_CLASS } from '@/components/layout/desktopChatLayout'

import { CardCommentComposer } from './CardCommentComposer'
import { RuntimeTaskExecutionOverlay } from './RuntimeTaskExecutionOverlay'
import { TaskCommentComposer } from './TaskCommentComposer'

import { IssueChangeRequestBadges } from '@/features/change-requests/IssueChangeRequestBadges'
import { ChatMessage } from './TaskActivityMessage'
import { resolveMessageRunStatus } from './taskActivityMessageUtils'
import { memberNameById } from './todoShared'

import type { TaskActivityViewProps } from './taskActivityTypes'
import { useTaskActivityController } from './useTaskActivityController'
export type { StartHumanTaskFromReplyInput } from './taskActivityTypes'
function TaskActivityContent(props: TaskActivityViewProps) {
  const {
    acceptTask,
    activeUserId,
    activity,
    activityEntries,
    activityScope,
    activityTranslate,
    approveTaskRun,
    assignedAgent,
    beginReply,
    canApproveCurrentRun,
    cancellation,
    cancellingMessageId,
    cardReplyLabel,
    chatCurrentUserId,
    client,
    commentActions,
    commentAssignment,
    commentProjectChat,
    commentProjectWork,
    compact,
    currentReceipts,
    currentUserId,
    deviceNameForMessage,
    error,
    executionBinding,
    executionDetail,
    flashedCommentId,
    humanDispatchForCard,
    issueTimeline,
    latestAssignment,
    linear,
    listRef,
    loading,
    localProjects,
    members,
    mentionCandidates,
    messageRuntimeAddress,
    newCommentDraft,
    notificationComposer,
    onOpenRuntimeTask,
    onOpenTask,
    onStartHumanTaskFromReply,
    project,
    projectDeliveryApi,
    projectLocation,
    projectMembers,
    rail,
    readError,
    rejectTaskRun,
    requestDialogs,
    replyComposerRef,
    replyContextKind,
    replyHumanDispatch,
    replyQueue,
    replySessionAddress,
    replyTarget,
    rerunTaskAi,
    sendCardReply,
    sendNewComment,
    sending,
    services,
    setExecutionDetail,
    setExpandedActivityScope,
    setNewCommentDraft,
    setReplyTarget,
    stopRuntimeTask,
    submitTimelineComment,
    t,
    task,
    taskBindings,
    taskSummaryForMessage,
    threadMessages,
    visibleActivity,
  } = useTaskActivityController(props)
  const renderCommentChildAction = (message: ProjectChatMessage) =>
    issueTimeline && commentAssignment?.createChild && client && message.content.trim() ? (
      <IssueCommentChildAction
        body={message.content}
        messageId={message.messageId}
        assignment={commentAssignment}
        translate={activityTranslate}
        onComment={async (text, requestId) => {
          const notice = await client.send({
            projectId: project.id,
            taskId: task.id,
            clientMessageId: requestId,
            text,
            replyToMessageId: message.messageId,
            model: null,
            mentions: [],
          })
          activity.receiveMessages([notice])
        }}
      />
    ) : null
  const renderActivityMessage = (
    message: ProjectChatMessage,
    { eventOnly = false, isRoot = false }: { eventOnly?: boolean; isRoot?: boolean } = {}
  ) => {
    const role = issueActivityRole(message)
    const agentRole = role
    const address = messageRuntimeAddress(message)
    const binding = address
      ? taskBindings.find(
          item => item.device_id === address.deviceId && item.task_id === address.taskId
        )
      : undefined
    return (
      <div key={message.messageId}>
        <ChatMessage
          key={message.messageId}
          message={message}
          members={members}
          executionTurnId={executionBinding.getTurnId(message)}
          flash={message.messageId === flashedCommentId}
          mine={
            message.sender.type === 'user' &&
            String(message.sender.id) === String(chatCurrentUserId ?? currentUserId ?? '')
          }
          compact
          plain
          showInlineExecutionStatus={issueTimeline}
          agentRole={agentRole}
          allowBackendExecutionFallback={!issueTimeline}
          eventOnly={eventOnly}
          taskAiState={task.ai_state}
          executionDeviceName={deviceNameForMessage(message)}
          taskSummary={taskSummaryForMessage(message)}
          onOpenExecution={
            address && onOpenRuntimeTask
              ? () => onOpenRuntimeTask(address)
              : issueTimeline
                ? binding && onOpenTask
                  ? () => onOpenTask(binding)
                  : undefined
                : address
                  ? () =>
                      setExecutionDetail({
                        address,
                        messageId: message.messageId,
                        senderName: message.sender.name,
                        runId:
                          typeof message.metadata.run_id === 'string'
                            ? message.metadata.run_id
                            : null,
                        modelName:
                          typeof message.metadata.model === 'string'
                            ? message.metadata.model
                            : null,
                        runStatus: resolveMessageRunStatus(task.ai_state, message),
                      })
                  : undefined
          }
          onStopExecution={address ? () => void stopRuntimeTask(message) : undefined}
          stopping={cancellingMessageId === message.messageId}
        />
        {!eventOnly && !isRoot && renderCommentChildAction(message)}
      </div>
    )
  }
  return (
    <>
      <IssueChangeRequestBadges api={services.deviceApi} badges={task.badges ?? []} />
      <IssueHumanRequests
        key={`${projectLocation}:${project.id}:${task.id}`}
        services={services}
        projectId={String(project.id)}
        issueId={task.id}
        store={projectLocation === 'local' ? 'local' : 'backend'}
        userId={activeUserId ?? undefined}
        members={members}
      />
      {requestDialogs}
      <IssueActivityFeed
        mode={linear ? 'linear' : rail ? 'rail' : 'document'}
        testId={`cloud-task-activity-${task.id}`}
        listTestId="cloud-task-activity-list"
        listRef={listRef}
        translate={activityTranslate}
        count={issueTimeline ? activityEntries.length : threadMessages.length}
        loading={loading}
        error={cancellation.error ?? readError}
        emptyDescription={
          assignedAgent
            ? activityTranslate('activity.task_activity_empty_with_ai', undefined, {
                name: assignedAgent.name,
              })
            : activityTranslate('activity.task_activity_empty_without_ai')
        }
        tools={
          <div className="flex items-center gap-2">
            <IssueActivityTools
              task={task}
              assignedAgent={assignedAgent}
              canApprove={canApproveCurrentRun}
              running={sending}
              translate={activityTranslate}
              copyText={copyTextToClipboard}
              onApprove={projectDeliveryApi ? () => void approveTaskRun() : undefined}
              onReject={projectDeliveryApi ? () => void rejectTaskRun() : undefined}
              onAccept={projectDeliveryApi ? () => void acceptTask() : undefined}
              onRun={client ? () => void rerunTaskAi() : undefined}
            />
          </div>
        }
        composer={
          issueTimeline && (linear || client?.executeTaskComment) ? (
            <div
              ref={replyComposerRef}
              {...(replyTarget
                ? {
                    id: 'issue-reply-composer',
                    'data-testid': 'issue-reply-composer',
                  }
                : {})}
            >
              {replyTarget ? (
                <IssueReplyContext
                  kind={replyContextKind}
                  name={replyTarget.root.sender.name}
                  content={replyTarget.root.content}
                  taskTitle={replyHumanDispatch?.taskTitle}
                  onCancel={() => setReplyTarget(null)}
                />
              ) : null}
              <TaskCommentComposer
                issueActions={!replyTarget ? commentActions : undefined}
                assignment={!replyTarget ? commentAssignment : undefined}
                predictionAddress={replySessionAddress}
                key={task.id}
                value={notificationComposer?.draft ?? newCommentDraft}
                onChange={value => {
                  setNewCommentDraft(value)
                  notificationComposer?.setDraft(value)
                }}
                onSubmit={submitTimelineComment}
                disabled={!client || notificationComposer?.disabled === true}
                sending={sending || notificationComposer?.busy === true}
                error={
                  notificationComposer?.error ??
                  error ??
                  (!client ? t('workbench.project_chat_cloud_required') : null)
                }
                mentionCandidates={mentionCandidates}
                translate={activityTranslate}
                controls={commentProjectChat}
                projectWork={commentProjectWork}
                serverExecution={Boolean(client?.executeTaskComment)}
                placeholder={
                  replyTarget ? t(issueReplyCopy[replyContextKind].placeholder) : undefined
                }
              />
            </div>
          ) : (
            <>
              {linear || client?.executeTaskComment ? (
                <TaskCommentComposer
                  issueActions={commentActions}
                  assignment={commentAssignment}
                  key={task.id}
                  value={newCommentDraft}
                  onChange={setNewCommentDraft}
                  onSubmit={sendNewComment}
                  disabled={!client}
                  sending={sending}
                  error={error ?? (!client ? t('workbench.project_chat_cloud_required') : null)}
                  mentionCandidates={mentionCandidates}
                  translate={activityTranslate}
                  controls={commentProjectChat}
                  projectWork={commentProjectWork}
                  serverExecution={Boolean(client?.executeTaskComment)}
                />
              ) : (
                <div className="task-detail-comment-chat-input">
                  <ChatInput
                    predictionAddress={null}
                    value={newCommentDraft}
                    disabled={!client}
                    onChange={setNewCommentDraft}
                    onSubmit={() => void sendNewComment(newCommentDraft.trim(), [])}
                    submitDisabled={!newCommentDraft.trim() || sending}
                    error={error ?? (!client ? t('workbench.project_chat_cloud_required') : null)}
                    placeholder={
                      assignedAgent
                        ? t('workbench.task_activity_ai_placeholder', { name: assignedAgent.name })
                        : t('workbench.task_activity_placeholder')
                    }
                    variant="desktop"
                    projectChat={commentProjectChat}
                    projectWork={commentProjectWork}
                    showProjectWorkBar={localProjects.length > 0}
                    inputTestId="cloud-task-activity-composer"
                  />
                </div>
              )}
            </>
          )
        }
      >
        {linear ? (
          <IssueActivityTimelineRows
            rows={visibleActivity}
            creator={
              task.created_by_user_name ||
              memberNameById(projectMembers, task.created_by_user_id) ||
              t('todo.status_history_system')
            }
            memberName={userId => memberNameById(projectMembers, userId)}
            translate={activityTranslate}
            expandLabel={count => t('personalHome.expandActivity', { count })}
            onExpand={() => setExpandedActivityScope(activityScope)}
            renderAssignmentDetails={activity =>
              activity === latestAssignment &&
              activity.entry.action !== 'unassign' &&
              activity.entry.to_type === 'user' &&
              currentReceipts?.assigneeUserId != null &&
              activity.entry.to_id === String(currentReceipts.assigneeUserId) ? (
                <span
                  data-testid="issue-assignment-activity-receipts"
                  className="inline-flex items-center gap-1 text-xs text-text-muted"
                  aria-live="polite"
                >
                  <IssueAssignmentReceiptStatus
                    {...currentReceipts}
                    currentUserId={activeUserId ?? undefined}
                  />
                </span>
              ) : null
            }
            renderComment={card => {
              const rootId = card.root.messageId
              const role = issueActivityRole(card.root)
              if (
                issueTimeline &&
                role === 'manager' &&
                card.root.metadata.activity_type !== 'manager_status_comment'
              ) {
                const address = messageRuntimeAddress(card.root)
                const binding = address
                  ? taskBindings.find(
                      item => item.device_id === address.deviceId && item.task_id === address.taskId
                    )
                  : undefined
                const canReply = humanDispatchForCard(card) && onStartHumanTaskFromReply
                return (
                  <div key={rootId} data-testid={`cloud-task-activity-card-${rootId}`}>
                    <div data-activity-sequence={card.root.sequenceNumber}>
                      <IssueManagerEvent
                        message={card.root}
                        task={task}
                        onOpenExecution={
                          address && onOpenRuntimeTask
                            ? () => onOpenRuntimeTask(address)
                            : binding && onOpenTask
                              ? () => onOpenTask(binding)
                              : undefined
                        }
                      />
                    </div>
                    <div data-testid={`cloud-task-activity-replies-${rootId}`}>
                      {card.replies.map(reply => renderActivityMessage(reply))}
                    </div>
                    <IssueTimelineActions
                      rootId={rootId}
                      replyLabel={cardReplyLabel(card)}
                      active={replyTarget?.root.messageId === rootId}
                      onReply={canReply ? () => beginReply(card) : undefined}
                    >
                      {renderCommentChildAction(card.root)}
                    </IssueTimelineActions>
                  </div>
                )
              }
              const executions = [card.root, ...card.replies].filter(
                message => message.sender.type === 'agent'
              )
              return (
                <IssueActivityThread
                  key={rootId}
                  thread={card}
                  renderMessage={(message, isRoot) => renderActivityMessage(message, { isRoot })}
                  variant={issueTimeline ? 'timeline' : 'card'}
                  composer={
                    <>
                      <div data-testid={`cloud-task-activity-card-queue-${rootId}`}>
                        <ConversationQueuePanel
                          queuedMessages={replyQueue.messages(rootId)}
                          guidanceMessages={[]}
                          onCancelQueuedMessage={id => replyQueue.cancel(rootId, id)}
                        />
                      </div>
                      {issueTimeline ? (
                        <IssueTimelineActions
                          rootId={rootId}
                          replyLabel={cardReplyLabel(card)}
                          active={replyTarget?.root.messageId === rootId}
                          onReply={() => beginReply(card)}
                        >
                          {renderCommentChildAction(card.root)}
                        </IssueTimelineActions>
                      ) : (
                        <CardCommentComposer
                          predictionAddress={boundCardSessionAddress(card, taskBindings)}
                          rootId={rootId}
                          projectId={project.id}
                          disabled={!client}
                          placeholder={t(
                            issueReplyCopy[
                              boundCardSessionAddress(card, taskBindings)
                                ? 'execution'
                                : 'discussion'
                            ].placeholder
                          )}
                          aiError={replyQueue.error(rootId)}
                          mentionCandidates={mentionCandidates}
                          translate={activityTranslate}
                          onSend={(text, mentions, attachments) =>
                            sendCardReply(card, text, mentions, attachments)
                          }
                        />
                      )}
                    </>
                  }
                  events={
                    !issueTimeline && executions.length
                      ? executions.map(message =>
                          renderActivityMessage(message, { eventOnly: true })
                        )
                      : null
                  }
                  eventLabel={t('workbench.task_activity_execution_count', {
                    count: executions.length,
                  })}
                  eventTestId={`task-activity-events-toggle-${rootId}`}
                />
              )
            }}
          />
        ) : (
          <div
            className={
              rail
                ? 'flex flex-col divide-y divide-border/70 pb-4'
                : cn(DESKTOP_MESSAGE_LIST_CLASS, 'flex flex-col gap-4 pb-4 pt-5')
            }
          >
            {threadMessages.map(message => {
              const runtimeAddress = messageRuntimeAddress(message)
              return (
                <ChatMessage
                  key={message.messageId}
                  message={message}
                  members={members}
                  executionTurnId={executionBinding.getTurnId(message)}
                  flash={message.messageId === flashedCommentId}
                  mine={
                    message.sender.type === 'user' &&
                    String(message.sender.id) === String(chatCurrentUserId ?? currentUserId ?? '')
                  }
                  compact={compact}
                  taskAiState={task.ai_state}
                  executionDeviceName={deviceNameForMessage(message)}
                  taskSummary={taskSummaryForMessage(message)}
                  onOpenExecution={
                    runtimeAddress
                      ? () => {
                          if (onOpenRuntimeTask) {
                            onOpenRuntimeTask(runtimeAddress)
                            return
                          }
                          setExecutionDetail({
                            address: runtimeAddress,
                            messageId: message.messageId,
                            senderName: message.sender.name,
                            runId:
                              typeof message.metadata.run_id === 'string'
                                ? message.metadata.run_id
                                : null,
                            modelName:
                              typeof message.metadata.model === 'string'
                                ? message.metadata.model
                                : null,
                            runStatus: resolveMessageRunStatus(task.ai_state, message),
                          })
                        }
                      : undefined
                  }
                  onStopExecution={runtimeAddress ? () => void stopRuntimeTask(message) : undefined}
                  stopping={cancellingMessageId === message.messageId}
                />
              )
            })}
          </div>
        )}
      </IssueActivityFeed>
      {executionDetail ? (
        <RuntimeTaskExecutionOverlay
          key={JSON.stringify([
            executionDetail.address.deviceId,
            executionDetail.address.taskId,
            executionDetail.messageId,
          ])}
          address={
            projectLocation === 'local'
              ? executionDetail.address
              : {
                  ...executionDetail.address,
                  projectSession: { projectId: String(project.id), issueId: task.id },
                }
          }
          {...executionBinding.overlay}
          senderName={executionDetail.senderName}
          runId={executionDetail.runId}
          modelName={executionDetail.modelName}
          runStatus={
            executionBinding.overlay.activityMessage
              ? resolveMessageRunStatus(task.ai_state, executionBinding.overlay.activityMessage)
              : executionDetail.runStatus
          }
          onClose={() => setExecutionDetail(null)}
        />
      ) : null}
    </>
  )
}

export function TaskActivityView(props: TaskActivityViewProps) {
  const cloud = useContext(CloudConnectionContext)
  const { state, workspaceTabId } = useWorkbenchPaneContext()
  const scope = JSON.stringify([
    workspaceTabId,
    cloud?.apiBaseUrl ?? '',
    cloud?.user?.id ?? null,
    state.user?.id ?? props.currentUserId ?? LOCAL_USER.id,
    props.currentUserId,
    props.project.project_store,
    props.project.id,
    props.task.id,
    props.project.access_role,
    props.project.workspace_access_role,
  ])
  return <TaskActivityContent key={scope} {...props} />
}
