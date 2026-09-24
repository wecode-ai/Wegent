import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { ScrollableMessageArea } from '@/components/chat/ScrollableMessageArea'
import type { WorkbenchMessage } from '@/types/workbench'
import type { CollaborationIssue, WorkspaceProjectManagerRun } from '@wegent/collaboration'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import {
  getRuntimeConversationMessages,
  reconcileRuntimeConversationSnapshot,
  subscribeRuntimeConversation,
} from '@/features/workbench/runtimeConversationCache'
import { projectRuntimePaneTranscript } from '@/features/workbench/runtimeTaskLifecycle/projection'

const EMPTY_MESSAGES: WorkbenchMessage[] = []

interface Props {
  runs: WorkspaceProjectManagerRun[]
  issues: CollaborationIssue[]
  locale: 'zh-CN' | 'en'
  onOpenIssue(issue: CollaborationIssue): void
  onOpenTask?(run: WorkspaceProjectManagerRun): void
  services: WorkbenchServices
}

export function ProjectAiDesktopConversation({
  runs,
  issues,
  locale,
  onOpenIssue,
  services,
}: Props) {
  const activeRun = runs.at(-1)
  const runtimeDeviceId = activeRun?.runtimeDeviceId
  const runtimeTaskId = activeRun?.runtimeTaskId
  const address = useMemo(
    () =>
      runtimeDeviceId && runtimeTaskId
        ? { deviceId: runtimeDeviceId, taskId: runtimeTaskId }
        : null,
    [runtimeDeviceId, runtimeTaskId]
  )
  const subscribe = useCallback(
    (notify: () => void) =>
      address ? subscribeRuntimeConversation(address, notify) : () => undefined,
    [address]
  )
  const snapshot = useCallback(
    () => (address ? getRuntimeConversationMessages(address) : EMPTY_MESSAGES),
    [address]
  )
  const runtimeMessages = useSyncExternalStore(subscribe, snapshot, snapshot)
  useEffect(() => {
    if (!address) return
    let cancelled = false
    void services.runtimeWorkApi
      ?.getRuntimeTranscript(address)
      .then(transcript => {
        if (cancelled) return
        const projected = projectRuntimePaneTranscript(transcript)
        reconcileRuntimeConversationSnapshot(address, projected.turns)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [address, services.runtimeWorkApi])

  const fallbackMessages = useMemo(() => {
    const messages: WorkbenchMessage[] = []
    for (const run of runs) {
      if (run.instruction) {
        messages.push({
          id: `project-ai-user-${run.id}`,
          role: 'user',
          content: run.instruction,
          status: 'done',
          createdAt: run.createdAt ?? '',
        })
      }
      const responseId = `project-ai-assistant-${run.id}`
      const waiting = run.status === 'queued' || run.status === 'pending'
      messages.push({
        id: responseId,
        role: 'assistant',
        content:
          run.response ??
          (run.status === 'failed'
            ? `${locale === 'zh-CN' ? '运行失败' : 'Run failed'}: ${run.error ?? ''}`
            : run.status === 'cancelled'
              ? locale === 'zh-CN'
                ? '任务已取消'
                : 'Task cancelled'
              : waiting
                ? locale === 'zh-CN'
                  ? '等待执行器启动…'
                  : 'Waiting for executor…'
                : ''),
        status:
          run.status === 'failed' ? 'failed' : run.status === 'running' ? 'streaming' : 'done',
        createdAt: run.createdAt ?? '',
      })
    }
    return messages
  }, [runs, locale])
  const visibleRuntimeMessages = useMemo(() => {
    const instruction = activeRun?.instruction?.trim()
    if (!instruction) return runtimeMessages
    const firstUserIndex = runtimeMessages.findIndex(message => message.role === 'user')
    if (firstUserIndex < 0 || runtimeMessages[firstUserIndex]?.content.trim() === instruction) {
      return runtimeMessages
    }
    return runtimeMessages.map((message, index) =>
      index === firstUserIndex ? { ...message, content: instruction } : message
    )
  }, [activeRun?.instruction, runtimeMessages])
  const messages = visibleRuntimeMessages.length > 0 ? visibleRuntimeMessages : fallbackMessages
  const isWaitingForAssistant =
    messages.some(message => message.status === 'streaming') ||
    messages.at(-1)?.role === 'user' ||
    runs.some(run => run.status === 'running')

  return (
    <ScrollableMessageArea
      messages={messages}
      conversationKey={`project-ai-${activeRun?.id ?? 'new'}`}
      isWaitingForAssistant={isWaitingForAssistant}
      initialScrollPosition="latest"
      scrollTestId="project-ai-conversation-history"
      className="!flex-none"
      scrollerClassName="!h-auto max-h-64 overflow-x-hidden"
      virtualize={false}
      renderGapAfterMessage={message => {
        if (message.role !== 'assistant') return null
        const mentioned = [...new Set(message.content.match(/#[0-9]+/g) ?? [])]
          .map(reference => issues.find(issue => `#${issue.sequence_number}` === reference))
          .filter((issue): issue is CollaborationIssue => Boolean(issue))
        const actions =
          activeRun?.actions
            ?.map(action => issues.find(issue => issue.id === action.itemId))
            .filter((issue): issue is CollaborationIssue => Boolean(issue)) ?? []
        const linked = [
          ...new Map([...mentioned, ...actions].map(issue => [issue.id, issue])).values(),
        ]
        if (!linked.length) return null
        return (
          <div className="flex flex-wrap gap-2 px-6 pb-3">
            {linked.map(issue => (
              <button
                key={issue.id}
                type="button"
                data-testid={`project-ai-response-issue-${issue.id}`}
                className="rounded-lg border border-border px-2.5 py-1 text-xs text-text-secondary hover:bg-muted hover:text-text-primary"
                onClick={() => onOpenIssue(issue)}
              >
                #{issue.sequence_number} {issue.title}
              </button>
            ))}
          </div>
        )
      }}
    />
  )
}
